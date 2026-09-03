/**
 * Toast host: renders the maintain-completion toasts into the ui-layout
 * `shell.overlay` slot — the frame-wide floating layer reserved for toasts
 * and badges. Registers once at plugin start; the queue lives in toast.ts.
 */

import { h, useEffect, useState } from './react.ts'
import { dismissToast, getToasts, subscribeToasts, type MaintainToast, type MaintainToastEntry } from './toast.ts'
import css from './hippocampus.module.css'

/** Props injected by the shell.overlay slot (empty for this host). */
export interface ToastHostProps {
  [key: string]: unknown
}

function EntryRow({ entry }: { entry: MaintainToastEntry }): ReturnType<typeof h> {
  const cls = entry.kind === 'merged' ? css.toastEntryMerged : css.toastEntryRemoved
  const tag = entry.kind === 'merged' ? '合并' : '删除'
  return h('div', { className: `${css.toastEntry} ${cls}` },
    h('span', { className: css.toastEntryTag }, tag),
    h('span', { className: css.toastEntryText }, entry.text),
  )
}

function ToastRow({ toast }: { toast: MaintainToast }): ReturnType<typeof h> {
  const kindClass = toast.kind === 'error' ? css.toastError : css.toastDone
  const [expanded, setExpanded] = useState(false)
  const expandable = (toast.entries?.length ?? 0) > 0
  const toggle = (): void => {
    if (expandable) setExpanded(value => !value)
  }
  return h('div', {
    className: `${css.toast} ${kindClass} ${expandable ? css.toastExpandable : ''}`,
    role: toast.kind === 'error' ? 'alert' : 'status',
    onClick: toggle,
    title: expandable ? (expanded ? '点击收起' : '点击查看清理详情') : undefined,
  },
    h('div', { className: css.toastBody },
      h('div', { className: css.toastTitle }, toast.title),
      toast.detail !== undefined && h('div', { className: css.toastDetail }, toast.detail),
      expanded && toast.entries !== undefined && h('div', { className: css.toastEntries },
        ...toast.entries.map(entry => h(EntryRow, { key: entry.text, entry })),
      ),
      expandable && !expanded && h('div', { className: css.toastHint }, '点击查看详情'),
    ),
    h('button', {
      type: 'button',
      className: css.toastClose,
      onClick: (event: { stopPropagation(): void }) => {
        event.stopPropagation()
        dismissToast(toast.id)
      },
      'aria-label': '关闭',
    }, '×'),
  )
}

/** The overlay host: one registered instance per shell. */
export function ToastHost(_props: ToastHostProps): ReturnType<typeof h> | null {
  const [toasts, setToasts] = useState<readonly MaintainToast[]>(getToasts)

  useEffect(() => {
    const sync = (): void => { setToasts(getToasts()) }
    return subscribeToasts(sync)
  }, [])

  if (toasts.length === 0) return null
  return h('div', { className: css.toastStack },
    ...toasts.map(toast => h(ToastRow, { key: toast.id, toast })),
  )
}
