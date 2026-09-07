/**
 * dsh-hippocampus model-facing tools: remember, recall, forget.
 *
 * Registers three exclusive tools over the MemoryStore plus a `tool:memory`
 * prompt section guiding when to use them. The section order is a plugin
 * custom value (2350), never occupying a first-party slot upstream.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Side-effect type imports: declaration-merge `ctx.tools` and
// `ctx.systemPrompt` onto Context.
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { MemoryRecord, MemoryScope } from './types.ts'
import type { MemoryStore } from './store.ts'
import { auditManualDelete, runLlmReview } from './maintenance.ts'

/** Structural face of the session store: enough to resolve the workspace. */
interface SessionLike {
  readonly header?: { readonly cwd?: string }
}
interface SessionsService {
  get(id: string): SessionLike | undefined
}

/** Structural face of the workspace registry (optional; headless profiles may lack it). */
interface WorkspaceRegistryService {
  list(): readonly { readonly path: string }[]
}

/** The plugin context: base Context plus the services we inject. */
export type MemoryPluginContext = Context & {
  sessions: SessionsService
  workspaceRegistry?: WorkspaceRegistryService
}

/**
 * Resolve the workspace root for one executing agent's session, with the same
 * robustness as the API layer: the live session header first, then the
 * session store's copy of the header (covers runtime sessions whose header
 * object is absent from `exec.agent`), then a scan of every registered
 * workspace when the session cannot be resolved at all.
 */
async function workspaceOf(
  ctx: MemoryPluginContext,
  exec: { agent?: Agent },
): Promise<string | undefined> {
  const session = exec.agent?.session
  if (session !== undefined && 'header' in session) {
    const header = (session as { header?: { cwd?: string } }).header
    if (header?.cwd !== undefined) return header.cwd
  }
  const agentId = exec.agent?.id
  if (agentId !== undefined) {
    const stored = ctx.sessions.get(agentId)
    if (stored?.header?.cwd !== undefined) return stored.header.cwd
  }
  // Last resort: a single registered workspace (the common single-project
  // case) — the store's deleteAnywhere still covers the rest.
  const registry = ctx.get?.('workspaceRegistry') as WorkspaceRegistryService | undefined
  const workspaces = registry?.list() ?? []
  if (workspaces.length === 1) return workspaces[0]?.path
  return undefined
}

/** Parse a scope argument; invalid values throw so the model can retry. */
function parseScope(value: unknown): MemoryScope | undefined {
  if (value === undefined) return undefined
  if (value === 'project' || value === 'user') return value
  throw new Error(`invalid memory scope: ${String(value)}`)
}

/** Compact record view returned to the model. */
function recordView(record: MemoryRecord) {
  return {
    id: record.id,
    text: record.text,
    scope: record.scope,
    ...record.tags.length === 0 ? {} : { tags: [...record.tags] },
    source: record.source.kind,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

const MEMORY_OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    records: {
      type: 'array',
      required: true,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          text: { type: 'string', required: true },
          scope: { type: 'string', required: true, enum: ['project', 'user'] },
          tags: { type: 'array', items: { type: 'string' } },
          source: { type: 'string', required: true },
          createdAt: { type: 'number', required: true },
          updatedAt: { type: 'number', required: true },
          score: { type: 'number' },
        },
      },
    },
  },
} as const

type MemoryToolValue = { records: Array<ReturnType<typeof recordView> & { score?: number }> }

