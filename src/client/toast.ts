/**
 * Maintain-completion toasts: a tiny module-level store plus an SSE listener
 * that turns a background "整理" job's completion into a transient toast.
 *
 * The store is deliberately dependency-free: a queue of toasts, subscribe /
 * dismiss primitives, and a module singleton that owns the EventSource to
 * /memory/api/events (the host SSE channel registered beside /memory/api).
 * The ToastHost component (registered into the ui-layout `shell.overlay`
 * slot) renders the queue and auto-dismisses entries.
 */

/** One audit-record entry surfaced in the toast detail. */
export interface MaintainToastEntry {
  /** The record's text (what was cleaned). */
  readonly text: string
  /** 'merged' when this entry is a merge product; 'removed' otherwise. */
  readonly kind: 'merged' | 'removed'
}

/** One toast message. */
export interface MaintainToast {
  readonly id: string
  readonly kind: 'done' | 'error'
  /** "记忆整理完成" style headline. */
  readonly title: string
  /** Detail line: removed/merged counts, or the error text. */
  readonly detail?: string
  /** Per-record detail (this job's audit), shown when the toast is expanded. */
  readonly entries?: readonly MaintainToastEntry[]
}

/** Localized strings (set once at plugin start from the bound locale). */
export interface ToastLabels {
  doneTitle: string
  errorTitle: string
  doneDetail: (removed: number) => string
}

type Listener = () => void

let queue: MaintainToast[] = []
const listeners = new Set<Listener>()
let labels: ToastLabels | null = null

/** Register locale strings; called from the plugin body before use. */
export function setToastLabels(next: ToastLabels): void {
  labels = next
}

/** Current toast queue (newest last). */
export function getToasts(): readonly MaintainToast[] {
  return queue
}

/** Subscribe to queue changes; returns an unsubscribe. */
export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function emit(): void {
  for (const listener of listeners) listener()
}

/** Drop one toast (manual close or auto-dismiss timer). */
export function dismissToast(id: string): void {
  const next = queue.filter(toast => toast.id !== id)
  if (next.length === queue.length) return
  queue = next
  emit()
}

/** Push a toast and schedule its auto-dismiss. */
export function pushToast(
  kind: MaintainToast['kind'],
  title: string,
  detail?: string,
  entries?: readonly MaintainToastEntry[],
): void {
  const toast: MaintainToast = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    title,
    detail,
    ...(entries === undefined || entries.length === 0 ? {} : { entries }),
  }
  queue = [...queue, toast]
  emit()
  // Auto-dismiss after a readable interval.
  setTimeout(() => { dismissToast(toast.id) }, 8000)
}

/** Flatten one job's audit entries into per-record detail rows. */
function entriesOf(audit: unknown): MaintainToastEntry[] | undefined {
  if (!Array.isArray(audit)) return undefined
  const rows: MaintainToastEntry[] = []
  for (const entry of audit) {
    if (entry === null || typeof entry !== 'object') continue
    const e = entry as { reason?: unknown; removed?: unknown }
    const isMerge = typeof e.reason === 'string' && e.reason.includes('merged')
    if (!Array.isArray(e.removed)) continue
    for (const item of e.removed) {
      if (item === null || typeof item !== 'object') continue
      const r = item as { text?: unknown }
      const text = typeof r.text === 'string' ? r.text : ''
      if (text.length > 0) rows.push({ text, kind: isMerge ? 'merged' : 'removed' })
    }
  }
  return rows.length > 0 ? rows : undefined
}

function handleEvent(event: MessageEvent): void {
  let payload: { type?: unknown; removed?: unknown; message?: unknown; audit?: unknown } | null = null
  const data = typeof event.data === 'string' ? event.data : ''
  try {
    payload = JSON.parse(data) as { type?: unknown; removed?: unknown; message?: unknown; audit?: unknown }
  } catch {
    return // Keep-alive or non-JSON frames are ignored.
  }
  if (payload === null || typeof payload !== 'object') return
  if (payload.type === 'maintain/done') {
    const removed = typeof payload.removed === 'number' ? payload.removed : 0
    const entries = entriesOf(payload.audit)
    pushToast('done', labels?.doneTitle ?? '记忆整理完成', labels === null ? undefined : labels.doneDetail(removed), entries)
  } else if (payload.type === 'maintain/error') {
    const message = typeof payload.message === 'string' ? payload.message : undefined
    pushToast('error', labels?.errorTitle ?? '记忆整理失败', message)
  }
}

let source: EventSource | null = null
let started = false

/** Open the SSE channel once; safe to call repeatedly. */
export function startMaintainEvents(): void {
  if (started) return
  started = true
  // Reconnect is automatic per the EventSource spec; the host stream keeps
  // the response open and pushes one JSON frame per finished job.
  source = new EventSource('/memory/api/events')
  source.addEventListener('message', handleEvent)
}
