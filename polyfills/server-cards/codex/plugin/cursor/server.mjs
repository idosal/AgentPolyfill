import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ADD, DISCOVER, NAME, Session, discoverTool, host, isMain, logger, memoryStore,
  nodeFetch, planAdd, resolveAdd, serve, shownText,
} from '../dist/server.mjs'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// Cursor's native confirmation can replace an existing name. Check both
// scopes before offering a link, including configurations we cannot parse.
async function checkName(name) {
  for (const dir of new Set([homedir(), process.cwd()])) {
    try {
      const config = JSON.parse(await readFile(join(dir, '.cursor', 'mcp.json'), 'utf8'))
      if (!object(config) || ('mcpServers' in config && !object(config.mcpServers))) {
        return 'Cursor has an unreadable MCP configuration. Check it before adding a server.'
      }
      if (Object.hasOwn(config.mcpServers ?? {}, name)) {
        return `Cursor already has a server named "${name}". Choose another name to keep the existing entry.`
      }
    } catch (error) {
      if (error.code !== 'ENOENT') return 'Could not check Cursor’s MCP configuration for an existing name.'
    }
  }
}

function planForCursor(card, remote, values, name, local) {
  const result = planAdd(card, remote, values, name, 'user', local)
  if (!('plan' in result)) return result
  const plan = result.plan
  if (plan.transport !== 'http' || plan.headers.length || plan.envVars.length) {
    return { error: 'Cursor install links from this plugin support Streamable HTTP remotes without headers or secret inputs.' }
  }
  if (plan.name === NAME || Object.hasOwn(Object.prototype, plan.name)) {
    return { error: 'Choose a different server name.' }
  }
  return result
}

const instructions = 'Show the selected server name and exact URL. Give the person the install link to open and review in Cursor. Only Cursor’s Install button adds the server.'

function addTool(session) {
  return {
    name: ADD,
    description: 'Prepare a Cursor install link for a Streamable HTTP remote shown by discover_mcp_servers in this session. ' + instructions,
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'The domain or page used for discovery.' },
        identifier: { type: 'string', description: 'The selected catalog entry identifier.' },
        url: { type: 'string', description: 'The exact connection URL shown to the person.' },
        remote: { type: 'integer', minimum: 0, description: 'The remote number. Defaults to 0.' },
        name: { type: 'string', description: 'Optional name for the server in Cursor.' },
        values: { type: 'object', additionalProperties: { type: 'string' }, description: 'Non-secret inputs for the selected URL.' },
      },
      required: ['domain', 'identifier', 'url'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async args => {
      const selected = resolveAdd(session, args, DISCOVER, planForCursor)
      if ('deny' in selected) return { isError: true, text: shownText(selected.deny) }
      const { name, url } = selected.plan
      const conflict = await checkName(name)
      if (conflict) return { isError: true, text: conflict }
      const config = Buffer.from(JSON.stringify({ url })).toString('base64')
      const link = 'cursor://anysphere.cursor-deeplink/mcp/install?' + new URLSearchParams({ name, config })
      return { text: `Review "${name}" at ${url} in Cursor:\n${link}\nInstall saves it to your user MCP settings for all projects. Cancel leaves it uninstalled. Remove it in Cursor’s MCP settings.` }
    },
  }
}

if (isMain(import.meta.url)) {
  host.name = 'Cursor'
  const session = new Session({ fetch: nodeFetch({ userAgent: 'mcp-server-cards/0.1.0 (Cursor)' }), store: memoryStore(), now: Date.now })
  const discovery = discoverTool(session, { name: DISCOVER, description: 'Find and validate the MCP Server Cards published by a domain. Reads its AI Catalog and the cards it lists.' })
  const off = /^(1|true|on|yes)$/i.test(process.env.MCP_SERVER_CARDS_DISABLED ?? '')
  const cursorDiscovery = {
    ...discovery,
    run(args, ctx) {
      // Match the publisher's supported revisions against the one this
      // client negotiated. Add can only select a card from this session.
      host.protocolVersions = [ctx.protocol]
      return discovery.run(args, ctx)
    },
  }
  serve({
    name: NAME,
    version: '0.1.0',
    instructions: off ? undefined : instructions,
    tools: off ? [] : [cursorDiscovery, addTool(session)],
    log: logger(NAME, process.env),
  })
}
