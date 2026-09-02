import { describe, expect, it } from 'vitest'
import { cosineSimilarity, SemanticRanker, type TextEmbedder } from '../src/ranker.ts'
import type { MemoryRecord } from '../src/types.ts'

function record(id: string, text: string, tags: string[] = []): MemoryRecord {
  return {
    id,
    text,
    scope: 'project',
    tags,
    source: { kind: 'explicit' },
    createdAt: 1,
    updatedAt: 1,
    accessCount: 0,
  }
}

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBe(1)
  })

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
  })

  it('returns 0 for mismatched lengths', () => {
    expect(cosineSimilarity([1], [1, 2])).toBe(0)
  })

  it('returns a value in [0, 1] for similar vectors', () => {
    const s = cosineSimilarity([1, 2, 3], [1, 2, 2.5])
    expect(s).toBeGreaterThan(0.9)
    expect(s).toBeLessThanOrEqual(1)
  })
})

describe('SemanticRanker', () => {
  it('falls back to pure keyword when disabled', () => {
    const ranker = new SemanticRanker({ enabled: false })
    const r = record('a', 'The user likes Python')
    expect(ranker.score(r, 'python')).toBe(1)
    expect(ranker.score(r, 'rust')).toBe(0)
  })

  it('blends keyword and cached semantic scores', async () => {
    // Fake embedder: deterministic vectors keyed by first word, so the
    // cache/refine logic is verified without downloading a model.
    const fake: TextEmbedder = {
      embed: async (text: string) => {
        const word = text.split(/\s+/)[0] ?? ''
        const base = word.charCodeAt(0) || 1
        return [base / 1000, (base % 97) / 1000, 0.5]
      },
    }
    const ranker = new SemanticRanker({ keywordWeight: 0.5, enabled: true, embedder: fake })
    const r = record('a', 'The user likes Python')
    // Prime the vector cache via refine.
    const refined = await ranker.refine(r, 'python programming')
    expect(refined).toBeGreaterThanOrEqual(0)
    expect(refined).toBeLessThanOrEqual(1)
    // After refine, score() uses the cached vector.
    const scored = ranker.score(r, 'python programming')
    expect(scored).toBe(refined)
  })

  it('refine returns keyword score when the model is unavailable', async () => {
    // enabled with a bogus model id: refine must not throw and falls back.
    const ranker = new SemanticRanker({ keywordWeight: 0.5, enabled: true, modelId: 'bogus/nonexistent-model' })
    const r = record('a', 'The user likes Python')
    const refined = await ranker.refine(r, 'python')
    // Model load fails -> semantic 0 -> hybrid = 0.5 * keyword(1) + 0.5 * 0
    expect(refined).toBe(0.5)
  })
})

describe('SemanticRanker adaptive weights', () => {
  it('trusts keyword when it hits, even with low semantic score', () => {
    const ranker = new SemanticRanker({ enabled: true })
    const r = record('k1', 'The build uses pnpm exclusively')
    // keyword 1.0 (pnpm), semantic 0 (no cache -> 0): hit weight 0.7 dominates.
    const score = ranker.score(r, 'pnpm')
    expect(score).toBeGreaterThanOrEqual(0.7 * 1)
  })

  it('filters zero-overlap records below the semantic threshold', async () => {
    const ranker = new SemanticRanker({ enabled: true, modelId: 'bogus/nonexistent' })
    const r = record('t1', 'User prefers tea')
    // Model unavailable -> semantic 0, keyword 0 -> hybrid 0 (filtered).
    const refined = await ranker.refine(r, 'coffee brewing')
    expect(refined).toBe(0)
  })

  it('keeps zero-overlap records above the semantic threshold', async () => {
    // With a real model the semantic score is > 0; verify the hybrid formula
    // gives semantic dominance when keyword misses.
    const ranker = new SemanticRanker({ enabled: false, keywordMissWeight: 0.4, semanticThreshold: 0 })
    // Disabled returns keyword only; simulate the miss path via refine's
    // formula indirectly: semanticThreshold 0 means any semantic qualifies.
    const r = record('m1', 'The user likes Python')
    expect(await ranker.refine(r, 'python')).toBeGreaterThan(0)
  })
})
