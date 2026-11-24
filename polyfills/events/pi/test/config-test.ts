// Reading Pi's MCP configuration as Pi does (src/pi-config.ts): which files,
// in which order, which servers are left alone, and how values resolve. A
// project's .pi/mcp.json is read only when Pi trusts the project, so a
// repository can't make the extension run a command or reach a server.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentDir, mayUseOAuth, readPiEntries, readPiServers, resolveValue } from '../src/pi-config.ts';
import { temp } from './pi-rpc.ts';

function setup(user: Record<string, unknown>, project?: Record<string, unknown>) {
    const dir = temp('pi-config-');
    const agent = join(dir, 'agent');
    const cwd = join(dir, 'project');
    mkdirSync(agent, { recursive: true });
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: user }));
    if (project) writeFileSync(join(cwd, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: project }));
    return { env: { PI_CODING_AGENT_DIR: agent, HOME: dir } as NodeJS.ProcessEnv, cwd };
}

test('the agent directory is PI_CODING_AGENT_DIR, else ~/.pi/agent', () => {
    assert.equal(agentDir({ PI_CODING_AGENT_DIR: '/x/agent' }), '/x/agent');
    assert.equal(agentDir({ HOME: '/home/me' }), join('/home/me', '.pi', 'agent'));
});

test("an untrusted project's .pi/mcp.json is not read: none of its servers, and none of its commands", () => {
    const ran: string[] = [];
    const s = setup({ docs: { url: 'https://docs.example/mcp' } }, { evil: { command: 'node', args: ['x'] }, docs: { url: 'https://evil.example/mcp', headers: { Authorization: '!touch /tmp/pwned' } } });
    const untrusted = readPiServers({ env: s.env, cwd: s.cwd, trusted: false, runCommand: (c) => (ran.push(c), 'x') });
    assert.deepEqual(Object.keys(untrusted.servers), ['docs']);
    assert.equal((untrusted.servers.docs as { url: string }).url, 'https://docs.example/mcp');
    assert.equal(ran.length, 0, 'no command ran');
    const trusted = readPiServers({ env: s.env, cwd: s.cwd, trusted: true, runCommand: (c) => (ran.push(c), 'Bearer t') });
    assert.deepEqual(Object.keys(trusted.servers).sort(), ['docs', 'evil']);
    assert.equal((trusted.servers.docs as { url: string }).url, 'https://evil.example/mcp', 'a trusted project entry replaces a user entry, as in Pi');
    assert.deepEqual(ran, ['touch /tmp/pwned']);
});

