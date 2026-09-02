/**
 * dsh-hippocampus automatic injection: before each agent step, recall
 * relevant memory for the step's user text and inject the hits as a
 * plugin-sourced user message.
 *
 * Listens on the `agent/pre-step` waterfall: `await next()` first (so the
 * step proceeds normally), then appends a compact memory snapshot when the
 * step's claimed user messages contain searchable text. Deduplicated per
 * session by the query digest, so the same query is not re-injected.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MemoryRecallHit } from './types.ts'
import type { MemoryStore } from './store.ts'

/** Max injected memory bytes per step; keeps token cost bounded. */
const MAX_INJECT_BYTES = 2_000

/** Per-session injected-query digests, so the same query is not re-injected. */
const injectedQueries = new WeakMap<object, Set<string>>()

/** Simple digest of the normalized query. */
function digest(query: string): string {
  let hash = 0
  for (let i = 0; i < query.length; i += 1) {
    hash = ((hash << 5) - hash + query.charCodeAt(i)) | 0
  }
  return String(hash)
}

/** Extract searchable user text from the step's claimed messages. */
function userText(messages: readonly UserMessage[]): string | undefined {
  const parts: string[] = []
  for (const message of messages) {
    if ((message.source as { kind?: unknown }).kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      const text = block.text.trim()
      if (text.length > 0) parts.push(text)
    }
  }
  return parts.length === 0 ? undefined : parts.join(' ')
}

/** Render one recall hit for injection. */
function renderHit(hit: MemoryRecallHit): string {
  const { record } = hit
  const scopeTag = record.scope === 'user' ? 'user' : 'project'
  return `[${scopeTag}] ${record.text}`
}

/** Resolve the workspace from an agent's session header. */
function workspaceOf(agent: Agent): string | undefined {
  const session = agent.session as { header?: { cwd?: string } }
  return session.header?.cwd
}

/** Register the pre-step memory injection hook. */
export function registerAutoInject(
  ctx: Context,
  store: MemoryStore,
  options: { limit: number },
): void {
  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const query = userText(messages)
    if (query === undefined || query.length === 0) return decision

    const session = agent.session as { id: string }
    const seen = injectedQueries.get(session)
    const key = digest(query)
    if (seen !== undefined && seen.has(key)) return decision
    if (seen === undefined) injectedQueries.set(session, new Set())

    try {
      const hits = await store.recall(query, {
        limit: options.limit,
        workspace: workspaceOf(agent),
        includeProjectFallback: true,
      })
      if (hits.length === 0) return decision
      // Mark the query as injected before rendering, so truncation and
      // success paths both deduplicate.
      injectedQueries.get(session)?.add(key)
      // Record what the model actually receives: each injected hit appends
      // one entry to the session's recall log (project layer), powering the
      // "recent recalls" section of the Memory tab.
      for (const hit of hits) {
        await store.recordRecall(session.id, hit.record.id, workspaceOf(agent), query).catch(() => {})
      }
      const text = hits.map(renderHit).join('\n')
      if (text.length > MAX_INJECT_BYTES) {
        // Keep the highest-scoring hits within the byte budget.
        const truncated: string[] = []
        let bytes = 0
        for (const hit of hits) {
          const line = renderHit(hit)
          if (bytes + line.length > MAX_INJECT_BYTES) break
          truncated.push(line)
          bytes += line.length
        }
        if (truncated.length === 0) return decision
        return appendMemorySnapshot(decision, truncated.join('\n'))
      }
      return appendMemorySnapshot(decision, text)
    } catch {
      // Injection is best-effort: a recall failure never blocks the step.
      return decision
    }
  })
}

/** Append the memory snapshot as a plugin-sourced user message. */
function appendMemorySnapshot(
  decision: Extract<PreStepDecision, { kind: 'enter' }>,
  text: string,
): PreStepDecision {
  const snapshot = createUserMessage({
    content: [{ type: 'text', text: [
      '<system-reminder>',
      'Relevant memory from previous sessions:',
      text,
      'Use these facts when they apply; do not treat them as the user\'s current message.',
      '</system-reminder>',
    ].join('\n') }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-hippocampus',
      form: 'snapshot',
    } as never,
  })
  return { ...decision, messages: [...decision.messages, snapshot] }
}
