// Which connection a served skill comes over, against a Streamable HTTP server
// behind a credential, in a real isolated Pi:
//
//   - header-authenticated (`Authorization: Bearer ${DOCS_TOKEN}` in mcp.json):
//     on Pi 1.6.0 the extension's own connection reaches it, with the header
//     resolved as Pi resolves it;
//   - OAuth (Pi signs in with `pi mcp login`, in the test's own home): on Pi
//     1.6.0 the extension cannot reach it, since Pi keeps that sign-in to itself,
//     and says why.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scenarioOf, skill } from './harness.ts';
import { Pi, PI_BIN, temp, waitFor, type Rule } from './pi-rpc.ts';

const EXTENSION = fileURLToPath(new URL('../extension/dist/index.js', import.meta.url));
const HTTP_FIXTURE = fileURLToPath(new URL('../../../events/pi/test/http-fixture.ts', import.meta.url));
const SKILLS_FIXTURE = fileURLToPath(new URL('../../core/test-fixtures/fixture-skills-server.ts', import.meta.url));
/** A test credential, made up for this test. */
const TOKEN = 'test-token-for-the-fixture';

const RULES: Rule[] = [
    { when: 'call the `load_skill` tool[\\s\\S]*?"server": "([^"]+)",\\s*"uri": "([^"]+)"', call: { name: 'load_skill', args: { server: '$1', uri: '$2' } } },
    { when: '^list served skills$', call: { name: 'list_skills', args: {} } }
];

type Logged = { method?: string; auth: boolean; session: string | null; client: string | null };
const stops: (() => Promise<void> | void)[] = [];
// The folders these tests make, removed when they end, passed or failed: one holds the sign-in Pi
// keeps (mcp-auth.json, with tokens the fixture issued), and none is left behind.
const made: string[] = [];
after(async () => {
    for (const s of stops.reverse()) await s();
    for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** The HTTP front, serving one skill, behind a fixed token or OAuth. */
async function server(mode: 'token' | 'oauth') {
    const dir = temp('mcp-skills-http-');
    made.push(dir);
    const s = skill('git-workflow', {}, { description: 'Branching and commit conventions.' });
    const scenario = join(dir, 'scenario.json');
    writeFileSync(scenario, JSON.stringify(scenarioOf([s])));
    const log = join(dir, 'http.jsonl');
    const env = { ...process.env, FIXTURE_SCENARIO: scenario, ...(mode === 'token' ? { FIXTURE_TOKEN: TOKEN } : { FIXTURE_OAUTH: '1' }) };
    const child: ChildProcess = spawn(process.execPath, ['--no-warnings', HTTP_FIXTURE, SKILLS_FIXTURE, '0', log], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    stops.push(() => void child.kill());
    let out = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString('utf8')));
    const port = await waitFor(() => /listening (\d+)/.exec(out)?.[1], 10000, 'the HTTP fixture');
    return {
        url: `http://127.0.0.1:${port}/mcp`,
        uri: s.uri,
        requests: (): Logged[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Logged) : [])
    };
}

/** An isolated Pi home and agent directory, with `open` and `xdg-open` standing in for the browser: they follow the sign-in page's redirects, as a person approving it would. */
function home(servers: Record<string, unknown>) {
    const dir = temp('mcp-skills-home-');
    made.push(dir);
    const agentDir = join(dir, 'agent');
    const homeDir = join(dir, 'home');
    const bin = join(dir, 'bin');
    for (const d of [agentDir, homeDir, bin]) mkdirSync(d, { recursive: true });
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
    const browser = `#!${process.execPath}\nfetch(process.argv[2], { redirect: 'follow' }).then((r) => r.text()).catch(() => {});\n`;
    for (const name of ['open', 'xdg-open']) {
        writeFileSync(join(bin, name), browser);
        chmodSync(join(bin, name), 0o755);
    }
    const env = { HOME: homeDir, PI_CODING_AGENT_DIR: agentDir, PATH: `${bin}:${process.env.PATH}`, DOCS_TOKEN: TOKEN };
    return { agentDir, env };
}

/** `pi mcp login <name>`: Pi's own sign-in, into the isolated agent directory. The test never reads what it stores. */
async function login(piBin: string, env: Record<string, string>, name: string): Promise<void> {
    const child = spawn(process.execPath, [piBin, 'mcp', 'login', name, '--timeout', '30'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout!.on('data', (d: Buffer) => (text += d.toString('utf8')));
    child.stderr!.on('data', (d: Buffer) => (text += d.toString('utf8')));
    const code = await new Promise<number | null>((r) => child.on('exit', r));
    assert.equal(code, 0, `pi mcp login failed: ${text.slice(-1000)}`);
}

async function loadIn(piBin: string | undefined, h: ReturnType<typeof home>) {
    const pi = new Pi({ extensions: [EXTENSION], rules: RULES, agentDir: h.agentDir, env: h.env, piBin, answer: (r) => (r.method === 'select' ? 'Load it' : undefined) });
    stops.push(() => pi.stop());
    await pi.ready();
    await pi.prompt('list served skills');
    await pi.prompt('/skill:mcp-docs-git-workflow');
    return pi;
}

describe('on Pi as released (the extension\'s own connection)', () => {
    test('a header-authenticated server is reached with the header resolved as Pi resolves it', { timeout: 90_000 }, async () => {
        const srv = await server('token');
        const h = home({ docs: { url: srv.url, headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } } });
        const pi = await loadIn(undefined, h);
        const loaded = pi.toolResults('load_skill').at(-1);
        assert.ok(loaded && !loaded.isError, `load_skill: ${loaded?.text}`);
        const mine = srv.requests().filter((r) => r.method === 'skills/list');
        assert.ok(mine.length > 0 && mine.every((r) => r.auth), 'skills/list went out with the credential');
    });

    test('an OAuth server Pi signed in to is out of the extension\'s reach, and it says why', { timeout: 90_000 }, async () => {
        const srv = await server('oauth');
        const h = home({ docs: { url: srv.url } });
        await login(PI_BIN, h.env, 'docs');
        const pi = await loadIn(undefined, h);
        const listed = pi.toolResults('list_skills').at(-1)!;
        assert.match(listed.text, /Not used: "docs": it needs a sign-in, which Pi holds for its own connection/);
        // Pi's own connection is signed in; the extension's was refused.
        assert.ok(srv.requests().some((r) => r.client === 'pi' && r.auth), 'Pi itself is signed in');
        assert.ok(!srv.requests().some((r) => r.method === 'skills/list' && r.auth), 'no skills/list got through');
    });
});
