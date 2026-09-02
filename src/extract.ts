/**
 * dsh-hippocampus automatic extraction: on completed turns, ask the routed
 * LLM to distill durable facts (with scope labels) and merge them into the
 * store.
 *
 * Listens on `session/event` for `turn/end` with `reason.kind ===
 * 'completed'` (post-commit, fire-and-forget), defers the model call off the
 * turn's critical path, and tracks the promise so disposal drains in-flight
 * work. A per-session cursor (last processed turn) makes extraction
 * idempotent across restarts. Failures are logged, never thrown.
 */

import type { Context } from '@deepseek-ai/cordis'
// Side-effect type imports: declaration-merge `ctx.llm` and `ctx.sessions`
// onto Context.
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { MemoryScope } from './types.ts'
import type { MemoryStore } from './store.ts'

/** Extraction frame tags; the model answers between these markers. */
const FACTS_OPEN_TAG = '<memory-facts>'
const FACTS_CLOSE_TAG = '</memory-facts>'

/** One durable fact distilled by the extraction model. */
export interface ExtractedFact {
  readonly text: string
  readonly scope?: MemoryScope
  readonly tags?: readonly string[]
}

/** Parse the model's text output into extracted facts with scope labels. */
export function parseExtractedFacts(text: string): ExtractedFact[] {
  const open = text.indexOf(FACTS_OPEN_TAG)
  const close = text.indexOf(FACTS_CLOSE_TAG)
  if (open < 0 || close < 0 || close <= open) return []
  const body = text.slice(open + FACTS_OPEN_TAG.length, close)
  const facts: ExtractedFact[] = []
  for (const line of body.split('\n')) {
    const match = /^\s*-\s+(.+)$/.exec(line)
    const content = match?.[1]?.trim()
    if (content === undefined || content.length === 0) continue
    // Optional [project] / [user] scope label at the start of the line.
    const scopeMatch = /^\[(project|user)\]\s+(.+)$/.exec(content)
    if (scopeMatch !== null) {
      facts.push({ text: scopeMatch[2]!.trim(), scope: scopeMatch[1] as MemoryScope })
    } else {
      // Unlabeled facts default to project (the primary retrieval source).
      facts.push({ text: content })
    }
  }
  return facts
}

/** Map a terminal finish reason to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('memory extraction truncated at the token cap') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** Extract facts from one turn's messages through the routed LLM. */
export async function extractFactsWithLlm(
  ctx: Context,
  config: { maxTokens: number; timeoutMs: number; provider?: string; model?: string },
  messages: readonly Message[],
  session: Session,
  signal?: AbortSignal,
): Promise<ExtractedFact[]> {
  const latest = session.requestHeader?.()?.config
  const configured = config.provider !== undefined && config.provider.length > 0
    ? { provider: config.provider, model: config.model ?? '' }
    : undefined
  const target = configured ?? latest
  if (target === undefined || target.model.length === 0) {
    throw new Error('hippocampus: no provider/model available for extraction; configure extractionProvider/Model or route a request first')
  }

  const requestMessages: Message[] = [
    ...messages,
    {
      role: 'user',
      content: [{ type: 'text', text: EXTRACTION_INSTRUCTION }],
      source: { kind: 'plugin', plugin: 'dsh-hippocampus' },
    } as Message,
  ]
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages: requestMessages,
    maxTokens: config.maxTokens,
    ...signal === undefined ? {} : { signal },
  }
  // Fuse upstream cancellation with an extraction-specific deadline.
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, config.timeoutMs)
  const fused = signal !== undefined ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({ ...options, signal: fused })) assembler.push(chunk)
    const error = finishError(assembler.finish)
    if (error !== undefined) throw error
    const text = assembler.blocks()
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
    return parseExtractedFacts(text)
  } finally {
    clearTimeout(timer)
  }
}

/** The extraction directive: distills durable facts with scope labels. */
const EXTRACTION_INSTRUCTION = [
  'You are a memory curator for an AI coding assistant. From the conversation above, extract facts worth remembering across future sessions.',
  '',
  'Include only durable, generalizable facts: user preferences, project decisions, conventions, constraints, and stable identifiers.',
  'Exclude: transient task state, answers to one-off questions, content already present in the conversation transcript, and anything the user explicitly asked to forget.',
  '',
  'Each fact must be labeled with its scope:',
  '- [project] — related to the current repository/project: tech stack, architecture decisions, code conventions, project-specific APIs or commands.',
  '- [user] — about the user personally and true across projects: coding habits, tool preferences, environment setup, communication preferences.',
  '',
  `Output EXACTLY the following structure, between ${FACTS_OPEN_TAG} and ${FACTS_CLOSE_TAG}:`,
  '',
  `${FACTS_OPEN_TAG}`,
  '- [project] <one-sentence fact>',
  '- [user] <one-sentence fact>',
  `${FACTS_CLOSE_TAG}`,
  '',
  'Rules:',
  '- One fact per line, each prefixed with "- " and a [project]/[user] label.',
  '- Write concise English or the user\'s language; preserve exact identifiers and values.',
  '- If nothing is worth remembering, output the empty frame:',
  `${FACTS_OPEN_TAG}`,
  `${FACTS_CLOSE_TAG}`,
  '- Do not mention this curation request. Output only the frame.',
].join('\n')

/** Merge extracted facts into the store with deduplication. */
async function mergeFacts(
  store: MemoryStore,
  facts: readonly ExtractedFact[],
  sessionId: string,
  turn: number,
  maxFacts: number,
  workspace: string | undefined,
): Promise<void> {
  let merged = 0
  for (const fact of facts) {
    if (merged >= maxFacts) break
    const scope = fact.scope ?? 'project'
    await store.create(scope, { text: fact.text, tags: fact.tags }, {
      kind: 'session',
      sessionId,
      turn,
    }, workspace)
    merged += 1
  }
}

/** Per-session extraction bookkeeping. */
interface SessionState {
  lastTurn: number
  tail: Promise<void>
}

/** Register the automatic extraction listener. */
export function registerAutoExtract(
  ctx: Context,
  store: MemoryStore,
  config: { maxTokens: number; timeoutMs: number; maxFactsPerTurn: number; provider?: string; model?: string },
): void {
  const states = new WeakMap<Session, SessionState>()

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'turn/end' || event.data.reason.kind !== 'completed') return
    const turn = event.data.turn
    const state = states.get(session) ?? { lastTurn: 0, tail: Promise.resolve() }
    if (turn <= state.lastTurn) return

    const controller = new AbortController()
    const run = state.tail.then(async () => {
      // Slice the turn's events from its turn/start.
      const events = session.events
      let startIndex = -1
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i]
        if (event?.type === 'turn/start' && event.data.turn === turn) {
          startIndex = i
          break
        }
      }
      if (startIndex < 0) return
      const turnEvents = events.slice(startIndex)
      const messages = turnEvents
        .map(event => session.deriveEventMessage?.(event) ?? null)
        .filter((message): message is Message => message !== null)
      if (messages.length === 0) return
      const facts = await extractFactsWithLlm(ctx, config, messages, session, controller.signal)
      const workspace = (session as { header?: { cwd?: string } }).header?.cwd
      await mergeFacts(store, facts, session.id, turn, config.maxFactsPerTurn, workspace)
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        ctx.logger?.warn?.('hippocampus extraction failed: %o', error)
      }
    })
    states.set(session, { lastTurn: turn, tail: run })
  })
}
