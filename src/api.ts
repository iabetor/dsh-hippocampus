/**
 * dsh-hippocampus host JSON API: /memory/api/<method> over the MemoryStore.
 *
 * Mirrors the dsh-ide /ide JSON API pattern: a WebRoute registered on the
 * webserver, a browser-trust fence identical to the /api gateway's, bounded
 * body reads, and a JSON error envelope. All methods take the sessionId so
 * the project layer resolves to the calling session's workspace.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { MemoryScope } from './types.ts'
import type { MemoryStore } from './store.ts'
import { runRuleSweep, runLlmReview, readAudit, auditManualDelete, restoreFromAudit, removeAuditRecord } from './maintenance.ts'

// Extend the harness job-kind union with the memory-maintenance producer.
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'hippocampus-maintain': 'hippocampus-maintain'
  }
}

/** Body size bound of one JSON request. */
const MAX_BODY_BYTES = 1 << 20

/** One API failure with its wire code and HTTP status. */
export class MemoryApiError extends Error {
  constructor(
    readonly code: 'bad-request' | 'not-found' | 'forbidden' | 'internal',
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** Read and parse the JSON request body (bounded; malformed → bad-request). */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      throw new MemoryApiError('bad-request', 'request body too large')
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new MemoryApiError('bad-request', 'request body is not valid JSON')
  }
}

/** Write a JSON response. */
export function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}

/** Write a success envelope. */
export function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, value)
}

/** Write the shared error envelope. */
export function writeError(res: ServerResponse, error: unknown): void {
  if (error instanceof MemoryApiError) {
    writeJson(res, error.status, { ok: false, code: error.code, message: error.message })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, code: 'internal', message })
}

/** Browser-trust fence: loopback host or a configured trusted authority. */
function isTrustedRequest(req: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const authority = req.headers.host
  if (typeof authority !== 'string' || authority.length === 0) return false
  let url: URL
  try {
    url = new URL(`http://${authority}`)
  } catch {
    return false
  }
  const hostname = url.hostname
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  if (parts.length === 4 && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return true
  }
  return trustedHosts.some(entry => {
    try {
      const entryUrl = new URL(`http://${entry}`)
      return entryUrl.hostname === hostname
    } catch {
      return false
    }
  })
}

/** Structural face of the webServer service. */
interface WebServerService {
  register(route: WebRoute): () => void
}

/** Structural face of the webRuntime service. */
interface WebRuntimeService {
  trustedHosts: string[]
}

/** Structural face of the workspace registry service. */
interface WorkspaceRegistryService {
  /** All workspaces, each with its canonical path, title, and accounted session ids. */
  list(): readonly { readonly path: string; readonly title: string; readonly sessionIds: readonly string[] }[]
}

/**
 * Structural face of the session persistence service: lists every stored
 * session header (including subagent children and restored sessions that the
 * workspace registry never accounted).
 */
interface SessionPersistenceService {
  list(signal?: AbortSignal): Promise<readonly { readonly id: string; readonly cwd?: string }[]>
}

/** The plugin context: base Context plus the injected services. */
export type MemoryApiContext = import('@deepseek-ai/cordis').Context & {
  webServer: WebServerService
  webRuntime: WebRuntimeService
  workspaceRegistry?: WorkspaceRegistryService
  sessionPersistence?: SessionPersistenceService
  /** Default model route for the manual LLM review (web profiles). */
  agentDefaultModel: { currentSelection(): { provider: string; model: string } }
  /** LLM service for the manual LLM review (web profiles). */
  llm: { stream(options: import('@deepseek-ai/dsh-llm').GenerateOptions): AsyncIterable<unknown> }
  /** Background job registry (host provides jobs-local); makes maintain visible in ui-jobs. */
  jobs?: import('@deepseek-ai/dsh-jobs').JobRegistry
}

/** Parse a scope argument; undefined when absent or invalid. */
function parseScope(value: unknown): MemoryScope | undefined {
  return value === 'project' || value === 'user' ? value : undefined
}

