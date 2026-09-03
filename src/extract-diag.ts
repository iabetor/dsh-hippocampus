/**
 * Extraction diagnostics: an append-only JSONL trace of every automatic
 * extraction attempt, written to the user-layer hipp root so failures that
 * would otherwise be swallowed (the extraction listener logs via
 * `ctx.logger.warn`, which only reaches the host terminal) become visible
 * on disk. Best-effort: a write failure never breaks extraction.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** One diagnostic line. */
export interface ExtractDiagEntry {
  /** Wall-clock ms. */
  time: number
  /** What happened: 'event' | 'filtered' | 'skipped' | 'no-start' | 'no-messages'
   * | 'llm-start' | 'llm-ok' | 'llm-error' | 'merged'. */
  kind: string
  /** Session id, when known. */
  sessionId?: string
  /** Turn number, when known. */
  turn?: number
  /** Reason kind from the turn/end event. */
  reason?: string
  /** Extra detail (message count, facts count, error text). */
  detail?: string
}

/** Resolve the diag log path (fixed user-layer location). */
export function extractDiagPath(): string {
  return resolve(join(homedir(), '.dsh', 'hippocampus', 'extract.log'))
}

/** Append one diag entry; never throws. */
export async function traceExtract(entry: ExtractDiagEntry): Promise<void> {
  try {
    const path = extractDiagPath()
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // Best-effort diagnostics: never break extraction.
  }
}
