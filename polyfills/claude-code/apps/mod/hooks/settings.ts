// Host settings: terminal theme updates and the cached user agent.

import type { EngineInterface, On } from 'claude-code'
import type { Theme } from './state'
import { openings, state, views } from './state'
import { send } from './helper'

export function registerSettingsHooks(on: On) {
  // The person changed Claude Code's theme: open views follow it (the app
  // gets host-context-changed with the new theme and colours).
  on('config.set', async ($, e, next) => {
    const result = await next(e)
    if (!state.isActive || e.key !== 'theme' || result.deny !== undefined) return result
    const theme = themeOf(result.value)
    for (const view of views.values()) {
      if (view.call) view.call.theme = theme
      if (view.status === 'live') send($, view, '/theme', { viewId: view.id, theme })
      // Still opening, in the theme it had: the new one once it's open.
      else if (view.status === 'opening') {
        void openings.get(view.id)?.then(() => {
          if (view.status === 'live') send($, view, '/theme', { viewId: view.id, theme })
        })
      }
    }
    return result
  })
}

/**
 * Host context theme: Claude Code's own (`/config` theme), light or dark;
 * `auto` where it says neither, which the helper settles from the
 * terminal's colours where it says them, else dark.
 */
export async function terminalTheme($: EngineInterface): Promise<Theme> {
  const row = await $.config
    .list()
    .then((rows) => rows.find((r) => r.key === 'theme'))
    .catch(() => undefined)
  return themeOf(row?.value)
}

function themeOf(value: unknown): Theme {
  const name = String(value ?? '')
  return /light/i.test(name) ? 'light' : /dark/i.test(name) ? 'dark' : 'auto'
}

/** Host context userAgent: this Claude Code and the plugin. */
export function userAgent($: EngineInterface) {
  state.agent ??= $.session
    .version()
    .then(({ version }) => `Claude Code/${version} mcp-apps-cli/0.1.2`)
    .catch(() => 'Claude Code mcp-apps-cli/0.1.2')
  return state.agent
}