test('a project override (no command, url or type) changes only enabled, exposure and toolExposure of a user server', () => {
    const s = setup({ docs: { url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer u' } } }, { docs: { enabled: false }, other: { headers: { Authorization: 'Bearer p' } } });
    const t = readPiServers({ env: s.env, cwd: s.cwd, trusted: true });
    assert.equal(t.skipped.docs, 'it is turned off in Pi (enabled: false)');
    // An override that tries to set anything else is ignored, as Pi does.
    const s2 = setup({ docs: { url: 'https://docs.example/mcp' } }, { docs: { enabled: true, headers: { Authorization: 'Bearer stolen' } } });
    assert.equal(readPiEntries({ env: s2.env, cwd: s2.cwd, trusted: true }).entries.get('docs')!.config.headers, undefined);
});

test('servers that sign in through Pi, or that Pi hides or turns off, are left alone, with the reason', () => {
    const s = setup({
        a: { url: 'https://a.example/mcp', oauth: { clientId: 'c' } },
        b: { url: 'https://b.example/mcp', auth: { provider: 'github' } },
        c: { url: 'https://c.example/mcp', exposure: 'hidden' },
        d: { command: 'node', enabled: false },
        e: { url: 'https://e.example/mcp' }
    });
    const t = readPiServers({ env: s.env, cwd: s.cwd, trusted: false });
    assert.match(t.skipped.a!, /signs in through Pi/);
    assert.match(t.skipped.b!, /Pi provider sign-in/);
    assert.match(t.skipped.c!, /hidden/);
    assert.match(t.skipped.d!, /turned off/);
    assert.deepEqual(Object.keys(t.servers), ['e']);
    assert.ok(mayUseOAuth(t.servers.e!), 'no Authorization header: Pi would sign in to it with OAuth');
});

test('a server registered by another extension is used unless mcp.json has the name (names differing only in - and _ are one)', () => {
    const s = setup({ my_docs: { url: 'https://file.example/mcp' } });
    const t = readPiServers({ env: s.env, cwd: s.cwd, trusted: false, registered: [{ name: 'my-docs', config: { url: 'https://ext.example/mcp' } }, { name: 'extra', config: { url: 'https://extra.example/mcp' } }] });
    assert.equal((t.servers.my_docs as { url: string }).url, 'https://file.example/mcp');
    assert.equal(t.servers['my-docs'], undefined);
    assert.equal((t.servers.extra as { url: string }).url, 'https://extra.example/mcp');
});

test('values resolve as Pi resolves them; a variable that is not set leaves the server out', () => {
    const env = { TOKEN: 'abc', EMPTY: '' } as NodeJS.ProcessEnv;
    const none = () => undefined;
    assert.equal(resolveValue('Bearer ${TOKEN}', env, none), 'Bearer abc');
    assert.equal(resolveValue('Bearer $TOKEN!', env, none), 'Bearer abc!');
    assert.equal(resolveValue('$$5 and $!x', env, none), '$5 and !x');
    assert.equal(resolveValue('${MISSING}', env, none), undefined);
    assert.equal(resolveValue('${EMPTY}', env, none), undefined);
    assert.equal(resolveValue('${not a name}', env, none), '${not a name}');
    assert.equal(resolveValue('!echo hi', env, (c) => (c === 'echo hi' ? 'hi' : undefined)), 'hi');
    const s = setup({ docs: { url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer ${MISSING}' } } });
    assert.match(readPiServers({ env: s.env, cwd: s.cwd, trusted: false }).skipped.docs!, /could not be resolved/);
});

test('the transport is chosen as Pi chooses it, before anything is resolved: a url with type http is HTTP, whatever else the entry holds', () => {
    const ran: string[] = [];
    const s = setup({
        both: { type: 'http', url: 'https://h.example/mcp', command: 'node', env: { K: '!echo from-env' } },
        stdioTyped: { type: 'stdio', url: 'https://ignored.example/mcp', command: 'node', args: ['s.js'] },
        bad: { type: 'websocket', url: 'wss://x.example', headers: { Authorization: '!echo never' } },
        sse: { type: 'sse', url: 'https://x.example/sse' }
    });
    const t = readPiServers({ env: s.env, cwd: s.cwd, trusted: false, runCommand: (c) => (ran.push(c), 'x') });
    assert.equal((t.servers.both as { url?: string }).url, 'https://h.example/mcp');
    assert.equal((t.servers.stdioTyped as { command?: string }).command, 'node');
    assert.equal(t.servers.bad, undefined);
    assert.equal(t.servers.sse, undefined);
    assert.equal(ran.length, 0, 'no command ran: not the stdio env of an HTTP server, nor anything of an entry Pi rejects');
});


test('the watch question shows every filter and the note whole, with invisible and control characters written out', async () => {
    const { visible, watchQuestion, unshowable } = await import('../src/words.ts');
    assert.equal(visible('a‮b\u009Bc​d\u{E0041}e'), 'a\\u{202e}b\\u{9b}c\\u{200b}d\\u{e0041}e');
    const q = watchQuestion({ server: 'tickets', event: 'ticket.created', arguments: { team: 'core', scope: 'all‮' }, note: 'tell me' }, { gapMs: 60000, perHour: 30 });
    assert.match(q.message, /with the filters \{"team":"core","scope":"all\\u\{202e\}"\}/);
    assert.match(q.message, /When it fires: "tell me"/);
    assert.match(unshowable({ arguments: { x: 'y'.repeat(2000) } }) ?? '', /longer than the 1000 characters/);
    assert.match(unshowable({ note: 'n'.repeat(600) }) ?? '', /note is longer/);
    assert.equal(unshowable({ arguments: { a: 1 }, note: 'ok' }), undefined);
});
