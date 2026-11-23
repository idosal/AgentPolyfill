// On Claude Code's main screen a view gets no clicks or keys: only its
// fullscreen layout passes them to a Client. The first time a view is drawn
// there, once ever, after the turn, the person is asked whether to switch.
// On yes, the views are kept for the restart the switch makes (it resumes the
// conversation, see restoreViews), and Claude Code's own /tui fullscreen runs
// for them: nothing to type. Not asked where they chose the main screen
// themselves (CLAUDE_CODE_NO_FLICKER=0), or with offerFullscreen: never.

import type { EngineInterface } from 'claude-code'
import { state } from './state'
import { dropRestartCopy, keepForRestart } from './views'

/** In the plugin's store, across sessions: written before asking, so a dismissal or a crash never asks again. */
const ASKED_KEY = 'fullscreenOffer'
const SWITCH = 'Switch to fullscreen'
const KEEP = 'Keep this layout'

/** A view with a picture was drawn on the main screen: the offer is due once this session's turn ends. */
export function noteMainScreenView() {
  if (state.offer === undefined && state.settings.offerFullscreen !== 'never') state.offer = 'due'
}

/** At the end of a turn of the main loop: the offer, if it's due, without holding the turn. */
export function offerFullscreenSoon($: EngineInterface) {
  if (state.offer !== 'due') return
  state.offer = 'done'
  void offer($).catch((error: unknown) => $.ui.log(`mcp-apps-cli: fullscreen offer: ${String(error)}`, { to: 'debug' }))
}

async function offer($: EngineInterface) {
  // They chose the main screen themselves (it outranks /tui, too); or tmux,
  // where clicks and pictures depend on its own settings.
  if (state.noFlicker === '0' || state.tmux) return
  // Asked before, ever (or no store to remember it in): not again; unless
  // Claude Code refused the switch they chose (see below): once more.
  const previous = await $.store.get(ASKED_KEY).then(
    (value) => value,
    () => 'asked',
  )
  if (previous !== undefined && previous !== REFUSED) return
  const commands = await $.command.list().catch(() => [])
  if (!commands.some((command) => command.name === 'tui')) return
  if (!(await $.store.set(ASKED_KEY, 'asked').then(() => true, () => false))) return
  const epoch = state.epoch
  const question =
    'MCP App views here are view only: Claude Code passes them clicks and keys only in its fullscreen layout. ' +
    'Switch to it? Claude Code restarts and picks this conversation back up; the choice is saved, and /tui default goes back.'
  // Keeping the layout first: a stray Enter changes nothing.
  const turn = state.asking.then(() => $.ui.ask(question, { options: [KEEP, SWITCH], header: 'MCP App' }))
  state.asking = turn.catch(() => {})
  const answer = await turn.catch(() => KEEP)
  if (answer !== SWITCH || state.epoch !== epoch) return
  await keepForRestart($)
  const ran = await $.command.run({ command: 'tui', args: 'fullscreen' }).catch(async (error: unknown) => {
    // No restart is coming: the copy of the views goes now.
    await dropRestartCopy($)
    $.ui.log(`mcp-apps-cli: /tui fullscreen: ${String(error)}`, { to: 'debug' })
    $.ui.toast("Couldn't switch to fullscreen: /tui fullscreen does it")
    return undefined
  })
  // Claude Code refused the switch itself (launch flags a restart can't carry,
  // work running in the background, a setting it couldn't save) and its own
  // line says why: no restart is coming, so the copy goes now.
  if (ran && NO_RESTART.test(ran.text ?? '')) {
    await dropRestartCopy($)
    // They wanted it, and this session couldn't (its launch flags, work
    // running): a later session asks once more; refused again, never.
    await $.store.set(ASKED_KEY, previous === REFUSED ? 'refused again' : REFUSED).catch(() => {})
  }
}

/** The offer's marker after Claude Code refused the switch the person chose: asked once more. */
const REFUSED = 'refused'

/** How Claude Code's /tui says it won't restart (a copy left by a change in its wording goes at the next session start, once stale). */
const NO_RESTART = /\b(?:Cannot|Couldn't) switch renderers\b|\bStaying on the\b|\bAlready using the\b|\bCouldn't save this setting\b/
