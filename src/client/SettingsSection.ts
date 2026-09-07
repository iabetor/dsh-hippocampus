/**
 * Settings memory-management section: user-global memory first, then one
 * block per workspace's project memory. Search, delete, and counts included.
 * Rendered as a `settings.section` page by the client plugin.
 */

import { h, useCallback, useEffect, useState } from './react.ts'
import type { MemoryAuditEntry, MemoryGroups, MemoryHitView, MemoryRecordView, MemoryWorkspaceGroup } from './api.ts'
import { deleteRecord, fetchAudit, fetchGroups, restoreRecord, runMaintenance, searchMemory } from './api.ts'
import css from './hippocampus.module.css'

/** Props injected by the settings.section slot. */
export interface SettingsSectionInjected {
  /** The settings panel passes the current session id for workspace scoping. */
  sessionId: string
  /** Explicit current workspace path (root-scope panels have no session; resolved client-side). */
  workspace?: string
  /** Bound locale function. */
  t: (key: string, params?: Record<string, unknown>) => string
}

/** One record row with a left color bar and a hover-only delete button. */
function RecordRow({ record, onDelete, t }: {
  record: MemoryRecordView
  onDelete: (id: string) => void
  t: SettingsSectionInjected['t']
}) {
  return h('div', {
    className: `${css.settingsRow} ${record.scope === 'user' ? css.settingsRowUser : css.settingsRowProject}`,
  },
    h('div', { className: css.settingsRowBody },
      h('div', { className: css.settingsRowText }, record.text),
    ),
    h('button', {
      type: 'button',
      className: css.deleteBtn,
      onClick: () => {
        const confirm = (globalThis as { confirm?: (msg: string) => boolean }).confirm
        if (confirm?.(t('settings.confirmDelete'))) onDelete(record.id)
      },
    }, t('settings.delete')),
  )
}

