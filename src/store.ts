/**
 * dsh-hippocampus storage layer: layered project/user record stores over
 * per-record JSON files with atomic writes.
 *
 * Layout:
 *   project layer: <workspace>/.dsh/hippocampus/records/<uuid>.json
 *   user layer:    ~/.dsh/hippocampus/records/<uuid>.json
 *
 * The user layer is capped (maxUserRecords, default 200) with LRU eviction by
 * lastAccessedAt; the project layer is uncapped and follows the workspace.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { MemoryInput, MemoryRanker, MemoryRecord, MemoryRecallHit, MemoryScope, RecallLogEntry, SessionRecallAggregate } from './types.ts'

/** Resolved storage roots for both layers. */
export interface StoreRoots {
  /** Project-layer root; workspace-scoped. */
  readonly projectRoot: string
  /** User-layer root; host-global. */
  readonly userRoot: string
}

/** Resolve both storage roots from a workspace path and optional config override. */
export function resolveRoots(workspace: string | undefined, memoryRoot?: string): StoreRoots {
  const userRoot = resolve(memoryRoot ?? join(homedir(), '.dsh', 'hippocampus'))
  const projectRoot = workspace === undefined
    ? userRoot
    : resolve(workspace, '.dsh', 'hippocampus')
  return { projectRoot, userRoot }
}

/** The records directory for one scope. */
function recordsDir(roots: StoreRoots, scope: MemoryScope): string {
  return join(scope === 'project' ? roots.projectRoot : roots.userRoot, 'records')
}

/** The on-disk path for one record. */
function recordPath(dir: string, id: string): string {
  return join(dir, `${id}.json`)
}

/** The recall log directory (project layer; follows the workspace). */
function recallsDir(roots: StoreRoots): string {
  return join(roots.projectRoot, 'recalls')
}

/** The recall log file for one session. */
function recallLogPath(roots: StoreRoots, sessionId: string): string {
  return join(recallsDir(roots), `${sessionId}.jsonl`)
}