const MEMORY_OUTPUT = {
  schema: MEMORY_OUTPUT_SCHEMA,
  render: (_args: unknown, value: MemoryToolValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

const PROMPT_TEXT =
  'Use remember to store facts the user asks you to keep, and recall to retrieve relevant '
  + 'remembered facts before answering. Memory is durable across sessions and restarts and '
  + 'layered: project facts live with the workspace, user facts follow the user. Prefer recall '
  + 'over guessing when a remembered preference could matter. Use forget only when '
  + 'the user explicitly asks to remove a fact.'
  + '\n\n'
  + 'What belongs in memory (remember):'
  + '\n- Cross-project personal preferences/habits the user stated (scope user, kind preference).'
  + '\n- Project conventions/rules the user confirmed and that future sessions need (scope project, kind convention).'
  + '\n- Short pointers to where an answer lives (e.g. "X is implemented in src/y.ts", kind pointer).'
  + '\n- Anything the user explicitly says "remember this" — remember it regardless.'
  + '\nWhat does NOT belong in memory:'
  + '\n- Technical behavior/API facts that source code documents — read the source when needed instead.'
  + '\n- Transient task state, one-off answers, current progress/todos.'
  + '\n- Long prose or full explanations — keep records to one or two sentences.'
  + '\nWhen in doubt, do not remember.'
  + '\n\n'
  + 'Memory curation — when the user asks to tidy/curate/organize memory (e.g. "整理记忆", "清理记忆", "review my memory"), '
  + 'call the curate tool. It runs the same model-driven review as the settings "整理" button and the hourly background job: '
  + 'duplicates are merged, contradictions resolved (keep the newest), transient/obsolete records deleted, with an audit trail. '
  + 'Do NOT hand-curate with recall/forget loops — one curate call covers every record.'
  + '\n1. Call curate once (no arguments needed; it reviews both scopes and workspaces).'
  + '\n2. Report what it cleaned: how many records were deleted/merged (the tool returns the details).'
  + '\n3. If curate reports conflicts (explicit-vs-explicit memory pairs the model did NOT delete), list both texts to the user '
  + 'with the model\'s suggested keep/remove and ask which to delete — never auto-delete either side of a conflict.'
  + '\n4. If the user only wanted one specific record forgotten, use forget — curate is only for whole-memory tidying.'

const CURATE_OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    removed: {
      type: 'array',
      required: true,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          scope: { type: 'string', required: true, enum: ['project', 'user'] },
          text: { type: 'string', required: true },
        },
      },
    },
    conflicts: {
      type: 'array',
      required: true,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          keep: { type: 'string', required: true },
          remove: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          keepText: { type: 'string' },
          removeText: { type: 'string' },
        },
      },
    },
  },
} as const

type CurateToolValue = {
  removed: Array<{ id: string; scope: MemoryScope; text: string }>
  conflicts: Array<{ keep: string; remove: string; reason: string; keepText?: string; removeText?: string }>
}

