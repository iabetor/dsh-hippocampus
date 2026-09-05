/**
 * Session memory panel: the current session's project memory plus the
 * records the model actually recalled (injected) in this session.
 *
 * "Recent recalls" is a scrollable list capped at 20 aggregated records,
 * so scrolling through it never pushes the project-memory section off the
 * panel. Global (user-scope) memory is managed in the Settings page and only
 * surfaces here when it was actually recalled by the model.
 */
import { h, useEffect, useState } from './react.ts'
import type { MemoryRecallView, MemoryRecordView } from './api.ts'
import { fetchRecalls, listRecords } from './api.ts'
import css from './hippocampus.module.css'

/** Props injected by the conversation.view slot. */
export interface SessionPanelInjected {
  sessionId: string
  /** Bound locale function. */
  t: (key: string, params?: Record<string, unknown>) => string
}

/** Compact relative-time label ("3 min ago" / "2 d ago"); falls back to empty. */
function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return ''
  if (min < 60) return `${min} min`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} h`
  return `${Math.floor(hour / 24)} d`
}

/** One record row: a left color bar (type) + text with optional recall meta. */
function RecordRow({
  record, t, meta, bar,
}: {
  record: MemoryRecordView
  t: SessionPanelInjected['t']
  meta?: { count: number; lastAt: number }
  /** Which color bar to paint on the left edge. */
  bar: 'recall' | 'project'
}) {
  const now = Date.now()
  const timeLabel = meta === undefined ? '' : relativeTime(meta.lastAt, now)
  return h('div', { className: `${css.recordRow} ${bar === 'recall' ? css.barRecall : css.barProject}` },
    h('div', { className: css.recordBody },
      h('span', { className: css.recordText }, record.text),
      meta !== undefined && h('div', { className: css.recordMeta },
        h('span', null, `${t('session.recalled', { count: meta.count })}`),
        timeLabel !== '' && h('span', { className: css.metaTime }, timeLabel),
      ),
    ),
  )
}

/** The session memory panel body. */
export function SessionPanel({ sessionId, t }: SessionPanelInjected): ReturnType<typeof h> {
  const [project, setProject] = useState<MemoryRecordView[] | null>(null)
  const [recalls, setRecalls] = useState<MemoryRecallView[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    Promise.all([
      listRecords(sessionId, 'project').catch(() => ({ records: [] })),
      fetchRecalls(sessionId, 20).catch(() => ({ items: [] })),
    ]).then(([p, r]) => {
      if (cancelled) return
      setProject(p.records)
      setRecalls(r.items)
    }).catch(() => {
      if (!cancelled) setError(t('session.error'))
    })
    return () => { cancelled = true }
  }, [sessionId])

  const root = { className: css.root, 'data-hippocampus-view': '', 'data-conversation-composer-overlay': '' }

  if (error !== null) {
    return h('div', { ...root, style: { color: '#c00' } }, error)
  }
  if (project === null || recalls === null) {
    return h('div', { ...root, style: { color: '#888' } }, t('session.loading'))
  }

  const empty = project.length === 0 && recalls.length === 0
  const totalRecallCount = recalls.reduce((sum, item) => sum + item.recallCount, 0)

  return h('div', { ...root },
    // Legend: explains the two left-bar colors at a glance.
    h('div', { className: css.legend },
      h('span', { className: css.legendItem },
        h('i', { className: `${css.legendSwatch} ${css.legendRecall}` }),
        t('session.recent'),
      ),
      h('span', { className: css.legendItem },
        h('i', { className: `${css.legendSwatch} ${css.legendProject}` }),
        t('session.project'),
      ),
    ),
    // Two columns side by side: recent recalls and project memory each get
    // their own scrollable list, so neither pushes the other off the panel.
    h('div', { className: css.columns },
      // Recent recalls: what the model actually used in this session.
      h('div', { className: `${css.section} ${css.column}` },
        h('div', { className: css.sectionTitle },
          t('session.recent'),
          totalRecallCount > 0 && h('span', { className: css.sectionCount }, String(totalRecallCount)),
        ),
        recalls.length === 0
          ? h('div', { className: css.emptyHint }, t('session.noRecalls'))
          : h('div', { className: `${css.recallList} ${css.columnList}` },
            recalls.map(item => h(RecordRow, {
              key: item.id, record: item, t, bar: 'recall',
              meta: { count: item.recallCount, lastAt: item.lastRecalledAt },
            })),
          ),
      ),
      // Project memory: the workspace's own facts, side by side with recalls.
      // (User-scope memory lives in the Settings page, not here.)
      h('div', { className: `${css.section} ${css.column}` },
        h('div', { className: css.sectionTitle },
          t('session.project'),
          project.length > 0 && h('span', { className: css.sectionCount }, String(project.length)),
        ),
        project.length === 0
          ? h('div', { className: css.emptyHint }, t('session.empty'))
          : h('div', { className: `${css.projectList} ${css.columnList}` },
            project.map(record => h(RecordRow, { key: record.id, record, t, bar: 'project' })),
          ),
      ),
    ),
    empty && h('div', { className: css.emptyState }, t('session.emptyAll')),
  )
}
