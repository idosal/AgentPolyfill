// mcp-apps-cli: renders MCP App views inline in the Claude Code CLI.
//
// When the model calls an MCP tool that declares a UI resource
// (`_meta.ui.resourceUri`), this mod has a headless helper run the view in
// Chrome through AppBridge, and draws the helper's text frames under the
// tool call's row in a `Client` region. Clicks and keys on that region go
// back to the page. Tool calls the app makes go through Claude Code's own
// MCP connection (`$.mcp.call`); `ui/message` starts a turn. What Claude
// receives from the tool is never changed.

import type { Register } from 'claude-code'
import { registerContextHooks } from './consent'
import { registerHelperHooks } from './helper'
import { registerSettingsHooks } from './settings'
import { registerStreamHooks, registerToolHooks } from './stream'
import { registerViewHooks } from './views'
import { state } from './state'

export const register: Register = (on, options) => {
  state.settings = (options ?? {}) as typeof state.settings

  registerHelperHooks(on)
  registerToolHooks(on)
  registerViewHooks(on)
  registerStreamHooks(on)
  registerSettingsHooks(on)
  registerContextHooks(on)
}