/**
 * Resolve the workspace for one request: an explicit `workspace` path wins
 * (the settings panel knows its current workspace directly); otherwise a
 * sessionId is resolved through the workspace registry's authoritative
 * accounting (canonical path) first, then the live session header, then the
 * session persistence store (covers subagent children and restored sessions
 * the registry never accounted).
 */
async function workspaceOf(
  ctx: MemoryApiContext,
  sessionId: string,
  explicitWorkspace?: string,
): Promise<string | undefined> {
  if (explicitWorkspace !== undefined && explicitWorkspace.length > 0) return explicitWorkspace
  if (sessionId === '') return undefined
  const workspace = ctx.workspaceRegistry?.list().find(entry => entry.sessionIds.includes(sessionId))
  if (workspace !== undefined && workspace.path.length > 0) return workspace.path
  const session = (ctx.sessions as { get(id: string): { header?: { cwd?: string } } | undefined }).get(sessionId)
  if (session?.header?.cwd !== undefined) return session.header.cwd
  if (ctx.sessionPersistence !== undefined) {
    try {
      const headers = await ctx.sessionPersistence.list()
      const header = headers.find(entry => entry.id === sessionId)
      if (header?.cwd !== undefined) return header.cwd
    } catch {
      // Persistence read is best-effort; the caller's store handles a miss.
    }
  }
  return undefined
}

