/**
 * dsh-hippocampus memory maintenance: rule-based cleanup plus an audit trail.
 *
 * Rule layer (cheap, runs opportunistically): auto-extracted records
 * (`source: session`) that were never recalled for STALE_DAYS are removed.
 * User-explicit records (`source: explicit`) are NEVER touched automatically.
 *
 * LLM layer (manual button / future daily): asks the routed model to review
 * auto-extracted records and delete duplicates, stale facts, and trivia.
 * User-explicit records are never candidates.
 *
 * Every removal appends one line to the audit log (user-layer root, shared
 * across workspaces), so the user can verify what was cleaned and why.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { MemoryRecord, MemoryScope } from './types.ts'
import type { MemoryStore } from './store.ts'

/** Auto-extracted records untouched for this many days are removed. */
export const STALE_DAYS = 30

/** Milliseconds in one day. */
const DAY_MS = 24 * 60 * 60 * 1000

/** Maximum audit entries kept on disk; older lines are trimmed away. */
export const AUDIT_MAX_ENTRIES = 50

/** The audit log path (user-layer root so it follows the host, not a project). */
export function auditLogPath(memoryRoot?: string): string {
  const root = resolve(memoryRoot ?? join(homedir(), '.dsh', 'hippocampus'))
  return join(root, 'audit.log')
}

/** One audit entry, JSON-lines appended to the audit log. */
export interface AuditEntry {
  /** Unix epoch ms when the maintenance ran. */
  readonly time: number
  /** Which layer removed the records. */
  readonly layer: 'rules' | 'llm' | 'manual'
  /** Why these records were removed. */
  readonly reason: string
  /** Removed records: enough to restore them (id, scope, workspace, text). */
  readonly removed: readonly AuditRemovedRecord[]
}

/** One removed record as recorded for auditing and restoration. */
export interface AuditRemovedRecord {
  readonly id: string
  readonly scope: MemoryScope
  /** Workspace path for project-layer records (user-layer records omit it). */
  readonly workspace?: string
  readonly text: string
  readonly tags?: readonly string[]
}

/** Record one manual deletion in the audit trail (settings delete / forget). */
export async function auditManualDelete(
  record: MemoryRecord,
  workspace: string | undefined,
  memoryRoot?: string,
): Promise<void> {
  await appendAudit({
    time: Date.now(),
    layer: 'manual',
    reason: 'user requested deletion',
    removed: [{
      id: record.id,
      scope: record.scope,
      ...workspace === undefined ? {} : { workspace },
      text: record.text.slice(0, 120),
      ...record.tags.length === 0 ? {} : { tags: [...record.tags] },
    }],
  }, memoryRoot)
}

/** Append one audit entry (best-effort; never throws). Trims the log to the
 * newest {@link AUDIT_MAX_ENTRIES} lines so it cannot grow without bound. */
export async function appendAudit(entry: AuditEntry, memoryRoot?: string): Promise<void> {
  try {
    const path = auditLogPath(memoryRoot)
    await mkdir(resolve(path, '..'), { recursive: true })
    await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8')
    await trimAudit(path)
  } catch {
    // Auditing is best-effort: a storage failure never breaks maintenance.
  }
}

/** Keep only the newest {@link AUDIT_MAX_ENTRIES} lines of the audit log. */
async function trimAudit(path: string): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises')
  try {
    const raw = await readFile(path, 'utf8')
    const lines = raw.split('\n').filter(line => line.trim() !== '')
    if (lines.length <= AUDIT_MAX_ENTRIES) return
    await writeFile(path, `${lines.slice(-AUDIT_MAX_ENTRIES).join('\n')}\n`, 'utf8')
  } catch {
    // Trimming is best-effort.
  }
}

/** Read every audit entry, oldest first. */
export async function readAudit(memoryRoot?: string): Promise<AuditEntry[]> {
  const { readFile } = await import('node:fs/promises')
  try {
    const raw = await readFile(auditLogPath(memoryRoot), 'utf8')
    const entries: AuditEntry[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line) as AuditEntry
        if (typeof parsed.time === 'number' && Array.isArray(parsed.removed)) {
          entries.push(parsed)
        }
      } catch {
        // Skip malformed lines.
      }
    }
    return entries
  } catch {
    return []
  }
}

/**
 * Remove one restored record id from every audit entry. An entry whose
 * removed list becomes empty is dropped entirely. Best-effort.
 */
