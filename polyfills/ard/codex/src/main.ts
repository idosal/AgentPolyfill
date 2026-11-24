// ard-discovery for Codex: a stdio MCP server with ard_discover, ard_search
// and add_mcp_server. Codex gives one plugin's MCP server no way to call
// another's tools, so this plugin carries the Server Cards core itself (the
// same modules, bundled) and shows and adds what it finds with the same checks
// as mcp-server-cards. The tools are in src/ard.ts, which the Copilot form
// shares. Bundled into plugin/dist/server.mjs; importing it runs nothing, node
// running it starts the server.

import { codexDeps, isMain, logger, useCodexHost } from '../../../server-cards/codex/src/host'
import { serve } from '../../../server-cards/codex/src/mcp'
import { Session } from '../../../server-cards/codex/src/tools'
import { INSTRUCTIONS, registrySetting, tools } from './ard'

// What the tests run against.
export * from '../../../server-cards/claude-code/mod/hooks/card'
export * from '../../../server-cards/claude-code/mod/hooks/http'
export * from '../../../server-cards/claude-code/mod/hooks/sha256'
export * from '../../../server-cards/claude-code/mod/hooks/discover'
export * from '../../../server-cards/claude-code/mod/hooks/configure'
export * from '../../../server-cards/claude-code/mod/hooks/format'
export * from '../../../server-cards/claude-code/mod/hooks/offer'
export * from '../../../server-cards/codex/src/codex'
export * from '../../../server-cards/codex/src/fetch'
export * from '../../../server-cards/codex/src/host'
export * from '../../../server-cards/codex/src/mcp'
export * from '../../../server-cards/codex/src/tools'
export * from './ard'

export const NAME = 'ard-discovery'
export const VERSION = '0.1.1'

export function start(env: NodeJS.ProcessEnv = process.env) {
  useCodexHost()
  const off = /^(1|true|on|yes)$/i.test(env.ARD_DISCOVERY_DISABLED ?? '')
  const session = new Session(codexDeps(env, `${NAME}/${VERSION} (Codex polyfill)`))
  serve({
    name: NAME,
    version: VERSION,
    instructions: off ? undefined : INSTRUCTIONS,
    tools: off ? [] : tools(session, registrySetting(env)),
    log: logger(NAME, env, env.ARD_DISCOVERY_LOG ?? env.MCP_SERVER_CARDS_LOG),
  })
}

if (isMain(import.meta.url)) start()