/** Register the /memory JSON API route on the webserver. */
export function registerMemoryApi(ctx: MemoryApiContext, store: MemoryStore, memoryRoot?: string): void {
  const trustedHosts = () => ctx.webRuntime.trustedHosts

  // ---- Background maintain jobs + SSE completion broadcast.
  // The "整理" button used to block the settings page for up to 90s+ while
  // the LLM review ran; it now returns immediately and the host finishes the
  // work in the background, then pushes a completion event to any browser
  // listening on /memory/api/events (an SSE stream, mirroring the harness
  // HMR plugin's event channel — no harness changes needed).
  const sseClients = new Set<ServerResponse>()
  const broadcast = (payload: unknown): void => {
    const line = `data: ${JSON.stringify(payload)}\n\n`
    for (const client of sseClients) {
      try { client.write(line) } catch { /* client gone */ }
    }
  }
  // Concurrency guard: one background maintain at a time. A second "整理"
  // click while one is running is refused (accepted:false) instead of
  // launching a duplicate review over the same records.
  let maintainRunning = false
  /** Run the maintain work; returns its outcome for the job + SSE broadcast. */
  const runBackgroundMaintain = async (): Promise<{
    status: 'completed' | 'failed'
    detail?: string
    removed: number
    audit: unknown
  }> => {
    try {
      const registry = ctx.workspaceRegistry?.list() ?? []
      // Snapshot the audit tail before the run so the completion event can
      // carry exactly the entries this job appended (rule + LLM layers).
      const before = await readAudit(memoryRoot)
      const beforeCount = before.length
      const ruleRemoved = await runRuleSweep(store, registry, memoryRoot)
      const llmAffected = await runLlmReview(ctx, store, registry, memoryRoot)
      const after = await readAudit(memoryRoot)
      const freshAudit = after.slice(0, Math.max(0, after.length - beforeCount))
      return {
        status: 'completed',
        removed: ruleRemoved + llmAffected.length,
        audit: freshAudit,
      }
    } catch (error) {
      return {
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
        removed: 0,
        audit: [],
      }
    }
  }
  /** Broadcast one completion/error event over the SSE channel. */
  const broadcastOutcome = (taskId: string, result: {
    status: 'completed' | 'failed'
    detail?: string
    removed: number
    audit: unknown
  }): void => {
    broadcast(result.status === 'completed'
      ? {
        type: 'maintain/done',
        taskId,
        removed: result.removed,
        audit: result.audit,
      }
      : {
        type: 'maintain/error',
        taskId,
        message: result.detail,
      })
  }
  const startMaintain = (taskId: string): boolean => {
    if (maintainRunning) return false
    maintainRunning = true
    broadcast({ type: 'maintain/start', taskId })

    // Register as an unowned background job so the task shows up in the
    // harness ui-jobs surface (session-header job list) while running and
    // after settling. The job's done promise settles with the outcome; the
    // SSE broadcast still fires for the settings-panel toast. When the jobs
    // registry is absent (headless) or refuses the unowned start, fall back
    // to the plain background run.
    const jobs = ctx.jobs
    const launchPlain = (): void => {
      void runBackgroundMaintain().then(result => {
        broadcastOutcome(taskId, result)
      }).finally(() => { maintainRunning = false })
    }
    if (jobs === undefined) {
      launchPlain()
      return true
    }
    try {
      jobs.start({
        kind: 'hippocampus-maintain',
        label: '记忆整理',
        run: () => {
          let settle!: (outcome: { status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }) => void
          const done = new Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }>((resolve) => {
            settle = resolve
          })
          void runBackgroundMaintain().then(result => {
            settle({
              status: result.status,
              detail: result.status === 'completed'
                ? `清理 ${result.removed} 条`
                : result.detail,
              output: result.status === 'completed' ? `清理 ${result.removed} 条` : undefined,
            })
            broadcastOutcome(taskId, result)
          }).finally(() => { maintainRunning = false })
          return {
            cancel: (reason?: string) => { settle({ status: 'killed', detail: reason }) },
            done,
          }
        },
      })
      return true
    } catch {
      // jobs present but refuses the start (no controller): plain run.
      launchPlain()
      return true
    }
  }

  const route: WebRoute = {
    kind: 'prefix',
    path: '/memory/api',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const method = url.pathname.slice('/memory/api'.length + 1)
      try {
        if (!isTrustedRequest(req, trustedHosts())) {
          throw new MemoryApiError('forbidden', 'request rejected by the memory trust fence', 403)
        }
        const body = (await readJsonBody(req)) as Record<string, unknown>
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const workspaceParam = typeof body.workspace === 'string' ? body.workspace : undefined
        const workspace = await workspaceOf(ctx, sessionId, workspaceParam)
        switch (method) {
          case 'list': {
            const scope = parseScope(body.scope)
            const records = await store.list(scope ?? 'project', workspace)
            writeOk(res, { records: records.map(view) })
            return
          }
          case 'search': {
            const query = typeof body.query === 'string' ? body.query : ''
            const scope = parseScope(body.scope)
            const limit = typeof body.limit === 'number' ? body.limit : 20
            const hits = await store.recall(query, {
              ...scope === undefined ? {} : { scope },
              limit,
              workspace,
            })
            writeOk(res, { hits: hits.map(hit => ({ ...view(hit.record), score: hit.score })) })
            return
          }
          case 'delete': {
            const id = typeof body.id === 'string' ? body.id : ''
            if (id === '') throw new MemoryApiError('bad-request', 'id is required')
            // Locate the record across the user layer and every workspace
            // (the settings panel deletes records from any project group),
            // delete it, and audit the manual removal.
            const workspaces = (ctx.workspaceRegistry?.list() ?? []).map(entry => entry.path)
            let targetWorkspace: string | undefined = workspace
            let record = targetWorkspace === undefined ? undefined : await store.get(id, targetWorkspace)
            if (record === undefined) {
              // Try the user layer, then every workspace.
              record = await store.get(id, undefined)
              targetWorkspace = undefined
              if (record === undefined) {
                for (const candidate of workspaces) {
                  const found = await store.get(id, candidate)
                  if (found !== undefined) {
                    record = found
                    targetWorkspace = candidate
                    break
                  }
                }
              }
            }
            const deleted = record === undefined
              ? false
              : await store.delete(id, targetWorkspace)
            if (deleted && record !== undefined) {
              await auditManualDelete(record, targetWorkspace, memoryRoot)
            }
            writeOk(res, { deleted })
            return
          }
          case 'restore': {
            // Restore one deleted record from the audit trail. The audit
            // entry carries the original id/scope/workspace/text/tags.
            const audit = await readAudit(memoryRoot)
            const entries = audit.flatMap(entry => entry.removed.map(item => ({ entry, item })))
            const target = entries.find(({ item }) => item.id === (typeof body.id === 'string' ? body.id : ''))
            if (target === undefined) {
              writeOk(res, { restored: false, reason: 'not-found' })
              return
            }
            // A project-layer record needs its workspace to come back:
            // either it no longer exists, or the audit entry predates the
            // workspace field and cannot be placed.
            if (target.item.scope === 'project') {
              if (target.item.workspace === undefined) {
                writeOk(res, { restored: false, reason: 'workspace-unknown' })
                return
              }
              const exists = (ctx.workspaceRegistry?.list() ?? []).some(entry => entry.path === target.item.workspace)
              if (!exists) {
                writeOk(res, { restored: false, reason: 'workspace-gone' })
                return
              }
            }
            const restoredId = await restoreFromAudit(target.item, store)
            if (restoredId !== undefined) {
              // The record is back; drop its audit entry so it cannot be
              // restored twice.
              await removeAuditRecord(restoredId, memoryRoot)
            }
            writeOk(res, { restored: restoredId !== undefined, id: restoredId })
            return
          }
          case 'groups': {
            // Grouped memory for the settings panel: user-global first, then
            // one block per registered workspace that has project memory.
            const user = await store.list('user', workspace)
            const workspaces: { path: string; title: string; records: Array<ReturnType<typeof view>> }[] = []
            const registry = ctx.workspaceRegistry?.list() ?? []
            for (const entry of registry) {
              const records = await store.list('project', entry.path)
              if (records.length === 0) continue
              workspaces.push({
                path: entry.path,
                title: entry.title,
                records: records.map(view),
              })
            }
            writeOk(res, {
              user: user.map(view),
              workspaces,
            })
            return
          }
          case 'stats': {
            const project = await store.list('project', workspace)
            const user = await store.list('user', workspace)
            writeOk(res, {
              projectCount: project.length,
              userCount: user.length,
              totalCount: project.length + user.length,
            })
            return
          }
          case 'recalls': {
            const limit = typeof body.limit === 'number' ? body.limit : 20
            const items = await store.recallsFor(sessionId, workspace, limit)
            writeOk(res, {
              items: items.map(item => ({
                ...view(item.record),
                recallCount: item.count,
                lastRecalledAt: item.lastAt,
              })),
            })
            return
          }
          case 'maintain': {
            // Manual maintenance trigger (settings panel button). Returns
            // immediately with a task id; the rule sweep + batched LLM
            // review run in the background (see runBackgroundMaintain) and
            // the result is pushed over /memory/api/events. A second click
            // while one job is running is refused (accepted:false) so two
            // reviews never race over the same records.
            const taskId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
            const started = startMaintain(taskId)
            writeOk(res, started ? { accepted: true, taskId } : { accepted: false, reason: 'already-running' })
            return
          }
          case 'audit': {
            // Read the maintenance audit trail (what was cleaned and why).
            const audit = await readAudit(memoryRoot)
            writeOk(res, { audit: audit.slice(0, 100) })
            return
          }
          default:
            throw new MemoryApiError('not-found', `unknown method "${method}"`, 404)
        }
      } catch (error) {
        writeError(res, error)
      }
    },
  }
  ctx.webServer.register(route)

  // SSE completion channel: a browser opens this once and receives
  // maintain/done (or maintain/error) events as background jobs finish.
  // Exact paths win over the /memory/api prefix (see WebServer.match).
  const eventsRoute: WebRoute = {
    kind: 'exact',
    path: '/memory/api/events',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (!isTrustedRequest(req, trustedHosts())) {
        writeError(res, new MemoryApiError('forbidden', 'request rejected by the memory trust fence', 403))
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      // Initial heartbeat frame establishes the stream; some proxies buffer
      // until the first write.
      res.write(': connected\n\n')
      sseClients.add(res)
      res.on('close', () => { sseClients.delete(res) })
      res.on('error', () => { sseClients.delete(res) })
    },
  }
  ctx.webServer.register(eventsRoute)
}

/** Compact record view for the browser. */
function view(record: import('./types.ts').MemoryRecord) {
  return {
    id: record.id,
    text: record.text,
    scope: record.scope,
    tags: record.tags,
    source: record.source.kind,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    accessCount: record.accessCount,
    lastAccessedAt: record.lastAccessedAt,
  }
}
