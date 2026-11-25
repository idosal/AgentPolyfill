// ard-discovery for Copilot: a stdio MCP server with ard_discover, ard_search and add_mcp_server,
// shipped in a Copilot plugin (plugin/.mcp.json). The tools are the Codex form's (../codex/src/ard.ts),
// with Copilot's name and Copilot's add_mcp_server (polyfills/server-cards/copilot). Copilot gives one
// plugin's MCP server no way to call another's tools, so this plugin carries the Server Cards core
// itself. Bundled into plugin/dist/server.mjs; importing it runs nothing, node running it starts the server.

import { isMain, logger } from '../../../server-cards/codex/src/host'
import { serve } from '../../../server-cards/codex/src/mcp'
import { Session } from '../../../server-cards/codex/src/tools'
import { copilotDeps, useCopilotHost } from '../../../server-cards/copilot/src/host'
import { addTool } from '../../../server-cards/copilot/src/tools'
import { INSTRUCTIONS, registrySetting, tools as ardTools } from '../../codex/src/ard'

// What the tests run against.
export * from '../../../server-cards/claude-code/mod/hooks/card'
export * from '../../../server-cards/claude-code/mod/hooks/http'
export * from '../../../server-cards/claude-code/mod/hooks/sha256'
export * from '../../../server-cards/claude-code/mod/hooks/discover'
export * from '../../../server-cards/claude-code/mod/hooks/configure'
export * from '../../../server-cards/claude-code/mod/hooks/format'
export * from '../../../server-cards/claude-code/mod/hooks/offer'
export { nodeFetch } from '../../../server-cards/codex/src/fetch'
export { memoryStore, isMain, logger } from '../../../server-cards/codex/src/host'
export { serve, offersForm, PROTOCOL_VERSIONS } from '../../../server-cards/codex/src/mcp'
export { ADD, ADD_CHOICES, askPerson, choiceSchema, discoverTool, Session, shownText } from '../../../server-cards/codex/src/tools'
export * from '../../../server-cards/copilot/src/copilot'
export * from '../../../server-cards/copilot/src/host'
export { addTool, askText, resolveAdd } from '../../../server-cards/copilot/src/tools'
export { ARD_SOURCES, BY, DISCOVER, INSTRUCTIONS, noRegistry, registrySetting, SEARCH, SEARCH_CHOICES, SHOWN_QUERY, SHOWN_REGISTRY, search, searchEndpoint, originOf } from '../../codex/src/ard'

export const NAME = 'ard-discovery'
export const VERSION = '0.1.1'

// ard_search is marked not read-only: it sends the person's words to a third party, and Copilot's
// permission rules (and VS Code's) may read the hint.
export const tools = (session: Session, defaultRegistry: string) => ardTools(session, defaultRegistry, { name: 'Copilot', addTool, searchReadOnly: false })

export function start(env: NodeJS.ProcessEnv = process.env) {
  useCopilotHost()
  // Stand-down (contract rule 4): Copilot doesn't read ard.json or search ARD registries (1.0.115). When
  // it does, uninstall the plugin, or set this to register nothing.
  const off = /^(1|true|on|yes)$/i.test(env.ARD_DISCOVERY_DISABLED ?? '')
  const session = new Session(copilotDeps(env, `${NAME}/${VERSION} (Copilot polyfill)`))
  serve({
    name: NAME,
    version: VERSION,
    instructions: off ? undefined : INSTRUCTIONS,
    tools: off ? [] : tools(session, registrySetting(env)),
    log: logger(NAME, env, env.ARD_DISCOVERY_LOG ?? env.MCP_SERVER_CARDS_LOG),
  })
}

if (isMain(import.meta.url)) start()