export async function removeAuditRecord(id: string, memoryRoot?: string): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises')
  try {
    const path = auditLogPath(memoryRoot)
    const raw = await readFile(path, 'utf8')
    const kept: string[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const entry = JSON.parse(line) as AuditEntry
        if (!Array.isArray(entry.removed)) {
          kept.push(line)
          continue
        }
        const remaining = entry.removed.filter(item => item.id !== id)
        if (remaining.length === 0) continue // Drop the whole entry.
        kept.push(JSON.stringify({ ...entry, removed: remaining }))
      } catch {
        kept.push(line)
      }
    }
    await writeFile(path, `${kept.join('\n')}\n`, 'utf8')
  } catch {
    // Best-effort.
  }
}

/** Whether a record is auto-extracted (safe to maintain automatically). */
export function isAutoExtracted(record: MemoryRecord): boolean {
  return record.source.kind === 'session' || record.source.kind === 'auto'
}

/**
 * Restore one deleted record from an audit entry. Creates a fresh record in
 * the same scope (and workspace, for project-layer records) with the audited
 * text and tags, keeping the original id so the audit trail stays accurate.
 * A record that already exists is left untouched.
 *
 * A project-scope record WITHOUT a workspace path cannot be restored — its
 * original home is unknown — and returns undefined.
 * @returns the restored record id, or undefined when restoration failed.
 */
export async function restoreFromAudit(
  item: AuditRemovedRecord,
  store: MemoryStore,
): Promise<string | undefined> {
  const workspace = item.workspace
  if (item.scope === 'project' && workspace === undefined) return undefined
  // Skip if a record with this id already exists in the target scope.
  const existing = workspace !== undefined
    ? await store.list('project', workspace)
    : await store.list('user', undefined)
  if (existing.some(record => record.id === item.id)) return undefined
  try {
    await store.createWithId(item.id, item.scope, {
      text: item.text,
      ...item.tags === undefined || item.tags.length === 0 ? {} : { tags: item.tags },
    }, workspace)
    return item.id
  } catch {
    return undefined
  }
}

/**
 * Rule-layer sweep over one scope's records: remove auto-extracted records
 * that were never recalled within STALE_DAYS. User-explicit records are
 * never touched. Returns the removed records (for auditing).
 */
export async function sweepStale(
  store: MemoryStore,
  scope: MemoryScope,
  workspace: string | undefined,
  now = Date.now(),
): Promise<MemoryRecord[]> {
  const records = await store.list(scope, workspace)
  const removed: MemoryRecord[] = []
  const cutoff = now - STALE_DAYS * DAY_MS
  for (const record of records) {
    if (!isAutoExtracted(record)) continue
    if (record.accessCount > 0) continue
    if (record.createdAt > cutoff) continue
    const deleted = await store.delete(record.id, workspace)
    if (deleted) removed.push(record)
  }
  return removed
}

/**
 * Run the rule-layer sweep across the user layer and every workspace's
 * project layer. Appends one audit entry when anything was removed.
 * @returns the total number of removed records.
 */
export async function runRuleSweep(
  store: MemoryStore,
  workspaces: readonly { readonly path: string }[],
  memoryRoot?: string,
  now = Date.now(),
): Promise<number> {
  const removed: Array<{ id: string; scope: MemoryScope; workspace?: string; text: string }> = []
  // User layer (host-global).
  for (const record of await sweepStale(store, 'user', undefined, now)) {
    removed.push({ id: record.id, scope: record.scope, text: record.text.slice(0, 120) })
  }
  // Each workspace's project layer.
  for (const workspace of workspaces) {
    for (const record of await sweepStale(store, 'project', workspace.path, now)) {
      removed.push({
        id: record.id,
        scope: record.scope,
        workspace: workspace.path,
        text: record.text.slice(0, 120),
      })
    }
  }
  if (removed.length > 0) {
    await appendAudit({
      time: now,
      layer: 'rules',
      reason: `auto-extracted records never recalled within ${STALE_DAYS} days`,
      removed,
    }, memoryRoot)
  }
  return removed.length
}

/** One auto-extracted record offered to the LLM review, with its location. */
interface ReviewCandidate {
  readonly record: MemoryRecord
  readonly workspace: string | undefined
}

