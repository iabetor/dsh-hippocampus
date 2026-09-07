/**
 * dsh-hippocampus — durable cross-session memory plugin for DeepSeek Harness.
 *
 * A host-side Cordis plugin: layered project/user stores (per-record JSON),
 * model-facing remember/recall/forget tools, and automatic extraction on
 * completed turns. Zero upstream modification: everything rides public
 * harness interfaces (ctx.tools, ctx.systemPrompt, ctx.on('session/event'),
 * ctx.llm).
 */

import type { Context } from '@deepseek-ai/cordis'
// Side-effect type imports: declaration-merge the injected services.
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { HippocampusConfig } from './types.ts'
import { MemoryStore } from './store.ts'
import { registerMemoryTools, type MemoryPluginContext } from './tools.ts'
import { registerAutoExtract } from './extract.ts'
import { registerAutoInject } from './inject.ts'
import { DEFAULT_EMBEDDING_MODEL, SemanticRanker } from './ranker.ts'
import { registerMemoryApi, type MemoryApiContext } from './api.ts'
import { runLlmReview, runRuleSweep } from './maintenance.ts'

/** Stable Cordis plugin name; must match the cordis.patch.yml row id. */
export const name = 'dsh-hippocampus'

/** Services required before mounting. */
export const inject = ['sessions', 'tools', 'systemPrompt', 'llm']

const DEFAULT_MAX_USER_RECORDS = 200
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_FACTS_PER_TURN = 5

/** Resolve and validate plugin configuration. */
export function resolveConfig(config: HippocampusConfig = {}): Required<Pick<
  HippocampusConfig,
  'autoExtract' | 'autoInject' | 'semanticRanking' | 'keywordWeight' | 'embeddingModel' | 'maxUserRecords' | 'timeoutMs'
>> & { maxTokens?: number; maxFactsPerTurn: number; extractionProvider?: string; extractionModel?: string } {
  const maxUserRecords = config.maxUserRecords ?? DEFAULT_MAX_USER_RECORDS
  // Undefined means "use the routed model's own default output cap": the llm
  // service fills config.maxTokens from the model's advertised default when
  // the caller leaves it unset. A fixed default (512) truncated verbose
  // turn summaries and silently killed auto-extraction, so no hard default.
  const maxTokens = config.maxTokens
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const keywordWeight = config.keywordWeight ?? 0.4
  if (keywordWeight < 0 || keywordWeight > 1 || !Number.isFinite(keywordWeight)) {
    throw new TypeError('hippocampus: keywordWeight must be in [0, 1]')
  }
  if (!Number.isSafeInteger(maxUserRecords) || maxUserRecords < 1) {
    throw new TypeError('hippocampus: maxUserRecords must be a positive safe integer')
  }
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) {
    throw new TypeError('hippocampus: maxTokens must be a positive safe integer when set')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('hippocampus: timeoutMs must be a positive safe integer')
  }
  return {
    autoExtract: config.autoExtract ?? true,
    autoInject: config.autoInject ?? true,
    semanticRanking: config.semanticRanking ?? true,
    keywordWeight,
    embeddingModel: config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
    maxUserRecords,
    timeoutMs,
    maxFactsPerTurn: DEFAULT_MAX_FACTS_PER_TURN,
    ...maxTokens === undefined ? {} : { maxTokens },
    ...config.extractionProvider === undefined ? {} : { extractionProvider: config.extractionProvider },
    ...config.extractionModel === undefined ? {} : { extractionModel: config.extractionModel },
  }
}

