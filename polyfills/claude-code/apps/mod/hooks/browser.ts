// A machine with no Chromium browser: app views can't open. The first time
// one fails for that reason the person is asked, once ever, whether to fetch
// Chrome for Testing's headless shell for them (Google's own build, about
// 100 MB, kept in the plugin's data folder and kept current; see the
// helper's fetch_browser.rs). On yes it's fetched and the views that failed
// open again. Never asked with offerBrowser: never.

import type { EngineInterface } from 'claude-code'
import { helper } from './helper'
import { state, views } from './state'
import { reopenView } from './views'

const ASKED_KEY = 'browserOffer'
const FETCH = 'Download it'
const LATER = 'Not now'

/** A view failed to open: if no browser is why, the person may be asked (once a session at most). */
export function noteOpenFailed($: EngineInterface) {
  if (state.browserOffer !== undefined || state.settings.offerBrowser === 'never') return
  state.browserOffer = 'checking'
  void offer($).catch((error: unknown) => $.ui.log(`mcp-apps-cli: browser offer: ${String(error)}`, { to: 'debug' }))
}

async function offer($: EngineInterface) {
  // Only when the helper finds no browser, and Chrome for Testing builds the shell for this machine.
  const status = (await helper($, '/browser', {}).catch(() => undefined)) as { ok?: unknown; found?: unknown; fetchable?: unknown } | undefined
  if (status?.ok !== true || status.found !== false || status.fetchable !== true) {
    state.browserOffer = undefined
    return
  }
  state.browserOffer = 'done'
  // Asked before, ever (or no store to remember it in): not again.
  const asked = await $.store.get(ASKED_KEY).then(
    (value) => value !== undefined,
    () => true,
  )
  if (asked) return
  if (!(await $.store.set(ASKED_KEY, 'asked').then(() => true, () => false))) return
  const question =
    'MCP App views need a browser, and none is installed. Download one for them? ' +
    "It's Chrome for Testing's headless shell, from Google, about 100 MB, kept in this plugin's folder and updated when a new version is out."
  // Not now first: a stray Enter fetches nothing.
  const turn = state.asking.then(() => $.ui.ask(question, { options: [LATER, FETCH], header: 'MCP App' }))
  state.asking = turn.catch(() => {})
  const answer = await turn.catch(() => LATER)
  if (answer !== FETCH) return
  await $.store.set(ASKED_KEY, 'fetched').catch(() => {})
  $.ui.toast('Downloading a browser for app views (about 100 MB)…')
  const got = (await helper($, '/fetch-browser', {}).catch((error: unknown) => ({ ok: false, error: String(error) }))) as {
    ok?: unknown
    error?: unknown
    version?: unknown
  }
  if (got.ok !== true) {
    $.ui.log(`mcp-apps-cli: fetching a browser: ${String(got.error)}`, { to: 'debug' })
    $.ui.toast("Couldn't download a browser for app views")
    return
  }
  $.ui.toast('App views have a browser now')
  // The views that couldn't open, opened again.
  for (const view of [...views.values()]) {
    if (view.status !== 'error') continue
    view.status = 'closed'
    void reopenView($, view)
  }
}
