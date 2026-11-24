import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerCard, CallContext, PiAPI, SessionDeps } from '../src/index'
import { piDeps, Session } from '../src/index'
import { temp } from './pi-rpc.ts'

export const TYPE = 'application/mcp-server-card+json'
export const SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json'
export const card = (extra: Record<string, unknown> = {}): ServerCard => ({
  $schema: SCHEMA, name: 'com.example/docs', version: '1.0.0', description: 'Docs.', title: 'Example Docs',
  remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }], ...extra,
} as ServerCard)
export const IDENTIFIER = 'urn:air:localhost:docs'

export function mockSession() {
  const dir = temp('adapter-')
  const calls: { cmd: string; args: string[] }[] = []
  const registered: { name: string; config: { url: string } }[] = []
  const pi = {
    exec: async (cmd: string, args: string[]) => {
      calls.push({ cmd, args })
      return { code: 0, stdout: '', stderr: '', killed: false }
    },
    getMcpServers: () => registered,
    registerMcpServer: (name: string, config: { url: string }) => { registered.push({ name, config }) },
  } as unknown as PiAPI
  const deps: SessionDeps = { ...piDeps(pi, { PI_CODING_AGENT_DIR: dir }), cli: '/verified/pi/dist/bundle/cli.js' }
  const session = new Session(deps)
  session.discovered.set(`https://publisher.example\n${IDENTIFIER}`, { card: card(), isLocal: false, provenance: "listed in https://publisher.example's catalog" })
  return { dir, file: join(dir, 'mcp.json'), calls, registered, pi, deps, session }
}

export function context(answer: string | undefined = 'Add it', hasUI = true) {
  const questions: { title: string; choices: string[] }[] = []
  const ctx = {
    hasUI, cwd: temp('cwd-'), isProjectTrusted: () => false,
    ui: { select: async (title: string, choices: string[]) => { questions.push({ title, choices }); return answer } },
  } as unknown as CallContext
  return { ctx, questions }
}
export const addArgs = { domain: 'https://publisher.example', identifier: IDENTIFIER, url: 'https://mcp.example.com/mcp' }

/** One local publisher, ARD registry and stateless streamable HTTP MCP server. */
export async function localWeb(headers: { name: string; isSecret?: boolean; value?: string }[] = []) {
  const requests: { path: string; method: string; body: string; headers: Record<string, unknown> }[] = []
  let origin = ''
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ path: req.url!, method: req.method!, body, headers: req.headers })
    const send = (value: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
    const entry = { identifier: IDENTIFIER, type: TYPE, url: `${origin}/docs.json` }
    if (req.url === '/.well-known/ai-catalog.json') return send({ specVersion: '1.0', entries: [entry] })
    if (req.url === '/.well-known/ard.json') return send({ entries: [entry] })
    if (req.url === '/docs.json') return send(card({ remotes: [{ type: 'streamable-http', url: `${origin}/mcp`, headers }] }))
    if (req.url === '/search') return send({ results: [entry] })
    if (req.url === '/mcp' && req.method === 'POST') {
      const message = JSON.parse(body)
      if (message.id === undefined) { res.writeHead(202); return res.end() }
      const result = message.method === 'initialize'
        ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'pi-test-server', version: '1' } }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'ping', description: 'Returns pong', inputSchema: { type: 'object', properties: {} } }] }
          : message.method === 'tools/call' ? { content: [{ type: 'text', text: 'pong' }] } : {}
      return send({ jsonrpc: '2.0', id: message.id, result })
    }
    res.writeHead(404); res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { origin, requests, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
}

export const saved = (agentDir: string) => JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8'))
export const writeConfig = (file: string, servers: Record<string, unknown>) => writeFileSync(file, JSON.stringify({ mcpServers: servers }))