/** Collect every auto-extracted record (user + project layers). */
async function collectAutoExtracted(
  store: MemoryStore,
  workspaces: readonly { readonly path: string }[],
): Promise<ReviewCandidate[]> {
  const candidates: ReviewCandidate[] = []
  for (const record of await store.list('user', undefined)) {
    if (isAutoExtracted(record)) candidates.push({ record, workspace: undefined })
  }
  for (const workspace of workspaces) {
    for (const record of await store.list('project', workspace.path)) {
      if (isAutoExtracted(record)) candidates.push({ record, workspace: workspace.path })
    }
  }
  return candidates
}

/** Parse the model's JSON verdict: an array of record ids to delete. */
export function parseReviewVerdict(text: string): string[] {
  // Strip a ```json ... ``` fence if present, then find the array.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced?.[1] ?? text
  const match = /\[[\s\S]*\]/.exec(body)
  if (match === null) return []
  try {
    const parsed = JSON.parse(match[0]) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
  } catch {
    return []
  }
}

/** The review directive given to the model. */
const REVIEW_INSTRUCTION = [
  'You are a memory curator for an AI coding assistant. Below are AUTO-EXTRACTED memory records (id: text) — they were extracted automatically from past conversations, so deleting them is safe and expected when they are not worth keeping.',
  '',
  'DELETE records matching ANY of these categories:',
  '- Transient/one-off: "the build showed 3 warnings", "pressed Ctrl+S at 14:32", "checked node version with node -v" — task state, timestamps, one-time events',
  '- Resolved/obsolete: a fix or decision that is already implemented, a superseded plan',
  '- Trivial/vague: fragments that carry no durable meaning on their own',
  '- Duplicates: the same fact restated; keep the most complete version, delete the rest',
  '',
  'KEEP records that capture durable facts: user preferences, project decisions, conventions, architecture, stable identifiers, API/commands worth remembering.',
  '',
  'Respond with ONLY a JSON array of ids to DELETE, e.g. ["id-1","id-2"]. Respond [] when nothing qualifies.',
  '',
].join('\n')

/**
 * LLM review layer: ask the routed model which auto-extracted records are
 * duplicates/stale/trivial, delete them, and append an audit entry.
 * @returns the deleted records (id, scope, text) for auditing.
 */
export async function runLlmReview(
  ctx: Context,
  store: MemoryStore,
  workspaces: readonly { readonly path: string }[],
  memoryRoot?: string,
  signal?: AbortSignal,
): Promise<Array<{ id: string; scope: MemoryScope; workspace?: string; text: string }>> {
  const candidates = await collectAutoExtracted(store, workspaces)
  if (candidates.length === 0) return []

  // Route through the default model selection (same as webhook sessions).
  const apiCtx = ctx as unknown as {
    agentDefaultModel: { currentSelection(): { provider: string; model: string } }
    llm: { stream(options: GenerateOptions): AsyncIterable<unknown> }
  }
  const selection = apiCtx.agentDefaultModel?.currentSelection()
  if (selection === undefined || selection.provider.length === 0 || selection.model.length === 0) {
    return []
  }
  const llm = apiCtx.llm
  if (llm === undefined) return []

  const listing = candidates
    .map(candidate => `${candidate.record.id}: ${candidate.record.text}`)
    .join('\n')
  const messages: Message[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: `${REVIEW_INSTRUCTION}\n\n${listing}` }],
      source: { kind: 'plugin', plugin: 'dsh-hippocampus' },
    } as Message,
  ]
  const options: GenerateOptions = {
    provider: selection.provider,
    model: selection.model,
    messages,
    maxTokens: 2048,
    ...signal === undefined ? {} : { signal },
  }
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, 30_000)
  const fused = signal !== undefined ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let text = ''
  try {
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream({ ...options, signal: fused })) {
      assembler.push(chunk as never)
    }
    text = assembler.blocks()
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }

  const deleteIds = new Set(parseReviewVerdict(text))
  if (deleteIds.size === 0) return []

  const removed: Array<{ id: string; scope: MemoryScope; workspace?: string; text: string }> = []
  for (const candidate of candidates) {
    if (!deleteIds.has(candidate.record.id)) continue
    const deleted = await store.delete(candidate.record.id, candidate.workspace)
    if (deleted) {
      removed.push({
        id: candidate.record.id,
        scope: candidate.record.scope,
        ...candidate.workspace === undefined ? {} : { workspace: candidate.workspace },
        text: candidate.record.text.slice(0, 120),
      })
    }
  }
  if (removed.length > 0) {
    await appendAudit({
      time: Date.now(),
      layer: 'llm',
      reason: 'model review: duplicates, transient, or trivial auto-extracted records',
      removed,
    }, memoryRoot)
  }
  return removed
}
