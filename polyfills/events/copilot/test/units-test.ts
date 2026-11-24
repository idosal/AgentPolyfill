// Reading Copilot's MCP configuration, which messages count as the person's, and the wake's answer.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { expand, parseServer, readCopilotServers, workspaceFiles } from '../src/copilot-config.ts';
import { isThePersons, sendWake } from '../src/waker.ts';
import { temp } from './harness.ts';

const home = () => {
    const dir = temp('mcp-events-copilot-units-');
    const h = join(dir, 'home');
    mkdirSync(h);
    return { dir, h, env: { COPILOT_HOME: h } as NodeJS.ProcessEnv };
};
const write = (path: string, j: unknown) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof j === 'string' ? j : JSON.stringify(j));
};

describe('a server entry', () => {
    test('local and stdio servers keep their command, args, env and cwd (relative to the file)', () => {
        assert.deepEqual(parseServer({ type: 'local', command: 'npx', args: ['-y', 'x'], env: { K: 'v' }, cwd: 'sub' }, {}, '/base'), { command: 'npx', args: ['-y', 'x'], env: { K: 'v' }, cwd: '/base/sub' });
        assert.deepEqual(parseServer({ type: 'stdio', command: 'x' }, {}, '/b'), { command: 'x', args: [], env: undefined, cwd: undefined });
    });

    test('${VAR} is expanded from this extension\'s environment, as Copilot does, in url, headers, args and env', () => {
        const env = { TOKEN: 't0k', Q: 'qv', P: '/p' };
        assert.deepEqual(parseServer({ type: 'http', url: 'https://x.example/mcp?k=${Q}', headers: { Authorization: 'Bearer ${TOKEN}', 'X-Mixed': 'a-${TOKEN}-b' } }, env, '/'), {
            url: 'https://x.example/mcp?k=qv',
            headers: { Authorization: 'Bearer t0k', 'X-Mixed': 'a-t0k-b' }
        });
        assert.deepEqual(parseServer({ command: '${P}/bin', args: ['${Q}'], env: { A: '${TOKEN}' } }, env, '/'), { command: '/p/bin', args: ['qv'], env: { A: 't0k' }, cwd: undefined });
        const missing = new Set<string>();
        assert.equal(expand('${NOPE}x', {}, missing), '${NOPE}x');
        assert.deepEqual([...missing], ['NOPE']);
    });

    test('a server that needs a variable this extension lacks is left out, naming it', () => {
        const r = parseServer({ type: 'http', url: 'https://x.example', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } }, {}, '/');
        assert.ok('skip' in r);
        assert.match(r.skip, /GITHUB_TOKEN/);
        assert.match(r.skip, /strips sensitive variables/);
    });

    test('SSE servers, OAuth servers and unknown transports are left out with the reason', () => {
        assert.match((parseServer({ type: 'sse', url: 'https://x.example/sse' }, {}, '/') as { skip: string }).skip, /SSE/);
        assert.match((parseServer({ type: 'http', url: 'https://x.example', oauth: {} }, {}, '/') as { skip: string }).skip, /signs in through Copilot/);
        assert.match((parseServer({ type: 'ws', url: 'wss://x.example' }, {}, '/') as { skip: string }).skip, /not supported/);
        assert.match((parseServer({}, {}, '/') as { skip: string }).skip, /not supported/);
    });
});

