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
import { runRuleSweep } from './maintenance.ts'

/** Stable Cordis plugin name; must match the cordis.patch.yml row id. */
export const name = 'dsh-hippocampus'

/** Services required before mounting. */
export const inject = ['sessions', 'tools', 'systemPrompt', 'llm']

const DEFAULT_MAX_USER_RECORDS = 200
const DEFAULT_MAX_TOKENS = 512
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_FACTS_PER_TURN = 5

/** Resolve and validate plugin configuration. */
export function resolveConfig(config: HippocampusConfig = {}): Required<Pick<
  HippocampusConfig,
  'autoExtract' | 'autoInject' | 'semanticRanking' | 'keywordWeight' | 'embeddingModel' | 'maxUserRecords' | 'maxTokens' | 'timeoutMs'
>> & { maxFactsPerTurn: number; extractionProvider?: string; extractionModel?: string } {
  const maxUserRecords = config.maxUserRecords ?? DEFAULT_MAX_USER_RECORDS
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const keywordWeight = config.keywordWeight ?? 0.4
  if (keywordWeight < 0 || keywordWeight > 1 || !Number.isFinite(keywordWeight)) {
    throw new TypeError('hippocampus: keywordWeight must be in [0, 1]')
  }
  if (!Number.isSafeInteger(maxUserRecords) || maxUserRecords < 1) {
    throw new TypeError('hippocampus: maxUserRecords must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new TypeError('hippocampus: maxTokens must be a positive safe integer')
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
    maxTokens,
    timeoutMs,
    maxFactsPerTurn: DEFAULT_MAX_FACTS_PER_TURN,
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

  // Maintenance timer: rule-based sweep of stale auto-extracted records,
  // with an audit trail. Runs every MAINTENANCE_INTERVAL_MS when the timer
  // service is present (headless profiles may omit it); the manual trigger
  // rides the settings panel button through the memory API.
  const timer = ctx.get?.('timer') as { interval(callback: () => void, delay: number): () => void } | undefined
  if (timer !== undefined) {
    const sweep = async (): Promise<void> => {
      const registry = ctx.get?.('workspaceRegistry') as
        | { list(): readonly { readonly path: string }[] }
        | undefined
      const workspaces = registry?.list() ?? []
      await runRuleSweep(store, workspaces, config.memoryRoot)
    }
    // Run once shortly after boot, then on the interval.
    const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
    void (async () => {
      await delay(5_000)
      await sweep()
    })()
    timer.interval(() => { void sweep() }, 5 * 60 * 1000)
  }
}
