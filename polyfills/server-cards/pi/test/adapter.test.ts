import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addTool, discoverTool, planForPi, runningPiCli, usePiHost, PI_PROTOCOL_VERSIONS, host } from '../src/index'
import { card, context, mockSession, addArgs, writeConfig, IDENTIFIER } from './harness'
import { PI_BIN } from './pi-rpc.ts'

test('P-1 a plain remote uses Pi CLI arguments and preserves a valid explicit name', () => {
  usePiHost()
  assert.equal(host.name, 'Pi')
  assert.deepEqual(host.protocolVersions, PI_PROTOCOL_VERSIONS)
  const r = planForPi(card(), 0, {}, 'My_docs-1', false)
  assert.ok('plan' in r)
  assert.deepEqual(r.plan.addArgs, ['mcp', 'add', 'My_docs-1', '--url', 'https://mcp.example.com/mcp'])
  assert.equal(runningPiCli([process.execPath, PI_BIN]), PI_BIN)
  assert.equal(runningPiCli([process.execPath, '/not/pi/cli.js']), undefined)
  assert.equal(runningPiCli([process.execPath, import.meta.filename]), undefined)
})

test('P-2 secret and mixed headers use card-specific references; model-supplied secret values are ignored', () => {
  const r = planForPi(card({ remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: [
    { name: 'X-Key', isSecret: true }, { name: 'Authorization', value: 'Token {token}', variables: { token: { isSecret: true } } },
    { name: 'X-Region', value: 'eu' },
  ] }] }), 0, { 'X-Key': 'do-not-copy-this', token: 'nor-this' }, undefined, false)
  assert.ok('plan' in r)
  assert.match(r.plan.headers['X-Key']!, /^\$\{MCP_EXAMPLE_DOCS__X_KEY_[A-Z2-7]{16}\}$/)
  assert.match(r.plan.headers.Authorization!, /^Token \$\{MCP_EXAMPLE_DOCS__TOKEN_[A-Z2-7]{16}\}$/)
  assert.ok(r.plan.addArgs.includes(`X-Key=${r.plan.headers['X-Key']}`))
  assert.doesNotMatch(JSON.stringify(r), /do-not-copy-this|nor-this/)
})

