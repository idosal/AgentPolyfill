// For the adapter tests of both Codex plugins: the built server run as Codex
// runs it (node, stdio), a stand-in `codex` command that records what it is
// asked and keeps its MCP entries in a file, a local web on 127.0.0.1, and an
// MCP client that answers the server's forms as a test says.

import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// The stand-in for `codex`: `mcp get`, `mcp add` and `app-server`'s
// config/value/write, as Codex 0.170.0 answers them.
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs')
const state = process.env.FAKE_CODEX_STATE
const read = () => (fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : {})
const write = s => fs.writeFileSync(state, JSON.stringify(s))
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + '\\n')
if (args[0] === 'mcp' && args[1] === 'get') {
  const s = read()
  if (s[args[2]]) { console.log(JSON.stringify(s[args[2]])); process.exit(0) }
  console.error("Error: No MCP server named '" + args[2] + "' found."); process.exit(1)
}
if (args[0] === 'mcp' && args[1] === 'add') {
  const s = read(); const name = args[2]
  const entry = { url: args[args.indexOf('--url') + 1] }
  if (args.includes('--bearer-token-env-var')) entry.bearer_token_env_var = args[args.indexOf('--bearer-token-env-var') + 1]
  s[name] = entry; write(s)
  console.log("Added global MCP server '" + name + "'.")
  if (process.env.FAKE_CODEX_OAUTH === '1') { console.log('Detected OAuth support. Starting OAuth flow\\u2026'); setTimeout(() => {}, 30000); return }
  process.exit(0)
}
if (args[0] === 'app-server') {
  let buf = ''
  process.stdin.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
      if (m.method === 'initialize') console.log(JSON.stringify({ id: m.id, result: { userAgent: 'fake' } }))
      if (m.method === 'config/value/write') {
        const s = read(); s[m.params.keyPath.replace(/^mcp_servers\\./, '')] = m.params.value; write(s)
        console.log(JSON.stringify({ id: m.id, result: { status: 'ok' } }))
      }
    }
  })
  return
}
console.error('fake codex: unknown command ' + args.join(' ')); process.exit(2)
`

export type Fake = { dir: string; bin: string; state: string; log: string; calls: () => string[][]; entries: () => Record<string, any> }

export function fakeCodex(): Fake {
  const dir = mkdtempSync(join(tmpdir(), 'codex-polyfill-test-'))
  const bin = join(dir, 'codex.cjs')
  writeFileSync(bin, FAKE_CODEX)
  chmodSync(bin, 0o755)
  const state = join(dir, 'state.json')
  const log = join(dir, 'calls.log')
  writeFileSync(log, '')
  return {
    dir,
    bin,
    state,
    log,
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)),
    entries: () => (existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : {}),
  }
}

export type Route = { status?: number; headers?: Record<string, string>; body: unknown } | ((req: IncomingMessage, body: string) => { status?: number; headers?: Record<string, string>; body: unknown })

/** A web on 127.0.0.1: routes by path; `{origin}` in a body is this web's origin. Records each request. */
export async function localWeb(routes: Record<string, Route>) {
  const requests: { method: string; path: string; body: string }[] = []
  let origin = ''
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', d => (body += d))
    req.on('end', () => {
      requests.push({ method: req.method ?? '', path: req.url ?? '', body })
      const r = routes[req.url ?? '']
      if (!r) {
        res.writeHead(404).end('not found')
        return
      }
      const out = typeof r === 'function' ? r(req, body) : r
      const text = (typeof out.body === 'string' ? out.body : JSON.stringify(out.body)).split('{origin}').join(origin)
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...(out.headers ?? {}) }).end(text)
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  origin = `http://127.0.0.1:${port}`
  return { origin, requests, close: () => new Promise<void>(r => server.close(() => r())) }
}

export type Answer = { action: 'accept' | 'decline' | 'cancel'; afterMs?: number } | 'error'