/** Register the hippocampus plugin. */
export function apply(ctx: Context, config: HippocampusConfig = {}): void {
  const resolved = resolveConfig(config)
  const pluginCtx = ctx as MemoryPluginContext

  // One store per plugin instance: the project layer resolves its root per
  // operation from the executing session's workspace (see MemoryStore),
  // while the user layer is a fixed host-global root.
  const store = new MemoryStore(resolved.maxUserRecords, config.memoryRoot)
  void store.ensure().catch(error => {
    ctx.logger?.warn?.('hippocampus: store init failed: %o', error)
  })

  // Semantic ranking (embedding) is the default; the model loads lazily on
  // first recall and falls back to pure keyword scoring when unavailable.
  if (resolved.semanticRanking) {
    store.setRanker(new SemanticRanker({
      keywordWeight: resolved.keywordWeight,
      modelId: resolved.embeddingModel,
    }))
  }

  // Model-facing tools + guidance.
  registerMemoryTools(pluginCtx, store, config.memoryRoot)

  // Automatic extraction on completed turns.
  if (resolved.autoExtract) {
    registerAutoExtract(ctx, store, {
      maxTokens: resolved.maxTokens,
      timeoutMs: resolved.timeoutMs,
      maxFactsPerTurn: resolved.maxFactsPerTurn,
      ...resolved.extractionProvider === undefined ? {} : { provider: resolved.extractionProvider },
      ...resolved.extractionModel === undefined ? {} : { model: resolved.extractionModel },
    })
  }

  // Automatic injection: recall relevant memory before each step.
  if (resolved.autoInject) {
    registerAutoInject(ctx, store, { limit: 3 })
  }

  // Browser JSON API for the memory panels (conversation view + settings).
  // webServer/webRuntime are optional (headless and SDK profiles may not
  // mount the web surface) and may register after this plugin activates, so
  // defer the API registration to a conditional inject that waits for both.
  // workspaceRegistry resolves the authoritative session→workspace path
  // (canonical-cwd index); sessionPersistence covers subagent children and
  // restored sessions the registry never accounted. agentDefaultModel + llm
  // back the manual "tidy" LLM review (present in web profiles).
  ctx.inject(['webServer', 'webRuntime', 'workspaceRegistry', 'sessionPersistence', 'agentDefaultModel', 'llm'], (apiCtx) => {
    registerMemoryApi(apiCtx as MemoryApiContext, store, config.memoryRoot)
  })

  // Maintenance timers (when the timer service is present; headless may omit):
  // 1. Rule sweep every 5 minutes — cheap, removes stale auto-extracted
  //    records never recalled within STALE_DAYS.
  // 2. Full LLM curation hourly — every record is reviewed by the routed
  //    model for duplicates/contradictions/transients; deletions are
  //    audited and pushed to the notification center (thalamus) when mounted.
  const timer = ctx.get?.('timer') as { interval(callback: () => void, delay: number): () => void } | undefined
  if (timer !== undefined) {
    const registryOf = (): readonly { readonly path: string }[] =>
      (ctx.get?.('workspaceRegistry') as
        | { list(): readonly { readonly path: string }[] }
        | undefined)?.list() ?? []
    const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

    // 1. Rule sweep (5 min).
    const sweep = async (): Promise<void> => {
      await runRuleSweep(store, registryOf(), config.memoryRoot)
    }
    void (async () => {
      await delay(5_000)
      await sweep()
    })()
    timer.interval(() => { void sweep() }, 5 * 60 * 1000)

    // 2. Full LLM curation (hourly). Waits for the llm services (present in
    //    profiles with a model route) and the optional notification service.
    ctx.inject?.(['llm', 'agentDefaultModel'], (llmCtx) => {
      const curate = async (): Promise<void> => {
        try {
          const result = await runLlmReview(llmCtx as never, store, registryOf(), config.memoryRoot)
          const removed = result.removed
          if (removed.length === 0 && result.conflicts.length === 0) return
          const service = ctx.get?.('notifications') as
            | { push(input: unknown): Promise<unknown> }
            | undefined
          if (service !== undefined) {
            const conflictNote = result.conflicts.length > 0
              ? `；另有 ${result.conflicts.length} 组 explicit 记忆冲突待确认`
              : ''
            await service.push({
              source: 'hippocampus',
              kind: 'info',
              title: '记忆定时整理',
              detail: removed.length > 0
                ? `自动清理 ${removed.length} 条过时/重复记忆${conflictNote}`
                : `未发现需清理的记忆${conflictNote}`,
              preview: {
                name: 'memory-cleanup.md',
                text: `## 定时整理（自动）\n\n${removed.map((r: { scope: string; text: string }) => `- [${r.scope === 'user' ? '全局' : '项目'}] ${r.text.slice(0, 100)}`).join('\n')}${conflictNote}`,
                language: 'md',
              },
            })
          }
        } catch (error) {
          ctx.logger?.warn?.('hippocampus hourly curation failed: %o', error)
        }
      }
      void (async () => {
        await delay(60_000) // first run one minute after boot, then hourly
        await curate()
      })()
      timer.interval(() => { void curate() }, 60 * 60 * 1000)
    })
  }
}
