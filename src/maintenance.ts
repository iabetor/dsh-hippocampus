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

/** Read every audit entry, newest first (most recent cleanup on top). */
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
    return entries.reverse()
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

/** One merge proposal: several records consolidated into one fuller record. */
export interface MergeProposal {
  /** Ids of the records to fold together. */
  readonly ids: readonly string[]
  /** The merged, fuller text that replaces them. */
  readonly text: string
  /** Optional tags for the merged record. */
  readonly tags?: readonly string[]
}

/** The model's full review plan: records to delete, groups to merge. */
export interface ReviewPlan {
  /** Ids to delete outright (transient / obsolete / trivial). */
  readonly delete: readonly string[]
  /** Groups of records to merge into a single fuller record. */
  readonly merge: readonly MergeProposal[]
}

/** Parse the model's review plan JSON (`{delete:[], merge:[...]}`). */
export function parseReviewPlan(text: string): ReviewPlan {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced?.[1] ?? text
  const match = /\{[\s\S]*\}/.exec(body)
  if (match === null) return { delete: [], merge: [] }
  try {
    const parsed = JSON.parse(match[0]) as {
      delete?: unknown
      merge?: unknown
    }
    const del = Array.isArray(parsed.delete)
      ? parsed.delete.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
    let merge: MergeProposal[] = []
    if (Array.isArray(parsed.merge)) {
      merge = parsed.merge
        .filter((item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object' && !Array.isArray(item))
        .map(item => {
          const ids = Array.isArray(item.ids)
            ? item.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
            : []
          const text = typeof item.text === 'string' ? item.text.trim() : ''
          const tags = Array.isArray(item.tags)
            ? item.tags.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)
            : undefined
          const proposal: MergeProposal = {
            ids,
            text,
            ...(tags === undefined || tags.length === 0
              ? {}
              : { tags: tags as readonly string[] }),
          }
          return proposal
        })
        .filter((item): item is MergeProposal =>
          item.ids.length >= 2 && item.text.length > 0)
    }
    return { delete: del, merge }
  } catch {
    return { delete: [], merge: [] }
  }
}

/** The review directive given to the model. */
const REVIEW_INSTRUCTION = [
  'You are a memory curator for an AI coding assistant. Below are AUTO-EXTRACTED memory records (id: text) — they were extracted automatically from past conversations, so deleting or merging them is safe and expected.',
  '',
  'Each record is tagged with its location: [user] for host-global facts, [project:<workspace>] for one workspace\'s facts.',
  '',
  'DECIDE, per record or per group of records:',
  '',
  '1. DELETE records matching ANY of these categories:',
  '- Transient/one-off: "the build showed 3 warnings", "pressed Ctrl+S at 14:32", "checked node version with node -v" — task state, timestamps, one-time events',
  '- Resolved/obsolete: a fix or decision that is already implemented, a superseded plan',
  '- Trivial/vague: fragments that carry no durable meaning on their own',
  '- Exact duplicates of another record that will be kept',
  '',
  '2. MERGE records that cover the SAME TOPIC as fragments — several records that together tell one story are consolidated into a single fuller record. Examples:',
  '- Three records about "the extraction LLM failing after a harness upgrade" (each holding one symptom or one fix) → one record describing the full root cause and resolution',
  '- Several records describing the same component\'s architecture from different angles → one coherent architecture note',
  '',
  'MERGE RULES:',
  '- Only merge records with the SAME [user] or SAME [project:<workspace>] tag — never across scopes or workspaces',
  '- Merge only genuinely related records (same theme); do not force unrelated facts together',
  '- The merged text must be a concise, complete statement that preserves every durable fact from the sources (drop only transient detail)',
  '',
  'KEEP records that capture durable facts: user preferences, project decisions, conventions, architecture, stable identifiers, API/commands worth remembering.',
  '',
  'Respond with ONLY a JSON object, e.g.:',
  '{"delete":["id-1","id-2"],"merge":[{"ids":["id-3","id-4"],"text":"The merged fuller fact..."}]}',
  'Use empty arrays when nothing qualifies: {"delete":[],"merge":[]}',
  '',
].join('\n')

/** Maximum records offered to the model in one review request. Reasoning
 * models think per-record; a single giant batch (23 records) took ~145s and
 * blew the timeout. Smaller batches keep each request well inside budget. */
const REVIEW_BATCH_SIZE = 8

/** One candidate location key: scope + workspace (merge only within one). */
function locationKey(candidate: ReviewCandidate): string {
  return candidate.record.scope === 'user' ? 'user' : `project:${candidate.workspace ?? ''}`
}

/** Ask the model for one batch's review plan; never throws (returns empty). */
async function reviewBatch(
  apiCtx: { agentDefaultModel: { currentSelection(): { provider: string; model: string } }; llm: { stream(options: GenerateOptions): AsyncIterable<unknown> } },
  batch: readonly ReviewCandidate[],
  signal?: AbortSignal,
): Promise<ReviewPlan> {
  const selection = apiCtx.agentDefaultModel?.currentSelection()
  if (selection === undefined || selection.provider.length === 0 || selection.model.length === 0) {
    return { delete: [], merge: [] }
  }
  const llm = apiCtx.llm
  if (llm === undefined) return { delete: [], merge: [] }

  const listing = batch
    .map(candidate => {
      const location = candidate.record.scope === 'user'
        ? '[user]'
        : `[project:${candidate.workspace ?? '?'}]`
      return `${candidate.record.id} ${location}: ${candidate.record.text}`
    })
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
    // Leave maxTokens unset: the routed model is often a reasoning model
    // whose thinking (reasoning_content) alone can exceed a fixed budget —
    // a hard cap truncated the thinking before any content was produced, so
    // the review returned [] and cleaned nothing. Let the llm service apply
    // the model's own default output cap instead.
    ...signal === undefined ? {} : { signal },
  }
  const controller = new AbortController()
  // Reasoning models spend tokens (and wall-clock) thinking before answering.
  // Per-batch budget: 90s covers a batch of ~8 with margin.
  const timer = setTimeout(() => { controller.abort() }, 90_000)
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
    return { delete: [], merge: [] }
  } finally {
    clearTimeout(timer)
  }
  return parseReviewPlan(text)
}

