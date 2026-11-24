// Which connection Events uses, against a Streamable HTTP server behind a
// credential, in a real isolated Pi. The extension always opens a connection of
// its own (which settles on protocol revision 2026-07-28, the one SEP-3415 is
// defined for; Pi 1.6.0's own client speaks up to 2025-11-25):
//
//   - header-authenticated: reached, with the header resolved as Pi resolves it;
//   - OAuth: out of reach, and the extension says why.
//
// The second describe runs the same on a Pi built with the prototyped change
// that adds pi.getMcpServerSession() (MCP_PI_PATCHED_CLI): a lent connection
// changes nothing for Events yet.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Pi, PI_BIN, temp, waitFor, type Rule } from './pi-rpc.ts';

const EXTENSION = fileURLToPath(new URL('../extension/dist/index.js', import.meta.url));
const HTTP_FIXTURE = fileURLToPath(new URL('./http-fixture.ts', import.meta.url));
const EVENTS_FIXTURE = fileURLToPath(new URL('../../claude-code/test/fixture-events-server.ts', import.meta.url));
const PATCHED = process.env.MCP_PI_PATCHED_CLI;
/** A test credential, made up for this test. */
const TOKEN = 'test-token-for-the-fixture';
const RULES: Rule[] = [{ when: '^list event types$', call: { name: 'list_event_types', args: {} } }];

type Logged = { method?: string; auth: boolean; client: string | null };
const stops: (() => Promise<void> | void)[] = [];
after(async () => {
    for (const s of stops.reverse()) await s();
});

async function server(mode: 'token' | 'oauth') {
    const dir = temp('mcp-events-http-');
    const upstream = join(dir, 'upstream.jsonl');
    writeFileSync(upstream, '');
    const log = join(dir, 'http.jsonl');
    const env = { ...process.env, FIXTURE_UPSTREAM: upstream, FIXTURE_TICKET_DELIVERY: 'poll', FIXTURE_POLL_MS: '300', ...(mode === 'token' ? { FIXTURE_TOKEN: TOKEN } : { FIXTURE_OAUTH: '1' }) };
    const child: ChildProcess = spawn(process.execPath, ['--no-warnings', HTTP_FIXTURE, EVENTS_FIXTURE, '0', log], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    stops.push(() => void child.kill());
    let out = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString('utf8')));
    const port = await waitFor(() => /listening (\d+)/.exec(out)?.[1], 10000, 'the HTTP fixture');
    return { url: `http://127.0.0.1:${port}/mcp`, requests: (): Logged[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Logged) : []) };
}

function home(servers: Record<string, unknown>) {
    const dir = temp('mcp-events-home-');
    const agentDir = join(dir, 'agent');
    const homeDir = join(dir, 'home');
    const bin = join(dir, 'bin');
    for (const d of [agentDir, homeDir, bin]) mkdirSync(d, { recursive: true });
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
    // `open` and `xdg-open` stand in for the browser: they follow the sign-in page's redirects.
    const browser = `#!${process.execPath}\nfetch(process.argv[2], { redirect: 'follow' }).then((r) => r.text()).catch(() => {});\n`;
    for (const name of ['open', 'xdg-open']) {
        writeFileSync(join(bin, name), browser);
        chmodSync(join(bin, name), 0o755);
    }
    return { agentDir, env: { HOME: homeDir, PI_CODING_AGENT_DIR: agentDir, PATH: `${bin}:${process.env.PATH}`, DOCS_TOKEN: TOKEN } };
}

async function login(piBin: string, env: Record<string, string>, name: string): Promise<void> {
    const child = spawn(process.execPath, [piBin, 'mcp', 'login', name, '--timeout', '30'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout!.on('data', (d: Buffer) => (text += d.toString('utf8')));
    child.stderr!.on('data', (d: Buffer) => (text += d.toString('utf8')));
    assert.equal(await new Promise<number | null>((r) => child.on('exit', r)), 0, `pi mcp login failed: ${text.slice(-1000)}`);
}

async function listIn(piBin: string | undefined, h: ReturnType<typeof home>) {
    const pi = new Pi({ extensions: [EXTENSION], rules: RULES, agentDir: h.agentDir, env: h.env, piBin });
    stops.push(() => pi.stop());
    await pi.ready();
    await pi.prompt('list event types');
    return pi.toolResults('list_event_types').at(-1)!.text;
}

for (const [label, bin] of [['Pi as released', undefined], ['a Pi that lends its connection (MCP_PI_PATCHED_CLI)', PATCHED]] as const) {
    describe(`on ${label}`, { skip: label.startsWith('a Pi') && !PATCHED ? 'set MCP_PI_PATCHED_CLI to a patched Pi build' : false }, () => {
        test('a header-authenticated server: Events runs over the extension\'s own connection, on 2026-07-28', { timeout: 90_000 }, async () => {
            const srv = await server('token');
            const text = await listIn(bin, home({ tickets: { url: srv.url, headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } } }));
            assert.match(text, /"server": "tickets"/);
            assert.match(text, /"name": "ticket\.created"/);
            const listed = srv.requests().filter((r) => r.method === 'events/list');
            assert.ok(listed.length > 0 && listed.every((r) => r.auth && r.client === 'mcp-events-pi'), 'events/list went out on the extension\'s connection, with the credential');
        });

        test('an OAuth server: out of reach, and the extension says why', { timeout: 90_000 }, async () => {
            const srv = await server('oauth');
            const h = home({ tickets: { url: srv.url } });
            await login(bin ?? PI_BIN, h.env, 'tickets');
            const text = await listIn(bin, h);
            assert.match(text, /"unavailable"[\s\S]*"name": "tickets"/);
            assert.match(text, /needs a sign-in, which Pi holds for its own connection/);
            assert.ok(!srv.requests().some((r) => r.method === 'events/list'), 'no events/list was sent');
        });
    });
}