const CURATE_OUTPUT = {
  schema: CURATE_OUTPUT_SCHEMA,
  render: (_args: unknown, value: CurateToolValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

/** Register the three memory tools and their guidance section. */
export function registerMemoryTools(ctx: MemoryPluginContext, store: MemoryStore, memoryRoot?: string): void {
  ctx.systemPrompt.section({
    name: 'tool:memory',
    // Plugin-custom order between session-query (2300) and goal (2400);
    // deliberately not a FIRST_PARTY_SECTION_ORDER member.
    order: 2350,
    text: PROMPT_TEXT,
  })

  ctx.tools.register(defineTool({
    name: 'remember',
    description: 'Store one fact in durable cross-session memory. Use it only for (a) facts the user explicitly '
      + 'asks you to remember, or (b) cross-project personal preferences/habits/conventions the user stated. '
      + 'Do NOT use it for technical behavior that source code documents (read the source instead), '
      + 'design decisions/lessons (write an Agent Note instead), procedures (README), or progress (commits). '
      + 'Prefer a short pointer over restating source.',
    parameters: {
      text: { type: 'string', required: true, description: 'The fact to remember: one sentence, or a short pointer to where the authoritative detail lives.' },
      scope: { type: 'string', enum: ['project', 'user'], description: 'project is workspace-local (default); user is host-global.' },
      kind: { type: 'string', enum: ['preference', 'convention', 'pointer'], description: 'Knowledge kind: preference (cross-project personal), convention (project rule), pointer (index to docs/source). Optional — inferred from scope/text when omitted.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional free-form tags for retrieval.' },
    },
    output: MEMORY_OUTPUT,
    async execute(args, exec) {
      const scope = parseScope(args.scope) ?? 'project'
      const workspace = await workspaceOf(ctx, exec)
      const record = await store.create(scope, {
        text: args.text,
        ...(args.kind === 'preference' || args.kind === 'convention' || args.kind === 'pointer' ? { kind: args.kind } : {}),
        tags: args.tags,
      }, { kind: 'explicit' }, workspace)
      return { records: [recordView(record)] }
    },
    presentCall: args => ({ card: 'generic', title: 'Remember fact', kind: 'other', rawInput: args.text }),
  }))

  ctx.tools.register(defineTool({
    name: 'recall',
    description: 'Search durable cross-session memory for facts relevant to the current task. '
      + 'Project facts are searched first, then user facts.',
    parameters: {
      query: { type: 'string', required: true, description: 'Free-form search query; leave empty to list all memory.' },
      scope: { type: 'string', enum: ['project', 'user'], description: 'Restrict to one scope; both are searched when omitted.' },
      limit: { type: 'number', description: 'Maximum hits (default 5).' },
    },
    output: MEMORY_OUTPUT,
    async execute(args, exec) {
      const hits = await store.recall(args.query, {
        ...args.scope === undefined ? {} : { scope: parseScope(args.scope) },
        ...args.limit === undefined ? {} : { limit: args.limit },
        workspace: await workspaceOf(ctx, exec),
      })
      return { records: hits.map(hit => ({ ...recordView(hit.record), score: hit.score })) }
    },
    presentCall: args => ({ card: 'generic', title: 'Recall memory', kind: 'read', rawInput: args.query }),
  }))

  ctx.tools.register(defineTool({
    name: 'forget',
    description: 'Delete one memory record by id. Call this only when the user explicitly asks to forget '
      + 'or correct a previously remembered fact.',
    parameters: {
      id: { type: 'string', required: true, description: 'Exact record id returned by recall or remember.' },
    },
    output: MEMORY_OUTPUT,
    async execute(args, exec) {
      const workspace = await workspaceOf(ctx, exec)
      const registry = ctx.get?.('workspaceRegistry') as WorkspaceRegistryService | undefined
      // Locate the record (scoped workspace first, then user layer, then every
      // registered workspace), delete it, and audit the manual removal.
      let targetWorkspace: string | undefined = workspace
      let record = targetWorkspace === undefined ? undefined : await store.get(args.id, targetWorkspace)
      if (record === undefined) {
        record = await store.get(args.id, undefined)
        targetWorkspace = undefined
        if (record === undefined) {
          for (const candidate of registry?.list().map(entry => entry.path) ?? []) {
            const found = await store.get(args.id, candidate)
            if (found !== undefined) {
              record = found
              targetWorkspace = candidate
              break
            }
          }
        }
      }
      const deleted = record === undefined ? false : await store.delete(args.id, targetWorkspace)
      if (!deleted) throw new Error(`memory record "${args.id}" is unknown or already deleted`)
      if (record !== undefined) {
        await auditManualDelete(record, targetWorkspace, memoryRoot)
      }
      return { records: [] }
    },
    presentCall: args => ({ card: 'generic', title: 'Forget memory', kind: 'other', rawInput: args.id }),
  }))

  // Whole-memory curation: same model-driven review as the settings 整理
  // button and the hourly timer (runLlmReview over every record, both
  // scopes). Needs the llm + agentDefaultModel services at execute time;
  // when absent (headless profiles) the model gets a clear error instead of
  // silently doing nothing.
  ctx.tools.register(defineTool({
    name: 'curate',
    description: 'Tidy the whole memory store: ask the routed model to review every record (user + project) and '
      + 'merge duplicates, delete contradictions (keeping the newest), transient/obsolete records, and over-long '
      + 'docs blobs. Every removal is audited (restorable from the settings cleanup log). '
      + 'Call this when the user asks to 整理记忆 / 清理记忆 / review or tidy memory. '
      + 'For deleting ONE specific record the user named, prefer forget instead.',
    parameters: {},
    output: CURATE_OUTPUT,
    async execute() {
      // Services are fetched at execute time (agentDefaultModel registers
      // later than the tools in some profiles); ctx.get resolves any
      // registered service regardless of registration order.
      const apiCtx = ctx as MemoryPluginContext & {
        llm?: { stream(options: unknown): AsyncIterable<unknown> }
      }
      const agentDefaultModel = ctx.get?.('agentDefaultModel') as
        | { currentSelection(): { provider: string; model: string } }
        | undefined
      if (agentDefaultModel === undefined || apiCtx.llm === undefined) {
        throw new Error('memory curation is unavailable in this profile (no llm/agentDefaultModel service); run it from the settings page instead')
      }
      const registry = ctx.get?.('workspaceRegistry') as WorkspaceRegistryService | undefined
      const result = await runLlmReview({
        ...apiCtx,
        agentDefaultModel,
      } as never, store, registry?.list() ?? [], memoryRoot)
      return {
        removed: result.removed.map(({ id, scope, text }) => ({ id, scope, text: text.slice(0, 300) })),
        conflicts: result.conflicts.map(({ keep, remove, reason, keepText, removeText }) => ({
          keep, remove, reason,
          ...(keepText === undefined ? {} : { keepText }),
          ...(removeText === undefined ? {} : { removeText }),
        })),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Curate memory', kind: 'other', rawInput: '' }),
  }))
}