/** Apply one batch's plan: merges first, then deletes. Returns the outcomes. */
async function applyPlan(
  store: MemoryStore,
  candidates: readonly ReviewCandidate[],
  plan: ReviewPlan,
  memoryRoot: string | undefined,
): Promise<Array<{ id: string; scope: MemoryScope; workspace?: string; text: string }>> {
  const byId = new Map(candidates.map(candidate => [candidate.record.id, candidate]))

  // ---- Merges first: consolidate related fragments into one fuller record.
  const mergedIds = new Set<string>()
  const mergedOutcome: Array<{ id: string; scope: MemoryScope; workspace?: string; text: string }> = []
  for (const proposal of plan.merge) {
    const members = proposal.ids
      .map(id => byId.get(id))
      .filter((member): member is ReviewCandidate => member !== undefined)
    // Safety: drop proposals that reference unknown ids, or span multiple
    // scopes/workspaces, or merge a single record into itself.
    if (members.length < 2) continue
    const firstScope = members[0]!.record.scope
    const firstWorkspace = members[0]!.workspace
    const uniform = members.every(member =>
      member.record.scope === firstScope && member.workspace === firstWorkspace)
    if (!uniform) continue
    // All members must still exist (a prior merge may have consumed one).
    if (members.some(member => mergedIds.has(member.record.id))) continue

    const created = await store.create(firstScope, {
      text: proposal.text,
      ...(proposal.tags === undefined || proposal.tags.length === 0
        ? {}
        : { tags: [...proposal.tags] }),
    }, { kind: 'auto' }, firstWorkspace)
    for (const member of members) {
      mergedIds.add(member.record.id)
      await store.delete(member.record.id, member.workspace)
    }
    mergedOutcome.push({
      id: created.id,
      scope: firstScope,
      ...firstWorkspace === undefined ? {} : { workspace: firstWorkspace },
      text: `${proposal.text} [merged from: ${members.map(m => m.record.id).join(', ')}]`.slice(0, 120),
    })
  }

  // ---- Deletes: drop transient/obsolete/trivial records, excluding any id
  // already consumed by a merge.
  const removed: Array<{ id: string; scope: MemoryScope; workspace?: string; text: string }> = []
  for (const candidate of candidates) {
    if (mergedIds.has(candidate.record.id)) continue
    if (!plan.delete.includes(candidate.record.id)) continue
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
  if (mergedOutcome.length > 0) {
    await appendAudit({
      time: Date.now(),
      layer: 'llm',
      reason: 'model review: merged related auto-extracted records',
      removed: mergedOutcome,
    }, memoryRoot)
  }
  return [...removed, ...mergedOutcome]
}

/**
 * LLM review layer: ask the routed model which auto-extracted records are
 * duplicates/stale/trivial (delete) or same-topic fragments (merge). Runs in
 * small per-location batches so each request stays inside the reasoning
 * model's budget, and one failing batch never blanks the whole review.
 * @returns every affected record (deleted or merged-into) for auditing.
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

  const apiCtx = ctx as unknown as {
    agentDefaultModel: { currentSelection(): { provider: string; model: string } }
    llm: { stream(options: GenerateOptions): AsyncIterable<unknown> }
  }

  // Group by location (merge constraint: same scope AND workspace), then
  // slice each location into REVIEW_BATCH_SIZE chunks. Batches run serially
  // (the model route may rate-limit parallel reasoning calls).
  const byLocation = new Map<string, ReviewCandidate[]>()
  for (const candidate of candidates) {
    const key = locationKey(candidate)
    const list = byLocation.get(key) ?? []
    list.push(candidate)
    byLocation.set(key, list)
  }
  const batches: ReviewCandidate[][] = []
  for (const list of byLocation.values()) {
    for (let index = 0; index < list.length; index += REVIEW_BATCH_SIZE) {
      batches.push(list.slice(index, index + REVIEW_BATCH_SIZE))
    }
  }

  const outcome: Array<{ id: string; scope: MemoryScope; workspace?: string; text: string }> = []
  for (const batch of batches) {
    // Fail-soft per batch: a model error or malformed reply yields an empty
    // plan and that batch is simply skipped, never aborting the whole review.
    const plan = await reviewBatch(apiCtx, batch, signal)
    if (plan.delete.length === 0 && plan.merge.length === 0) continue
    outcome.push(...await applyPlan(store, batch, plan, memoryRoot))
  }
  return outcome
}