/** Read and validate one record file; `undefined` when missing or malformed. */
async function readRecordFile(path: string): Promise<MemoryRecord | undefined> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as MemoryRecord
    if (typeof parsed.id !== 'string' || typeof parsed.text !== 'string'
      || (parsed.scope !== 'project' && parsed.scope !== 'user')) {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

/** MemoryStore: layered CRUD, recall, dedupe, and user-layer LRU eviction. */
export class MemoryStore {
  private readonly roots: StoreRoots
  private ranker: MemoryRanker | undefined

  constructor(private readonly maxUserRecords: number, memoryRoot?: string) {
    this.roots = resolveRoots(undefined, memoryRoot)
  }

  /** Install a pluggable relevance ranker; the keyword ranker is the default. */
  setRanker(ranker: MemoryRanker): void {
    this.ranker = ranker
  }

  /**
   * Resolve the roots for one operation: the project layer follows the
   * caller's workspace, the user layer is fixed.
   */
  private rootsFor(workspace: string | undefined): StoreRoots {
    return workspace === undefined || workspace === this.roots.projectRoot
      ? this.roots
      : { ...this.roots, projectRoot: resolve(workspace, '.dsh', 'hippocampus') }
  }

  /** Ensure both records directories exist for one workspace. */
  async ensure(workspace?: string): Promise<void> {
    const roots = this.rootsFor(workspace)
    await mkdir(recordsDir(roots, 'project'), { recursive: true })
    await mkdir(recordsDir(roots, 'user'), { recursive: true })
  }

  /** List every record in one scope, newest first. */
  async list(scope: MemoryScope, workspace?: string): Promise<MemoryRecord[]> {
    const roots = this.rootsFor(workspace)
    const dir = recordsDir(roots, scope)
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      return []
    }
    const records: MemoryRecord[] = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const id = file.slice(0, -'.json'.length)
      const record = await readRecordFile(recordPath(dir, id))
      if (record !== undefined && record.scope === scope) records.push(record)
    }
    records.sort((a, b) => b.createdAt - a.createdAt)
    return records
  }

  /** Read one record by id across both scopes. */
  async get(id: string, workspace?: string): Promise<MemoryRecord | undefined> {
    const roots = this.rootsFor(workspace)
    for (const scope of ['project', 'user'] as const) {
      const record = await readRecordFile(recordPath(recordsDir(roots, scope), id))
      if (record !== undefined) return record
    }
    return undefined
  }

  /** Store one record with an atomic write (temp file + rename). */
  private async writeAtomic(roots: StoreRoots, scope: MemoryScope, record: MemoryRecord): Promise<void> {
    const dir = recordsDir(roots, scope)
    await mkdir(dir, { recursive: true })
    const target = recordPath(dir, record.id)
    const temp = `${target}.tmp-${randomUUID()}`
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    await rename(temp, target)
  }

  /** Create one record; a same-scope duplicate by normalized text refreshes instead. */
  async create(scope: MemoryScope, input: MemoryInput, source: MemoryRecord['source'], workspace?: string): Promise<MemoryRecord> {
    const roots = this.rootsFor(workspace)
    const now = Date.now()
    const text = input.text.trim()
    // Deduplicate by normalized text within the same scope (and workspace).
    const existing = (await this.list(scope, workspace)).find(record => record.text.toLowerCase() === text.toLowerCase())
    if (existing !== undefined) {
      const refreshed: MemoryRecord = {
        ...existing,
        updatedAt: now,
      }
      await this.writeAtomic(roots, scope, refreshed)
      return refreshed
    }
    const record: MemoryRecord = {
      id: randomUUID(),
      text,
      scope,
      tags: [...new Set((input.tags ?? []).map(tag => tag.trim()).filter(tag => tag.length > 0))],
      source,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
    }
    await this.writeAtomic(roots, scope, record)
    await this.evictUserIfOverCap(workspace)
    return record
  }

  /**
   * Create one record under an explicit id (used by audit-driven restore so
   * the deleted record keeps its original identity). Skips deduplication and
   * refreshes nothing; throws when a record with that id already exists.
   */
  async createWithId(
    id: string,
    scope: MemoryScope,
    input: MemoryInput,
    workspace?: string,
  ): Promise<MemoryRecord> {
    const roots = this.rootsFor(workspace)
    const now = Date.now()
    const text = input.text.trim()
    if (text.length === 0) throw new Error('memory record text must not be empty')
    const record: MemoryRecord = {
      id,
      text,
      scope,
      tags: [...new Set((input.tags ?? []).map(tag => tag.trim()).filter(tag => tag.length > 0))],
      // Restored records are treated as explicit user intent.
      source: { kind: 'explicit' },
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
    }
    await this.writeAtomic(roots, scope, record)
    await this.evictUserIfOverCap(workspace)
    return record
  }

  /** Delete one record across both scopes; resolves true when it existed. */
  async delete(id: string, workspace?: string): Promise<boolean> {
    const roots = this.rootsFor(workspace)
    for (const scope of ['project', 'user'] as const) {
      const path = recordPath(recordsDir(roots, scope), id)
      try {
        await rm(path)
        return true
      } catch {
        // continue to the next scope
      }
    }
    return false
  }

  /**
   * Stamp a record as reviewed by the LLM maintenance pass.
   * Updates `lastReviewedAt` in place when the record exists; no-op otherwise.
   * @param id - the record id.
   * @param workspace - workspace for project-layer records (undefined = user layer).
   * @param at - review timestamp in epoch ms; defaults to now.
   */
  async touchReviewed(id: string, workspace?: string, at: number = Date.now()): Promise<boolean> {
    const roots = this.rootsFor(workspace)
    for (const scope of ['project', 'user'] as const) {
      const path = recordPath(recordsDir(roots, scope), id)
      const record = await readRecordFile(path)
      if (record === undefined) continue
      await this.writeAtomic(roots, scope, { ...record, lastReviewedAt: at })
      return true
    }
    return false
  }

  /**
   * Delete one record across the user layer and every known workspace root.
   * Used when the executing session's workspace cannot be resolved: a record
   * must never be "unknown" merely because it lives in a different project.
   * @param id - the record id.
   * @param workspaces - registered workspace paths to scan besides the user layer.
   * @returns true when the record was found and removed anywhere.
   */
  async deleteAnywhere(id: string, workspaces: readonly string[] = []): Promise<boolean> {
    // User layer first (host-global), then every workspace's project layer.
    if (await this.delete(id, undefined)) return true
    for (const workspace of workspaces) {
      if (await this.delete(id, workspace)) return true
    }
    return false
  }

  /** Bump access statistics for one record; used by recall and ranking. */
  async touch(record: MemoryRecord, workspace?: string): Promise<void> {
    const roots = this.rootsFor(workspace)
    const now = Date.now()
    const updated: MemoryRecord = {
      ...record,
      accessCount: record.accessCount + 1,
      lastAccessedAt: now,
    }
    await this.writeAtomic(roots, record.scope, updated)
  }

  /** User-layer LRU eviction: drop the least-recently-accessed records over the cap. */
  private async evictUserIfOverCap(workspace?: string): Promise<void> {
    const userRecords = await this.list('user', workspace)
    if (userRecords.length <= this.maxUserRecords) return
    const sorted = [...userRecords].sort((a, b) => (a.lastAccessedAt ?? a.createdAt) - (b.lastAccessedAt ?? b.createdAt))
    const excess = sorted.slice(0, userRecords.length - this.maxUserRecords)
    for (const record of excess) {
      await this.delete(record.id, workspace)
    }
  }

  /** Keyword recall across scopes: project first, then user as fallback. */
  async recall(query: string, options: { scope?: MemoryScope; limit?: number; workspace?: string; includeProjectFallback?: boolean } = {}): Promise<MemoryRecallHit[]> {
    const limit = options.limit ?? 5
    const normalized = query.trim().toLowerCase()
    const scopes: MemoryScope[] = options.scope !== undefined
      ? [options.scope]
      : ['project', 'user']
    let hits: MemoryRecallHit[] = []
    let projectZero: MemoryRecallHit[] = []
    const ranker: MemoryRanker = this.ranker ?? { score: keywordScore }
    for (const scope of scopes) {
      const records = await this.list(scope, options.workspace)
      for (const record of records) {
        const score = normalized.length === 0 ? 1 : ranker.score(record, normalized)
        if (scope === 'project' && score === 0 && options.includeProjectFallback === true) {
          // Injection context: keep zero-overlap project records as a
          // low-priority fallback so project memory stays available for
          // paraphrase queries.
          projectZero.push({ record, score })
        } else if (score > 0 || normalized.length === 0) {
          hits.push({ record, score })
        }
      }
    }
    if (hits.length === 0 && projectZero.length > 0) {
      // Only surface zero-overlap project records when nothing scored.
      hits.push(...projectZero)
    }
    // Async refinement: when the ranker has a refine() hook, re-score the
    // shortlist (top 2x limit, capped) with it before the final sort.
    if (ranker.refine !== undefined && hits.length > 0) {
      const shortlist = hits.slice(0, Math.min(hits.length, limit * 2))
      const refined = await Promise.all(shortlist.map(async (hit) => ({
        record: hit.record,
        score: await ranker.refine!(hit.record, normalized),
      })))
      hits.splice(0, shortlist.length, ...refined)
      // A refined score of 0 means the ranker filtered the record out (e.g.
      // below the semantic threshold with no keyword overlap); drop it.
      hits = hits.filter(hit => hit.score > 0)
    }
    hits.sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt)
    const selected = hits.slice(0, limit)
    // Bump access statistics only for returned hits.
    for (const hit of selected) {
      await this.touch(hit.record, options.workspace).catch(() => {})
    }
    return selected
  }

  /**
   * Append one recall entry to a session's recall log (project layer).
   *
   * The log lives next to the records under `<workspace>/.dsh/hippocampus/
   * recalls/<sessionId>.jsonl`, one JSON object per line, append-only — so
   * "recent recalls" is a tail read, and aggregation by record id counts
   * repeat recalls naturally.
   *
   * @param sessionId - the session whose recall log receives the entry.
   * @param recordId - the recalled record id.
   * @param workspace - project-layer root; falls back to the store default.
   * @param query - optional trimmed query that produced the hit.
   */
  async recordRecall(
    sessionId: string,
    recordId: string,
    workspace?: string,
    query?: string,
  ): Promise<void> {
    if (sessionId.length === 0) return
    const roots = this.rootsFor(workspace)
    const entry: RecallLogEntry = {
      recordId,
      time: Date.now(),
      ...(query !== undefined && query.trim().length > 0 ? { query: query.trim() } : {}),
    }
    try {
      await mkdir(recallsDir(roots), { recursive: true })
      await appendFile(recallLogPath(roots, sessionId), `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      // Recall logging is best-effort: a storage failure never breaks recall.
    }
  }

  /**
   * Read one session's recall log, aggregated by record id.
   *
   * Entries are consumed newest-first; a record appears once with its total
   * recall count and the timestamp of its most recent recall. Records that
   * were deleted since the recall are dropped from the result.
   *
   * @param sessionId - the session whose recall log is read.
   * @param limit - maximum aggregated records to return (defaults to 20).
   * @param workspace - project-layer root; falls back to the store default.
   * @returns aggregated recalls newest-first, each with the live record.
   */
  async recallsFor(
    sessionId: string,
    workspace?: string,
    limit = 20,
  ): Promise<SessionRecallAggregate[]> {
    if (sessionId.length === 0 || limit <= 0) return []
    const roots = this.rootsFor(workspace)
    let raw: string
    try {
      raw = await readFile(recallLogPath(roots, sessionId), 'utf8')
    } catch {
      return []
    }
    const aggregates = new Map<string, SessionRecallAggregate>()
    const lines = raw.split('\n')
    const keep = new Array<boolean>(lines.length).fill(true)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      if (line.trim() === '') continue
      let entry: RecallLogEntry
      try {
        entry = JSON.parse(line) as RecallLogEntry
      } catch {
        continue
      }
      if (typeof entry.recordId !== 'string' || typeof entry.time !== 'number') continue
      const record = await this.get(entry.recordId, workspace)
      if (record === undefined) {
        // The recalled record was deleted since the recall; drop the line.
        keep[index] = false
        continue
      }
      const existing = aggregates.get(entry.recordId)
      if (existing !== undefined) {
        aggregates.set(entry.recordId, {
          record: existing.record,
          count: existing.count + 1,
          lastAt: Math.max(existing.lastAt, entry.time),
        })
      } else {
        aggregates.set(entry.recordId, { record, count: 1, lastAt: entry.time })
      }
    }
    // Purge stale lines for deleted records (best-effort; harmless junk data).
    const dropped = keep.some(value => !value)
    if (dropped) {
      const kept = lines.filter((_, index) => keep[index] ?? true).join('\n')
      try {
        await writeFile(recallLogPath(roots, sessionId), kept, 'utf8')
      } catch {
        // Purging is best-effort: a write failure never breaks recall reads.
      }
    }
    return [...aggregates.values()]
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, limit)
  }
}

/** Keyword relevance: token overlap over lower-cased text and tags. */
export function keywordScore(record: MemoryRecord, query: string): number {
  // Strip punctuation so "editor?" matches "editor" and "pnpm." matches "pnpm".
  const clean = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')
  const tokens = clean(query).split(/\s+/).filter(token => token.length > 0)
  if (tokens.length === 0) return 0
  const haystack = clean(`${record.text} ${record.tags.join(' ')}`)
  let hits = 0
  for (const token of tokens) {
    if (haystack.includes(token)) hits += 1
  }
  return hits / tokens.length
}

/** Exported for tests: record file path resolution. */
export { recordsDir, recordPath }