test('P-3 Pi refuses SSE, URL secrets, command headers, duplicates, markup, prefilled secrets and foreign env references', () => {
  const remotes: [Record<string, unknown>, RegExp][] = [
    [{ type: 'sse' }, /streamable HTTP/],
    [{ url: 'https://mcp.example.com/{key}', variables: { key: { isSecret: true } } }, /secret in the URL/],
    [{ headers: [{ name: 'X-A', value: '!touch marker' }] }, /would execute/],
    [{ headers: [{ name: '__proto__', value: 'value' }] }, /cannot save the header/],
    [{ headers: [{ name: 'X-A', value: '1' }, { name: 'x-a', value: '2' }] }, /twice/],
    [{ headers: [{ name: 'X-A', value: '<b>x</b>' }] }, /could show/],
    [{ headers: [{ name: 'X-A', value: '${HOME}' }] }, /may not contain/],
    [{ headers: [{ name: 'X-A', isSecret: true, value: 'literal-secret' }] }, /may not carry credentials/],
    [{ url: 'https://10.0.0.1/mcp' }, /private address/],
    [{ supportedProtocolVersions: ['2026-07-28'] }, /none of which Pi speaks/],
  ]
  for (const [extra, message] of remotes) {
    const r = planForPi(card({ remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp', ...extra }] }), 0, {}, undefined, false)
    assert.match('error' in r ? r.error : '', message)
  }
  assert.ok('error' in planForPi(card(), 0, {}, 'bad name', false))
  assert.ok('error' in planForPi(card(), 0, {}, '__proto__', false))
})

test('P-4 only Add it writes and registers; the question names host, URL, headers, file and undo', async () => {
  const s = mockSession(), c = context()
  const tool = addTool(s.session, 'discover_mcp_servers', 'discover_mcp_servers')
  assert.equal(tool.annotations.readOnlyHint, false)
  assert.equal(tool.annotations.openWorldHint, true)
  assert.equal(discoverTool(s.session, { name: 'discover', description: '' }).annotations.readOnlyHint, true)
  const r = await tool.run(addArgs, c.ctx)
  assert.equal(r.isError, undefined, r.text)
  assert.equal(s.calls.length, 1)
  assert.equal(s.calls[0]!.cmd, process.execPath)
  assert.deepEqual(s.calls[0]!.args, [s.deps.cli, 'mcp', 'add', 'example-docs', '--url', addArgs.url])
  assert.equal(s.registered[0]!.name, 'example-docs')
  assert.deepEqual(c.questions[0]!.choices, ["Don't add it", 'Add it'])
  assert.match(c.questions[0]!.title, /^mcp.example.com: add the MCP server "example-docs" to Pi\?\nIt connects to the host mcp.example.com\nURL: https:\/\/mcp.example.com\/mcp\nHeaders: none\n/)
  assert.ok(c.questions[0]!.title.endsWith(`Written to ${s.file} (all your projects).\nTo undo: pi mcp remove example-docs`))
  assert.match(r.text, /Registered with Pi for this session/)
})

test('P-5 decline, cancel, wrong choice, no UI, dialog failure and cancellation write nothing', async () => {
  for (const answer of ["Don't add it", undefined, 'yes', 'Add it']) {
    const s = mockSession(), c = context(answer, answer !== 'Add it')
    // undefined must model a closed selector, not context's default argument.
    if (answer === undefined) c.ctx.ui.select = async () => undefined
    const r = await addTool(s.session, 'discover', 'discover').run(addArgs, c.ctx)
    assert.equal(r.isError, true)
    assert.deepEqual(s.calls, [])
  }
  for (const cancelled of [false, true]) {
    const s = mockSession(), c = context(), abort = new AbortController()
    c.ctx.ui.select = async () => { if (!cancelled) throw new Error('dialog error'); abort.abort(); return 'Add it' }
    assert.equal((await addTool(s.session, 'd', 'd').run(addArgs, c.ctx, abort.signal)).isError, true)
    assert.equal(s.calls.length, 0)
  }
})

test('P-6 unseen, changed URL, missing CLI, existing name and unreadable configuration refuse before asking', async () => {
  for (const kind of ['unseen', 'url', 'cli', 'existing', 'malformed', 'project', 'registered']) {
    const s = mockSession(), c = context()
    if (kind === 'unseen') s.session.discovered.clear()
    if (kind === 'cli') s.deps.cli = undefined
    if (kind === 'existing') writeConfig(s.file, { 'example-docs': { url: 'https://theirs.example' } })
    if (kind === 'malformed') writeFileSync(s.file, '{')
    if (kind === 'registered') s.registered.push({ name: 'example-docs', config: { url: 'https://theirs.example' } })
    if (kind === 'project') { mkdirSync(join(c.ctx.cwd, '.pi')); writeConfig(join(c.ctx.cwd, '.pi/mcp.json'), { 'example-docs': {} }); c.ctx.isProjectTrusted = () => true }
    const r = await addTool(s.session, 'd', 'd').run({ ...addArgs, ...(kind === 'url' ? { url: 'https://evil.example' } : {}) }, c.ctx)
    assert.equal(r.isError, true, kind)
    assert.equal(c.questions.length, 0, kind)
    assert.equal(s.calls.length, 0, kind)
  }
})

test('P-7 rechecks the name after consent; a concurrent addition is refused', async () => {
  const s = mockSession(), c = context()
  const tool = addTool(s.session, 'd', 'd')
  c.ctx.ui.select = async () => {
    const another = await tool.run(addArgs, c.ctx)
    assert.match(another.text, /already awaiting/)
    writeConfig(s.file, { 'example-docs': { url: 'https://theirs.example' } })
    return 'Add it'
  }
  assert.match((await tool.run(addArgs, c.ctx)).text, /appeared in Pi's configuration/)
  assert.equal(s.calls.length, 0)
})

test('P-8 command failure never registers or leaks output; registration failure reports the saved entry honestly', async () => {
  const s = mockSession(), c = context()
  s.pi.exec = async () => ({ code: 1, killed: false, truncated: false, stdout: 'secret-value', stderr: 'secret-value' })
  const r = await addTool(s.session, 'd', 'd').run(addArgs, c.ctx)
  assert.equal(r.isError, true)
  assert.doesNotMatch(r.text, /secret-value/)
  assert.equal(s.registered.length, 0)
  s.pi.exec = async () => ({ code: 0, killed: false, truncated: false, stdout: '', stderr: '' })
  s.pi.registerMcpServer = () => { throw new Error('failed') }
  assert.match((await addTool(s.session, 'd', 'd').run(addArgs, c.ctx)).text, /Saved, but registration.*failed/)
})

test('P-9 headers in the consent are the unexpanded references that Pi writes', async () => {
  const s = mockSession(), c = context()
  s.session.discovered.get(`https://publisher.example\n${IDENTIFIER}`)!.card = card({ remotes: [{ type: 'streamable-http', url: addArgs.url, headers: [{ name: 'X-Key', isSecret: true }] }] })
  const r = await addTool(s.session, 'd', 'd').run(addArgs, c.ctx)
  assert.equal(r.isError, undefined)
  assert.match(c.questions[0]!.title, /Headers: X-Key: \$\{MCP_EXAMPLE_DOCS__X_KEY_[A-Z2-7]{16}\}/)
  assert.match(s.calls[0]!.args.at(-1)!, /^X-Key=\$\{MCP_/)
})
