/**
 * dsh-hippocampus semantic ranker: hybrid keyword + embedding relevance.
 *
 * Uses @xenova/transformers with a local ONNX embedding model (default
 * Xenova/bge-small-zh-v1.5, 512-dim, Chinese + English). The model is loaded
 * lazily on first use and cached; record vectors are cached in memory so
 * repeated recalls do not re-embed stored facts. Falls back to pure keyword
 * scoring when the model is unavailable (offline, first-load failure).
 */

import type { MemoryRanker, MemoryRecord } from './types.ts'
import { keywordScore } from './store.ts'

/** Default embedding model: bge-small-zh-v1.5, 512-dim, Chinese + English. */
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/bge-small-zh-v1.5'

/** A text-to-vector extractor. */
export interface TextEmbedder {
  embed(text: string): Promise<number[]>
}

/** Lazy model loader: builds the embedder on first call, then caches it. */
export class LazyEmbedder implements TextEmbedder {
  private instance: TextEmbedder | undefined
  private loading: Promise<TextEmbedder> | undefined

  constructor(private readonly modelId: string) {}

  /** Load (once) and return the embedder; never throws — returns a failing embedder on error. */
  private async load(): Promise<TextEmbedder> {
    if (this.instance !== undefined) return this.instance
    if (this.loading === undefined) {
      this.loading = this.build().catch(() => new FailingEmbedder())
    }
    this.instance = await this.loading
    return this.instance
  }

  private async build(): Promise<TextEmbedder> {
    const { pipeline } = await import('@xenova/transformers')
    const extractor = await pipeline('feature-extraction', this.modelId, { dtype: 'q8' } as never)
    return {
      async embed(text: string): Promise<number[]> {
        const out = await extractor(text, { pooling: 'mean', normalize: true })
        return Array.from(out.data as Float32Array)
      },
    }
  }

  async embed(text: string): Promise<number[]> {
    return (await this.load()).embed(text)
  }
}

/** Embedder that always fails; used when the model cannot load. */
class FailingEmbedder implements TextEmbedder {
  async embed(): Promise<number[]> {
    throw new Error('embedding model unavailable')
  }
}

/** Cosine similarity between two equal-length vectors in [0, 1]. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i] ?? 0
    const bi = b[i] ?? 0
    dot += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/** Semantic ranker options. */
export interface SemanticRankerOptions {
  /**
   * Keyword weight used when the query has keyword overlap with the record;
   * semantic weight is 1 - keywordHitWeight. Defaults to 0.7 (trust literal
   * matches). Kept for backward compatibility; prefer the adaptive weights.
   */
  readonly keywordWeight?: number
  /**
   * Keyword weight when the query has NO keyword overlap. The semantic score
   * dominates; defaults to 0.4.
   */
  readonly keywordMissWeight?: number
  /**
   * Minimum semantic similarity for a zero-keyword-overlap record to qualify.
   * Filters embedding baseline noise. Defaults to 0.45.
   */
  readonly semanticThreshold?: number
  /** Embedding model id. */
  readonly modelId?: string
  /** Whether the model may be loaded at all. */
  readonly enabled?: boolean
  /**
   * Test seam: an embedder to use instead of the lazy model-backed one.
   * Production callers never set this; tests inject a fake to verify the
   * hybrid/cache logic without downloading a model.
   */
  readonly embedder?: TextEmbedder
}

/** Hybrid keyword + semantic ranker implementing MemoryRanker. */
export class SemanticRanker implements MemoryRanker {
  private readonly keywordHitWeight: number
  private readonly keywordMissWeight: number
  private readonly semanticThreshold: number
  private readonly enabled: boolean
  private readonly embedder: TextEmbedder
  /** Record id -> cached embedding vector. */
  private readonly vectorCache = new Map<string, number[]>()
  /** Query vector cache (per normalized query). */
  private readonly queryCache = new Map<string, number[]>()

  constructor(options: SemanticRankerOptions = {}) {
    // keywordWeight (legacy) maps to the hit weight so existing configs
    // keep their meaning.
    this.keywordHitWeight = options.keywordWeight ?? 0.7
    this.keywordMissWeight = options.keywordMissWeight ?? 0.4
    this.semanticThreshold = options.semanticThreshold ?? 0.45
    this.enabled = options.enabled ?? true
    this.embedder = options.embedder ?? new LazyEmbedder(options.modelId ?? DEFAULT_EMBEDDING_MODEL)
  }

  /** Hybrid score with adaptive weights and a semantic floor. */
  private hybrid(keyword: number, semantic: number): number {
    if (keyword > 0) {
      return this.keywordHitWeight * keyword + (1 - this.keywordHitWeight) * semantic
    }
    if (semantic < this.semanticThreshold) return 0
    return (1 - this.keywordMissWeight) * semantic
  }

  /** Semantic score for one record, using its cached vector or computing on demand. */
  private async semanticScore(record: MemoryRecord, query: string): Promise<number> {
    if (!this.enabled) return 0
    try {
      let recordVec = this.vectorCache.get(record.id)
      if (recordVec === undefined) {
        recordVec = await this.embedder.embed(record.text)
        this.vectorCache.set(record.id, recordVec)
      }
      let queryVec = this.queryCache.get(query)
      if (queryVec === undefined) {
        queryVec = await this.embedder.embed(query)
        this.queryCache.set(query, queryVec)
      }
      return cosineSimilarity(recordVec, queryVec)
    } catch {
      return 0
    }
  }

  /**
   * Synchronous MemoryRanker.score: keyword score immediately, then add the
   * semantic score when its cached vector is available. The async semantic
   * refinement happens in `recall` via {@link refineScores}.
   */
  score(record: MemoryRecord, query: string): number {
    const keyword = keywordScore(record, query)
    if (!this.enabled) return keyword
    const cached = this.vectorCache.get(record.id)
    if (cached === undefined) return keyword
    const queryVec = this.queryCache.get(query)
    if (queryVec === undefined) return keyword
    const semantic = cosineSimilarity(cached, queryVec)
    return this.hybrid(keyword, semantic)
  }

  /**
   * Async refinement: compute the semantic score for one record+query pair
   * and return the hybrid score. Used by recall after the synchronous pass.
   */
  async refine(record: MemoryRecord, query: string): Promise<number> {
    if (!this.enabled) return keywordScore(record, query)
    const keyword = keywordScore(record, query)
    const semantic = await this.semanticScore(record, query)
    return this.hybrid(keyword, semantic)
  }
}
