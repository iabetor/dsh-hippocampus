/**
 * dsh-hippocampus client API: typed fetch wrapper over the /memory JSON API.
 *
 * Mirrors the dsh-ide client api pattern: every call posts to
 * `/memory/api/<method>` with the sessionId; the host resolves the
 * authoritative workspace from the live session store.
 */

/** One memory record as the browser sees it. */
export interface MemoryRecordView {
  id: string
  text: string
  scope: 'project' | 'user'
  tags: string[]
  source: string
  createdAt: number
  updatedAt: number
  accessCount: number
  lastAccessedAt?: number
}

/** A search hit: record plus relevance score. */
export interface MemoryHitView extends MemoryRecordView {
  score: number
}

/** One aggregated session recall: record plus how often/when it was used. */
export interface MemoryRecallView extends MemoryRecordView {
  recallCount: number
  lastRecalledAt: number
}

/** Stats envelope. */
export interface MemoryStats {
  projectCount: number
  userCount: number
  totalCount: number
}

/** One workspace's project memory block. */
export interface MemoryWorkspaceGroup {
  /** Canonical workspace directory path. */
  path: string
  /** Display title (basename of the path by default). */
  title: string
  records: MemoryRecordView[]
}

/** Grouped memory for the settings panel: user-global, then per-workspace. */
export interface MemoryGroups {
  user: MemoryRecordView[]
  workspaces: MemoryWorkspaceGroup[]
}

/** Error envelope thrown on a non-ok response. */
export class MemoryApiClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** POST one /memory/api/<method> call with a JSON body. */
async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/memory/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new MemoryApiClientError('network', `memory api unreachable: ${String(error)}`)
  }
  const parsed = await res.json().catch(() => null) as unknown
  const record = (parsed ?? {}) as Record<string, unknown>
  if (!res.ok || record['ok'] === false) {
    throw new MemoryApiClientError(
      String(record['code'] ?? 'error'),
      String(record['message'] ?? `memory api failed (${res.status})`),
    )
  }
  return record as T
}

/** List records in one scope for one session's workspace. */
export function listRecords(sessionId: string, scope: 'project' | 'user', workspace?: string): Promise<{ records: MemoryRecordView[] }> {
  return call('list', { sessionId, scope, ...workspace === undefined ? {} : { workspace } })
}

/** Search memory across scopes for one session's workspace. */
export function searchMemory(sessionId: string, query: string, limit = 20, workspace?: string): Promise<{ hits: MemoryHitView[] }> {
  return call('search', { sessionId, query, limit, ...workspace === undefined ? {} : { workspace } })
}

/** Recent recalls for one session (aggregated by record, newest first). */
export function fetchRecalls(sessionId: string, limit = 20, workspace?: string): Promise<{ items: MemoryRecallView[] }> {
  return call('recalls', { sessionId, limit, ...workspace === undefined ? {} : { workspace } })
}

/** Delete one record by id. */
export function deleteRecord(sessionId: string, id: string, workspace?: string): Promise<{ deleted: boolean }> {
  return call('delete', { sessionId, id, ...workspace === undefined ? {} : { workspace } })
}

/** Stats for one session's workspace. */
export function fetchStats(sessionId: string, workspace?: string): Promise<MemoryStats> {
  return call('stats', { sessionId, ...workspace === undefined ? {} : { workspace } })
}

/** Grouped memory for the settings panel (user-global + per-workspace + ungrouped). */
export function fetchGroups(sessionId: string): Promise<MemoryGroups> {
  return call('groups', { sessionId })
}

/** One maintenance audit entry (what was cleaned and why). */
export interface MemoryAuditEntry {
  time: number
  layer: 'rules' | 'llm' | 'manual'
  reason: string
  removed: readonly {
    id: string
    scope: string
    workspace?: string
    text: string
    tags?: readonly string[]
  }[]
}

/** Run maintenance manually (settings button); returns removed count + audit. */
export function runMaintenance(sessionId: string): Promise<{ removed: number; audit: MemoryAuditEntry[] }> {
  return call('maintain', { sessionId })
}

/** Read the maintenance audit trail. */
export function fetchAudit(sessionId: string): Promise<{ audit: MemoryAuditEntry[] }> {
  return call('audit', { sessionId })
}

/** Restore one deleted record from the audit trail. */
export function restoreRecord(sessionId: string, id: string): Promise<{ restored: boolean; id?: string }> {
  return call('restore', { sessionId, id })
}
