import { Context } from "@deepseek-ai/cordis";
//#region src/types.d.ts
/** Persisted plugin configuration. */
interface HippocampusConfig {
  /** Whether automatic extraction runs on completed turns. Defaults to true. */
  readonly autoExtract?: boolean;
  /** Whether relevant memory is injected before each step. Defaults to true. */
  readonly autoInject?: boolean;
  /** Whether semantic (embedding) ranking is enabled. Defaults to true. */
  readonly semanticRanking?: boolean;
  /** Keyword weight in the hybrid score; semantic weight is 1 - keywordWeight. Defaults to 0.4. */
  readonly keywordWeight?: number;
  /** HuggingFace model id for embedding. Defaults to Xenova/bge-small-zh-v1.5. */
  readonly embeddingModel?: string;
  /** User-layer record cap; LRU eviction beyond it. Defaults to 200. */
  readonly maxUserRecords?: number;
  /** Extraction output token cap. Defaults to 512. */
  readonly maxTokens?: number;
  /** Extraction cooperative deadline in ms. Defaults to 30000. */
  readonly timeoutMs?: number;
  /** Explicit extraction route; empty falls back to the session's routed model. */
  readonly extractionProvider?: string;
  readonly extractionModel?: string;
  /** User-layer root directory; defaults to ~/.dsh/hippocampus. */
  readonly memoryRoot?: string;
}
//#endregion
//#region src/index.d.ts
/** Stable Cordis plugin name; must match the cordis.patch.yml row id. */
declare const name = "dsh-hippocampus";
/** Services required before mounting. */
declare const inject: string[];
/** Resolve and validate plugin configuration. */
declare function resolveConfig(config?: HippocampusConfig): Required<Pick<HippocampusConfig, 'autoExtract' | 'autoInject' | 'semanticRanking' | 'keywordWeight' | 'embeddingModel' | 'maxUserRecords' | 'maxTokens' | 'timeoutMs'>> & {
  maxFactsPerTurn: number;
  extractionProvider?: string;
  extractionModel?: string;
};
/** Register the hippocampus plugin. */
declare function apply(ctx: Context, config?: HippocampusConfig): void;
//#endregion
export { apply, inject, name, resolveConfig };