/**
 * dsh-hippocampus core types: the durable memory record shape.
 *
 * A record is one durable fact with layered scope (project-local or
 * user-global), provenance, tags, and access statistics used by ranking and
 * the global-layer LRU eviction.
 */

/** Where a memory record lives: project is workspace-local, user is host-global. */
export type MemoryScope = 'project' | 'user'

/** How a record was created. */
export type MemorySource =
  | { readonly kind: 'explicit' }
  | { readonly kind: 'auto' }
  | { readonly kind: 'session'; readonly sessionId: string; readonly turn: number }

/** One durable memory record, serialized as JSON on disk. */
export interface MemoryRecord {
  /** Stable uuid minted at create and never reused. */
  readonly id: string
  /** The remembered fact, one sentence or a short paragraph. */
  readonly text: string
  /** project is workspace-local; user is host-global. */
  readonly scope: MemoryScope
  /** Optional free-form tags for retrieval and grouping. */
  readonly tags: string[]
  /** How the record was created. */
  readonly source: MemorySource
  /** Unix epoch milliseconds at create. */
  readonly createdAt: number
  /** Unix epoch milliseconds at last mutation. */
  readonly updatedAt: number
  /** Recall count, used by ranking and the user-layer LRU eviction. */
  readonly accessCount: number
  /** Unix epoch milliseconds of the last recall hit, for LRU eviction. */
  readonly lastAccessedAt?: number
}

/** Input for creating or updating one record. */
export interface MemoryInput {
  /** The fact text. */
  readonly text: string
  /** Optional free-form tags. */
  readonly tags?: readonly string[]
}

/** A recall hit: the stored record plus its relevance score in [0, 1]. */
export interface MemoryRecallHit {
  readonly record: MemoryRecord
  readonly score: number
}

/** One appended entry in a session's recall log. */
export interface RecallLogEntry {
  /** The recalled record id. */
  readonly recordId: string
  /** Unix epoch milliseconds when the recall happened. */
  readonly time: number
  /** The query that produced the hit (trimmed; may be empty for blank queries). */
  readonly query?: string
}

/** A session's recall history aggregated by record. */
export interface SessionRecallAggregate {
  /** The recalled record. */
  readonly record: MemoryRecord
  /** How many times this record was recalled in the session. */
  readonly count: number
  /** Unix epoch milliseconds of the most recent recall. */
  readonly lastAt: number
}

/** Recall options. */
export interface RecallOptions {
  /** Restrict to one scope; when omitted, project is searched first, then user. */
  readonly scope?: MemoryScope
  /** Maximum hits returned; defaults to 5. */
  readonly limit?: number
}

/** A pluggable relevance ranker used by recall. */
export interface MemoryRanker {
  /**
   * Score one record against a normalized (lower-cased) query in [0, 1].
   * Higher is more relevant. The default keyword ranker is used when no
   * semantic ranker is installed.
   */
  score(record: MemoryRecord, query: string): number
  /**
   * Optional async refinement: a semantic ranker may compute a more accurate
   * score (e.g. embedding similarity) after the synchronous pass. Recall
   * calls it for shortlisted candidates when present.
   */
  refine?(record: MemoryRecord, query: string): Promise<number>
}

/** Persisted plugin configuration. */
export interface HippocampusConfig {
  /** Whether automatic extraction runs on completed turns. Defaults to true. */
  readonly autoExtract?: boolean
  /** Whether relevant memory is injected before each step. Defaults to true. */
  readonly autoInject?: boolean
  /** Whether semantic (embedding) ranking is enabled. Defaults to true. */
  readonly semanticRanking?: boolean
  /** Keyword weight in the hybrid score; semantic weight is 1 - keywordWeight. Defaults to 0.4. */
  readonly keywordWeight?: number
  /** HuggingFace model id for embedding. Defaults to Xenova/bge-small-zh-v1.5. */
  readonly embeddingModel?: string
  /** User-layer record cap; LRU eviction beyond it. Defaults to 200. */
  readonly maxUserRecords?: number
  /** Extraction output token cap. Defaults to 512. */
  readonly maxTokens?: number
  /** Extraction cooperative deadline in ms. Defaults to 30000. */
  readonly timeoutMs?: number
  /** Explicit extraction route; empty falls back to the session's routed model. */
  readonly extractionProvider?: string
  readonly extractionModel?: string
  /** User-layer root directory; defaults to ~/.dsh/hippocampus. */
  readonly memoryRoot?: string
}