/** The built server on stdio, and a client that answers its forms with `answer`. */
export function startServer(serverFile: string, opts: { env?: Record<string, string>; elicitation?: boolean; answer?: Answer } = {}) {
  const child: ChildProcess = spawn(process.execPath, [serverFile], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...(opts.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr!.on('data', d => (stderr += d))
  const asked: { message: string; requestedSchema: unknown; mode?: string }[] = []
  const pending = new Map<number, (m: any) => void>()
  let id = 0
  let buf = ''
  const send = (m: unknown) => child.stdin!.write(`${JSON.stringify(m)}\n`)
  child.stdout!.on('data', d => {
    buf += d
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      if (m.method === 'elicitation/create') {
        asked.push(m.params)
        const a = opts.answer ?? { action: 'decline' }
        if (a === 'error') send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'no' } })
        else setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: { action: a.action, ...(a.action === 'accept' ? { content: {} } : {}) } }), a.afterMs ?? 0)
      } else if (m.id !== undefined && pending.has(m.id)) {
        pending.get(m.id)!(m)
        pending.delete(m.id)
      }
    }
  })
  const request = (method: string, params: unknown) =>
    new Promise<any>(resolve => {
      const n = ++id
      pending.set(n, resolve)
      send({ jsonrpc: '2.0', id: n, method, params })
    })
  const ready = request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: opts.elicitation === false ? {} : { elicitation: { form: {}, url: {} } },
    clientInfo: { name: 'test', version: '0' },
  }).then(r => {
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return r
  })
  const call = async (name: string, args: Record<string, unknown>) => {
    await ready
    const r = await request('tools/call', { name, arguments: args })
    return { text: String(r.result?.content?.[0]?.text ?? ''), isError: r.result?.isError === true, raw: r }
  }
  return { ready, request, call, asked, stderr: () => stderr, stop: () => child.kill() }
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * The plugin folder is installed by copying it, with nothing else, so: the
 * committed bundle must be what the sources build (byte for byte), the
 * marketplace must point at that folder, and a copy of it must start and list
 * its tools. As polyfills/events/claude-code/test/bundle-test.ts checks for
 * the Events helper.
 */
export function bundleChecks(root: string, plugin: string, marketplacePath: string, tools: string[]) {
  test('the committed plugin/dist/server.mjs is byte-identical to a fresh build, and is all dist/ holds', () => {
    const dir = mkdtempSync(join(tmpdir(), `${plugin}-build-`))
    try {
      const built = spawnSync(process.execPath, [join(root, 'build.mjs'), '--out', dir], { encoding: 'utf8', timeout: 60_000 })
      assert.equal(built.status, 0, built.stderr)
      assert.deepEqual(readdirSync(join(root, 'plugin', 'dist')), ['server.mjs'])
      assert.ok(readFileSync(join(dir, 'server.mjs')).equals(readFileSync(join(root, 'plugin', 'dist', 'server.mjs'))), 'plugin/dist/server.mjs is stale: run npm run build')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the Codex marketplace points at plugin/, and a copy of that folder alone starts and lists its tools', async () => {
    const market = JSON.parse(readFileSync(join(root, '..', '..', '..', '.agents', 'plugins', 'marketplace.json'), 'utf8')) as { plugins: { name: string; source: { source: string; path: string } }[] }
    assert.deepEqual(market.plugins.find(p => p.name === plugin)?.source, { source: 'local', path: marketplacePath })
    const manifest = JSON.parse(readFileSync(join(root, 'plugin', '.codex-plugin', 'plugin.json'), 'utf8'))
    assert.equal(manifest.name, plugin)
    const mcp = JSON.parse(readFileSync(join(root, 'plugin', '.mcp.json'), 'utf8'))
    assert.deepEqual([mcp.mcpServers[plugin].command, mcp.mcpServers[plugin].args], ['node', ['./dist/server.mjs']])
    const dir = mkdtempSync(join(tmpdir(), `${plugin}-install-`))
    const installed = join(dir, 'cached plugin') // a space in the path, as an install folder may have
    mkdirSync(installed)
    cpSync(join(root, 'plugin'), installed, { recursive: true })
    const s = startServer(join(installed, 'dist', 'server.mjs'))
    try {
      await s.ready
      const list = await s.request('tools/list', {})
      assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), tools)
    } finally {
      s.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
