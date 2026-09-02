/**
 * dsh-hippocampus current-workspace resolution (client side, zero upstream).
 *
 * The settings panel is a root-scope slot: it receives no session id, yet the
 * project memory layer is workspace-scoped. This module resolves the "current
 * workspace" the same way the harness sidebar does — the current Session's
 * workspace, falling back to the most recent workspace — by reading the
 * client-side `sessions` and `workspaces` services (registered by the
 * session/workspace controllers).
 */

/** Structural face of the client sessions service (subset of ISessions). */
export interface ClientSessionsFace {
  list: {
    getSnapshot(): { current?: string | undefined } | undefined
  }
}

/** Structural face of the client workspaces service (subset of IWorkspaces). */
export interface ClientWorkspacesFace {
  list: {
    getSnapshot(): {
      items?: readonly {
        readonly path: string
        readonly sessionIds: readonly string[]
      }[]
    } | undefined
  }
}

/**
 * Resolve the current workspace path: the current session's workspace first,
 * then the most recently listed workspace. `undefined` when neither the
 * services nor any workspace are available.
 */
export function resolveCurrentWorkspace(
  sessions: ClientSessionsFace | undefined,
  workspaces: ClientWorkspacesFace | undefined,
): string | undefined {
  const items = workspaces?.list.getSnapshot()?.items
  if (items === undefined || items.length === 0) return undefined
  const current = sessions?.list.getSnapshot()?.current
  if (current !== undefined) {
    const owned = items.find(item => item.sessionIds.includes(current))
    if (owned !== undefined) return owned.path
  }
  // Most recent workspace (registry order is newest-first).
  return items[0]?.path
}
