/**
 * dsh-hippocampus client half: register the "Memory" tab in the
 * conversation view slot and the "Memory" page in the settings section.
 */

import type { Context } from '@deepseek-ai/cordis'
import { h } from './react.ts'
import { en, NS, zh } from './locales.ts'
import { SessionPanel, type SessionPanelInjected } from './SessionPanel.ts'
import { SettingsSection, type SettingsSectionInjected } from './SettingsSection.ts'
import { registerSettingsNavIcon } from './settings-nav-icon.ts'
import { resolveCurrentWorkspace, type ClientSessionsFace, type ClientWorkspacesFace } from './current-workspace.ts'
import { setToastLabels, startMaintainEvents } from './toast.ts'
import { ToastHost, type ToastHostProps } from './ToastHost.ts'

/** Structural face of the client services this plugin consumes. */
export interface HippocampusClientContext extends Context {
  slots: {
    inject(name: string, register: () => unknown): unknown
    register(options: unknown, component?: unknown): unknown
  }
  locale: {
    register(ns: string, dicts: Record<string, Record<string, string>>): unknown
    bind(ns: string): (key: string, params?: Record<string, unknown>) => string
  }
}

/** Required services: the slot system and the locale service. */
export const inject = ['slots', 'locale']

/** Client plugin body: register the memory panel and settings section. */
export function apply(rawCtx: Context): void {
  const ctx = rawCtx as HippocampusClientContext
  ctx.effect(() => ctx.locale.register(NS as never, { zh, en }) as never, 'dsh-hippocampus: dictionaries')
  const t = ctx.locale.bind(NS)

  // The settings shell paints every unknown section with the gear glyph and
  // offers no icon override; patch the rendered nav DOM instead (see module).
  registerSettingsNavIcon()

  // Toast labels + SSE listener: background "整理" jobs push completion over
  // /memory/api/events; the shell.overlay host below renders the toasts.
  setToastLabels({
    doneTitle: t('toast.doneTitle'),
    errorTitle: t('toast.errorTitle'),
    doneDetail: (count: number) => t('toast.doneDetail', { count }),
  })
  startMaintainEvents()

  // Frame-wide toast layer: ui-layout's shell.overlay slot renders this at
  // the app level (independent of any conversation or settings panel), so a
  // finished background job notifies the user wherever they are.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'hippocampus-toast',
      order: 90,
      locale: NS as never,
    },
    (props: ToastHostProps) => h(ToastHost, props),
  ))

  // Conversation view tab: per-session memory (project + user).
  ctx.slots.inject('conversation.view', () => ctx.slots.register(
    {
      name: 'conversation.view',
      id: 'hippocampus',
      order: 40,
      locale: NS as never,
      label: () => t('view.memory'),
      inject: (sessionId: string): SessionPanelInjected => ({ sessionId, t }),
    },
    (props: SessionPanelInjected) => h(SessionPanel, props),
  ))

  // Settings page: global memory management (all records, search, delete,
  // stats). The settings panel is a root-scope slot (no session id); resolve
  // the current workspace client-side (current session's workspace, else the
  // most recent) and pass it explicitly so the project layer lands correctly.
  const currentWorkspace = () => resolveCurrentWorkspace(
    ctx.get('sessions') as ClientSessionsFace | undefined,
    ctx.get('workspaces') as ClientWorkspacesFace | undefined,
  )
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: 'hippocampus-memory',
      order: 50,
      locale: NS as never,
      label: () => t('view.memory'),
      inject: (sessionId: string): SettingsSectionInjected => ({
        sessionId,
        workspace: currentWorkspace(),
        t,
      }),
    },
    (props: SettingsSectionInjected) => h(SettingsSection, props),
  ))
}
