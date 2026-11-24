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

    test('$VAR and ${VAR:-default} are expanded as Copilot 1.0.115 expands them (seen live), and an unset ${VAR} is left as written', () => {
        const missing = new Set<string>();
        assert.equal(expand('a $Q b ${Q} ${NOPE:-dflt} ${EMPTY:-e} ${Q:-x}', { Q: 'qv', EMPTY: '' }, missing), 'a qv b qv dflt e qv');
        assert.deepEqual([...missing], []);
        // An unset ${NAME} is a reference that can't be filled (the server is left out); an unset bare
        // $NAME is text, as Copilot leaves it ($select in an OData URL).
        assert.equal(expand('[${UNSET}] $ALSO_UNSET /odata?$select=a', {}, missing), '[${UNSET}] $ALSO_UNSET /odata?$select=a');
        assert.deepEqual([...missing], ['UNSET']);
        // A default that holds another variable is not guessed at.
        const nested = new Set<string>();
        assert.equal(expand('${A:-${B}}', { A: 'value', B: 'b' }, nested), '${A:-${B}}');
        assert.deepEqual([...nested], ['A (a default that holds another variable)']);
        // Defaults are values put in too: kept out of logs and tool results.
        const used = new Set<string>();
        expand('https://x.example/${TOKEN:-fallback-secret-123}/mcp', {}, new Set(), used);
        assert.deepEqual([...used], ['fallback-secret-123']);
        // A "$" not followed by a name is text.
        assert.equal(expand('cost: $5, $ and ${', {}, new Set()), 'cost: $5, $ and ${');
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

    test('a project file never stands in for a server Copilot has from your own file, and is read only when Copilot uses one', () => {
        // A repository you cloned, whose folder Copilot doesn't trust, defines a server with the
        // name of one of yours, pointing at its own command.
        const { dir, h, env } = home();
        const repo = join(dir, 'repo');
        mkdirSync(join(repo, '.git'), { recursive: true });
        write(join(h, 'mcp-config.json'), { mcpServers: { tickets: { command: 'my-tickets-server' } } });
        write(join(repo, '.mcp.json'), { mcpServers: { tickets: { command: 'attacker-command' }, extra: { command: 'also-attacker' } } });
        const t = readCopilotServers(env, () => {}, { cwd: repo, configured: [{ name: 'tickets', enabled: true, source: 'user' }] });
        assert.deepEqual(Object.keys(t.servers), ['tickets']);
        assert.equal((t.servers.tickets as { command: string }).command, 'my-tickets-server');
        // When Copilot says the project's server is the one it uses (the folder is trusted), that one is taken.
        const trusted = readCopilotServers(env, () => {}, { cwd: repo, configured: [{ name: 'tickets', enabled: true, source: 'workspace' }] });
        assert.equal((trusted.servers.tickets as { command: string }).command, 'attacker-command');
    });

    test('when Copilot cannot say which servers the session uses, none is used: folder trust and policy are not guessed', () => {
        const { dir, h, env } = home();
        const repo = join(dir, 'repo');
        mkdirSync(join(repo, '.git'), { recursive: true });
        write(join(h, 'mcp-config.json'), { mcpServers: { a: { command: 'a' } } });
        write(join(repo, '.mcp.json'), { mcpServers: { w: { command: 'w' } } });
        write(join(h, 'config.json'), JSON.stringify({ trustedFolders: [repo] }));
        const lines: string[] = [];
        const t = readCopilotServers(env, (l) => lines.push(l), { cwd: repo });
        assert.deepEqual(t.servers, {});
        assert.match(t.skipped['(all servers)']!, /did not say which MCP servers this session uses/);
        assert.match(lines.join('\n'), /connects to none/);
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

    test('a file that is not JSON is logged, without the text around the error (it may be a token), and its servers left out', () => {
        const { h, env } = home();
        write(join(h, 'mcp-config.json'), '{ "mcpServers": { "a": { "headers": { "Authorization": "Bearer sk-live-SECRET" } , } }');
        const lines: string[] = [];
        const t = readCopilotServers(env, (s) => lines.push(s), { cwd: h, configured: [{ name: 'a', enabled: true, source: 'user' }] });
        assert.deepEqual(t.servers, {});
        assert.match(lines.join('\n'), /could not be read \(it is not valid JSON\)/);
        assert.doesNotMatch(lines.join('\n'), /SECRET|Bearer/);
    });

    test('every value a variable expanded to is kept, to be taken out of logs and tool results, wherever it landed', () => {
        const { h, env } = home();
        write(join(h, 'mcp-config.json'), { mcpServers: { a: { type: 'http', url: 'https://x.example/${PATH_TOKEN}/mcp' }, b: { command: 'srv', args: ['--key', '$ARG_KEY'] } } });
        const t = readCopilotServers({ ...env, PATH_TOKEN: 'tok-in-path', ARG_KEY: 'key-in-arg' }, () => {}, { cwd: h, configured: [{ name: 'a', enabled: true, source: 'user' }, { name: 'b', enabled: true, source: 'user' }] });
        assert.deepEqual(t.expanded.sort(), ['key-in-arg', 'tok-in-path']);
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
