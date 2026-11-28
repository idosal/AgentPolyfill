import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ADD, DISCOVER, NAME, Session, discoverTool, host, isMain, logger, memoryStore,
  nodeFetch, planAdd, resolveAdd, serve, shownText,
} from '../dist/server.mjs'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const MAX_CONFIG_BYTES = 1024 * 1024
const { version } = createRequire(import.meta.url)('../.cursor-plugin/plugin.json')

async function readConfig(path) {
  // An absent entry is safe to add. An existing, dangling symlink is not.
  try {
    const entry = await lstat(path)
    if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error('Unsupported MCP settings file')
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) throw new Error('Unsupported MCP settings file')
    const chunks = []
    // Bound the actual read too, in case another process extends the file.
    for await (const chunk of file.createReadStream({ end: MAX_CONFIG_BYTES })) chunks.push(chunk)
    const data = Buffer.concat(chunks)
    if (data.length > MAX_CONFIG_BYTES) throw new Error('MCP settings file grew during the check')
    return JSON.parse(data.toString('utf8'))
  } finally {
    await file.close()
  }
}

// Cursor's native confirmation can replace an existing name. Check both
// scopes before offering a link, including configurations we cannot parse.
async function checkName(name) {
  for (const dir of new Set([homedir(), process.cwd()])) {
    try {
      const config = await readConfig(join(dir, '.cursor', 'mcp.json'))
      if (!object(config) || ('mcpServers' in config && !object(config.mcpServers))) {
        return 'Cursor has an unreadable MCP configuration. Check it before adding a server.'
      }
      if (Object.hasOwn(config.mcpServers ?? {}, name)) {
        return `Cursor already has a server named "${name}". Choose another name to keep the existing entry.`
      }
    } catch {
      return 'Could not check Cursor’s MCP configuration for an existing name.'
    }
  }
}

function planForCursor(card, remote, values, name, local) {
  const target = card.remotes?.[remote]
  if (target && (target.type !== 'streamable-http' || target.headers?.length || Object.values(target.variables ?? {}).some(input => input.isSecret))) {
    return { error: 'Cursor install links from this plugin support Streamable HTTP remotes without headers or secret inputs.' }
  }
  const result = planAdd(card, remote, values, name, 'user', local)
  if (!('plan' in result)) return result
  const plan = result.plan
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
      if (args.remote !== undefined && (!Number.isSafeInteger(args.remote) || args.remote < 0)) {
        return { isError: true, text: 'Choose a remote number shown by discovery (0 or greater).' }
      }
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
  const session = new Session({ fetch: nodeFetch({ userAgent: `${NAME}/${version} (Cursor)` }), store: memoryStore(), now: Date.now })
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
    version,
    instructions: off ? undefined : instructions,
    tools: off ? [] : [cursorDiscovery, addTool(session)],
    log: logger(NAME, process.env),
  })
}