describe('the files Copilot reads', () => {
    test('workspace files from the repository root down to the working folder; .github/mcp.json is ignored where .mcp.json is', () => {
        const { dir } = home();
        const repo = join(dir, 'repo');
        mkdirSync(join(repo, '.git'), { recursive: true });
        write(join(repo, '.github', 'mcp.json'), { mcpServers: {} });
        write(join(repo, '.mcp.json'), { mcpServers: {} });
        write(join(repo, 'pkg', '.github', 'mcp.json'), { mcpServers: {} });
        mkdirSync(join(repo, 'pkg', 'deep'), { recursive: true });
        assert.deepEqual(workspaceFiles(join(repo, 'pkg', 'deep')), [join(repo, '.mcp.json'), join(repo, 'pkg', '.github', 'mcp.json')]);
    });

    test('a nearer file wins over the user file; what Copilot lists decides which are used', () => {
        const { dir, h, env } = home();
        const repo = join(dir, 'repo');
        mkdirSync(join(repo, '.git'), { recursive: true });
        write(join(h, 'mcp-config.json'), { mcpServers: { a: { command: 'from-user' }, b: { command: 'b' } } });
        write(join(repo, '.mcp.json'), { mcpServers: { a: { command: 'from-repo' } } });
        const t = readCopilotServers(env, () => {}, {
            cwd: repo,
            configured: [
                { name: 'a', enabled: true, source: 'workspace' },
                { name: 'b', enabled: false, source: 'user' }
            ]
        });
        assert.deepEqual(Object.keys(t.servers), ['a']);
        assert.equal((t.servers.a as { command: string }).command, 'from-repo');
        assert.deepEqual(t.skipped, {});
    });

    test('when Copilot cannot list its servers: disabledMcpServers is honoured, and workspace files are read only in a trusted folder', () => {
        const { dir, h, env } = home();
        const repo = join(dir, 'repo');
        mkdirSync(join(repo, '.git'), { recursive: true });
        write(join(h, 'mcp-config.json'), { mcpServers: { a: { command: 'a' }, off: { command: 'o' } } });
        write(join(h, 'settings.json'), '// comment\n{ "disabledMcpServers": ["off"] }');
        write(join(repo, '.mcp.json'), { mcpServers: { w: { command: 'w' } } });
        const untrusted = readCopilotServers(env, () => {}, { cwd: repo });
        assert.deepEqual(Object.keys(untrusted.servers), ['a']);
        assert.match(untrusted.skipped.off!, /disabledMcpServers/);
        write(join(h, 'config.json'), `// managed\n${JSON.stringify({ trustedFolders: [repo] })}`);
        assert.deepEqual(Object.keys(readCopilotServers(env, () => {}, { cwd: repo }).servers).sort(), ['a', 'w']);
    });

    test('MCP_EVENTS_CONFIG replaces Copilot\'s files; MCP_EVENTS_SERVERS and MCP_EVENTS_SKIP narrow them', () => {
        const { dir, env } = home();
        const own = join(dir, 'mine.json');
        write(own, { mcpServers: { x: { command: 'x' }, y: { command: 'y' }, z: { command: 'z' } } });
        const t = readCopilotServers({ ...env, MCP_EVENTS_CONFIG: own, MCP_EVENTS_SERVERS: 'x,y', MCP_EVENTS_SKIP: 'y' }, () => {}, { cwd: dir, configured: [] });
        assert.deepEqual(Object.keys(t.servers), ['x']);
        assert.match(t.skipped.y!, /excluded/);
        assert.match(t.skipped.z!, /excluded/);
    });

    test('a file that is not JSON is logged and its servers left out', () => {
        const { h, env } = home();
        write(join(h, 'mcp-config.json'), '{ "mcpServers": { , }');
        const lines: string[] = [];
        const t = readCopilotServers(env, (s) => lines.push(s), { cwd: h });
        assert.deepEqual(t.servers, {});
        assert.match(lines.join('\n'), /could not be read/);
    });
});

describe('the person, and the wake', () => {
    test('only a root user.message with no source, or "user", is the person\'s', () => {
        assert.equal(isThePersons({}), true);
        assert.equal(isThePersons({ source: 'user' }), true);
        for (const source of ['automation-mcp-events', 'automation-other', 'system', 'skill-pdf', 'agent-123']) assert.equal(isThePersons({ source }), false, source);
        assert.equal(isThePersons({}, 'sub-agent-1'), false);
        assert.equal(isThePersons(undefined), false);
    });

    test('sendWake: admitted is ok; refused is retried; no answer is "maybe", never sent twice', async () => {
        const seen: unknown[] = [];
        assert.deepEqual(await sendWake({ send: async (o) => (seen.push(o), 'm1') }, 'hi'), { ok: true, resumed: true });
        assert.deepEqual(seen, [{ prompt: 'hi', source: 'automation-mcp-events', mode: 'enqueue' }]);
        const refused = await sendWake({ send: async () => Promise.reject(new Error('Session not found\nstack')) }, 'hi');
        assert.deepEqual(refused, { ok: false, why: 'Copilot refused the message (Session not found)' });
        const late = await sendWake({ send: () => new Promise(() => {}) }, 'hi', 50);
        assert.equal(late.ok, false);
        assert.equal((late as { maybe?: true }).maybe, true);
    });
});