/** One group block: a collapsible heading (count pill) plus its record rows. */
function GroupBlock({ title, countLabel, records, onDelete, t, defaultOpen }: {
  title: string
  countLabel?: string
  records: MemoryRecordView[]
  onDelete: (id: string) => void
  t: SettingsSectionInjected['t']
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  if (records.length === 0) return null
  return h('div', { className: css.settingsGroup },
    h('button', {
      type: 'button',
      className: css.settingsGroupHead,
      onClick: () => setOpen(value => !value),
      'aria-expanded': open ? 'true' : 'false',
    },
      h('span', { className: `${css.chevron} ${open ? css.chevronOpen : ''}` }, '▸'),
      h('span', { className: css.settingsGroupTitle }, title),
      countLabel !== undefined
        ? h('span', { className: css.settingsGroupCount }, countLabel)
        : h('span', { className: css.settingsGroupCount }, String(records.length)),
    ),
    open && h('div', { className: css.settingsGroupBody },
      ...records.map(record => h(RecordRow, { key: record.id, record, onDelete, t })),
    ),
  )
}

/** The settings memory-management section body. */
export function SettingsSection({ sessionId, workspace, t }: SettingsSectionInjected): ReturnType<typeof h> {
  const [groups, setGroups] = useState<MemoryGroups | null>(null)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<MemoryRecordView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [maintaining, setMaintaining] = useState(false)
  const [maintainStarted, setMaintainStarted] = useState(false)
  const [showAudit, setShowAudit] = useState(false)
  const [audit, setAudit] = useState<MemoryAuditEntry[] | null>(null)

  const loadAudit = useCallback(async () => {
    try {
      const result = await fetchAudit(sessionId)
      setAudit(result.audit)
    } catch {
      // Audit read is best-effort.
    }
  }, [sessionId])

  const load = useCallback(async (search: string) => {
    setError(null)
    try {
      if (search.trim() === '') {
        const g = await fetchGroups(sessionId)
        setGroups(g)
        setSearchResults(null)
      } else {
        const hits = await searchMemory(sessionId, search, 50, workspace)
        setSearchResults(hits.hits)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('session.error'))
    }
  }, [sessionId, workspace, t])

  useEffect(() => { void load('') }, [load])

  const onMaintain = useCallback(async () => {
    if (maintaining) return
    setMaintaining(true)
    setError(null)
    try {
      // The host accepts the job and finishes it in the background (batched
      // LLM review); completion arrives as a toast via the SSE channel, not
      // as this call's response. So this resolves fast.
      const result = await runMaintenance(sessionId)
      if (result.accepted) {
        setMaintainStarted(true)
        globalThis.setTimeout(() => { setMaintainStarted(false) }, 6000)
      } else {
        // A job is already running; surface that instead of a second run.
        setError(t('settings.maintainBusy'))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.maintainFailed'))
    } finally {
      setMaintaining(false)
    }
  }, [maintaining, sessionId, t])

  const onRestore = useCallback(async (id: string) => {
    setError(null)
    try {
      const result = await restoreRecord(sessionId, id)
      if (!result.restored) {
        setError(t('settings.restoreFailed'))
        return
      }
      await loadAudit()
      await load(query)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.restoreFailed'))
    }
  }, [sessionId, query, load, loadAudit, t])

  const onDelete = useCallback(async (id: string) => {
    try {
      const result = await deleteRecord(sessionId, id, workspace)
      if (!result.deleted) {
        setError(t('settings.deleteFailed'))
        return
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.deleteFailed'))
      return
    }
    // Refresh the list and, when the audit panel is open, the audit trail
    // (the deletion is recorded there as a manual entry).
    void load(query)
    if (showAudit) void loadAudit()
  }, [sessionId, workspace, query, load, loadAudit, showAudit, t])

  const total = groups === null ? 0 : groups.workspaces.reduce((sum, group) => sum + group.records.length, 0) + groups.user.length

  return h('div', { className: css.settingsRoot },
    h('div', { className: css.settingsHeader },
      h('h3', { className: css.settingsTitle }, t('settings.title')),
      h('div', { className: css.settingsActions },
        h('button', {
          type: 'button',
          className: css.maintainBtn,
          disabled: maintaining,
          onClick: () => { void onMaintain() },
        }, maintaining ? t('settings.maintaining') : t('settings.maintain')),
        h('button', {
          type: 'button',
          className: css.auditBtn,
          onClick: () => {
            const next = !showAudit
            setShowAudit(next)
            if (next) void loadAudit()
          },
        }, showAudit ? t('settings.hideAudit') : t('settings.showAudit')),
      ),
    ),
    maintainStarted && h('div', { className: css.maintainStarted }, t('settings.maintainStarted')),
    showAudit && audit !== null && h('div', { className: css.auditPanel },
      audit.length === 0
        ? h('div', { className: css.settingsHint }, t('settings.auditEmpty'))
        : h('div', null,
          ...audit.map((entry, index) => h('div', { key: index, className: css.auditEntry },
            h('div', { className: css.auditEntryHead },
              h('span', { className: css.auditTime }, new Date(entry.time).toLocaleString()),
              h('span', { className: css.auditLayer }, entry.layer),
            ),
            h('div', { className: css.auditReason }, entry.reason),
            entry.removed.length > 0 && h('div', { className: css.auditRemoved },
              ...entry.removed.map(item => h('div', { key: item.id, className: css.auditRemovedItem },
                h('span', { className: css.auditRemovedText }, item.text),
                h('button', {
                  type: 'button',
                  className: css.restoreBtn,
                  onClick: () => { void onRestore(item.id) },
                }, t('settings.restore')),
              )),
            ),
          )),
        ),
    ),
    h('input', {
      type: 'text',
      className: css.searchBox,
      value: query,
      placeholder: t('settings.searchPlaceholder'),
      onChange: (e: { target: { value: string } }) => {
        const value = e.target.value
        setQuery(value)
        void load(value)
      },
    }),
    error !== null && h('div', { className: css.settingsError }, error),
    searchResults !== null
      ? searchResults.length === 0
        ? h('div', { className: css.settingsHint }, t('settings.empty'))
        : h('div', { className: css.settingsGroupBody },
          ...searchResults.map(record => h(RecordRow, { key: record.id, record, onDelete, t })),
        )
      : groups === null
        ? h('div', { className: css.settingsHint }, t('session.loading'))
        : total === 0
          ? h('div', { className: css.settingsHint }, t('settings.empty'))
          : h('div', { className: css.settingsGroups },
            // User-global memory first (open by default), then one block per
            // workspace (collapsed by default; many projects stay tidy).
            h(GroupBlock, {
              title: t('settings.globalMemory'),
              records: groups.user,
              onDelete,
              t,
              defaultOpen: true,
            }),
            ...groups.workspaces.map((group: MemoryWorkspaceGroup) => h(GroupBlock, {
              key: group.path,
              title: t('settings.projectMemory') + ' · ' + group.title,
              countLabel: String(group.records.length),
              records: group.records,
              onDelete,
              t,
              defaultOpen: false,
            })),
          ),
  )
}

/** Re-export for the client entry; keeps the section API in one place. */
export type { MemoryHitView }
