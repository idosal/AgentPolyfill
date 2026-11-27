import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BRAIN, Pi, temp, waitFor, type PiOptions, type Rule } from '../../../events/pi/test/pi-rpc.ts';

const extension = fileURLToPath(new URL('../extension', import.meta.url));
const fixture = fileURLToPath(new URL('../../codex/test/fixture-tasks-server.mjs', import.meta.url));
const piBin = fileURLToPath(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
const rules: Rule[] = [
    { when: '^start (\\S+)$', call: { name: 'start_task', args: { server: 'jobs', tool: '$1', arguments: { text: 'approved payload' } } } },
    { when: '^\\[mcp-tasks\\].* Task (t-[0-9a-f]{6}) .* has finished', call: { name: 'get_task_result', args: { task: '$1' } } },
    { when: '^\\[mcp-tasks\\].* Task (t-[0-9a-f]{6}) .* needs input', call: { name: 'provide_task_input', args: { task: '$1' } } },
    { when: '^list$', call: { name: 'list_task_servers', args: {} } }
];

function world(opts: { old?: boolean; hidden?: boolean; excluded?: boolean; pattern?: boolean } = {}) {
    const dir = temp('pi-tasks-');
    const agentDir = join(dir, 'agent');
    mkdirSync(agentDir);
    const log = join(dir, 'mcp.jsonl');
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { jobs: {
        command: process.execPath, args: [fixture], env: {
            FIXTURE_LOG: log, FIXTURE_TASK_MS: '1400', ...(opts.old ? { FIXTURE_OLD_FORM: '1' } : {}),
            ...(opts.pattern ? { FIXTURE_PATTERN_FORM: '1' } : {})
        },
        ...(opts.hidden ? { toolExposure: { 'sl*': 'hidden' } } : {})
    } } }));
    return { dir, agentDir, requests: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []) };
}

function launch(w: ReturnType<typeof world>, options: Partial<PiOptions> = {}) {
    return new Pi({
        piBin, extensions: [extension], rules, cwd: w.dir, agentDir: w.agentDir,
        answer: (question) => question.options?.at(-1),
        ...options
    });
}

test('Pi RPC shows the exact start arguments, runs the task, and wakes the idle session to retrieve the result', { timeout: 30000 }, async () => {
    const w = world();
    const pi = launch(w);
    try {
        await pi.ready();
        await pi.prompt('start slow');
        const prompt = pi.ui.find((q) => q.title?.startsWith('Start MCP task'));
        assert.ok(prompt);
        assert.equal(prompt.options?.[0], 'Decline');
        assert.match(String(prompt.title), /jobs[\s\S]*Tool: slow[\s\S]*"text": "approved payload"/);
        assert.match(pi.toolResults('start_task')[0]?.text ?? '', /Started task t-/);
        const result = await waitFor(() => pi.toolResults('get_task_result')[0], 15000, 'the idle wake and result');
        assert.match(result.text, /done: approved payload/);
        const wake = pi.messages('custom').find((message) => message.customType === 'mcp-tasks');
        assert.ok(wake);
        assert.doesNotMatch(String(wake.content), /approved payload/);
        const call = w.requests().find((r) => r.method === 'tools/call');
        assert.deepEqual(call?.params.arguments, { text: 'approved payload' });
        assert.deepEqual(call?.params._meta['io.modelcontextprotocol/clientCapabilities'].extensions, { 'io.modelcontextprotocol/tasks': {} });
    } finally { await pi.stop(); rmSync(w.dir, { recursive: true, force: true }); }
});

test('declining the Pi approval prevents tools/call', { timeout: 20000 }, async () => {
    const w = world();
    const pi = launch(w, { answer: (q) => q.options?.[0] });
    try {
        await pi.ready(); await pi.prompt('start slow');
        assert.equal(pi.ui.filter((q) => q.title?.startsWith('Start MCP task')).length, 1);
        assert.match(pi.toolResults('start_task')[0]?.text ?? '', /chose not to start/);
        assert.ok(!w.requests().some((r) => r.method === 'tools/call'));
    } finally { await pi.stop(); rmSync(w.dir, { recursive: true, force: true }); }
});

test('Pi collects task input from the person and sends the validated answer', { timeout: 30000 }, async () => {
    const w = world();
    const pi = launch(w, { answer: (q) => q.method === 'input' ? '{"name":"Luca"}' : q.options?.at(-1) });
    try {
        await pi.ready(); await pi.prompt('start ask');
        const response = await waitFor(() => w.requests().find((r) => r.method === 'tasks/update'), 15000, 'the answer sent to the Tasks server');
        assert.equal(pi.ui.filter((q) => q.method === 'input').length, 1);
        assert.match(String(pi.ui.find((q) => q.title?.startsWith('MCP task input'))?.title), /jobs[\s\S]*What is your name/);
        assert.deepEqual(response.params.inputResponses.k1, { action: 'accept', content: { name: 'Luca' } });
    } finally { await pi.stop(); rmSync(w.dir, { recursive: true, force: true }); }
});

test('Pi reports an unsupported form and sends no input response', { timeout: 30000 }, async () => {
    const w = world({ pattern: true });
    const pi = launch(w);
    try {
        await pi.ready(); await pi.prompt('start ask');
        const result = await waitFor(() => pi.toolResults('provide_task_input')[0], 15000, 'the unsupported form result');
        assert.match(result.text, /cannot represent safely/);
        assert.equal(pi.ui.length, 1);
        assert.ok(!w.requests().some((req) => req.method === 'tasks/update'));
    } finally { await pi.stop(); rmSync(w.dir, { recursive: true, force: true }); }
});

for (const option of [{ old: true }, { hidden: true }, { excluded: true }]) test(`Pi leaves an ${option.old ? 'old-only server' : option.excluded ? 'excluded tool' : 'unexposed tool'} alone`, { timeout: 20000 }, async () => {
    const w = world(option);
    const pi = launch(w, { args: option.excluded ? ['--exclude-tools', 'mcp__jobs__slow'] : [] });
    try {
        await pi.ready(); await pi.prompt('start slow');
        assert.equal(pi.ui.length, 0);
        assert.ok(!w.requests().some((r) => r.method === 'tools/call'));
        assert.match(pi.toolResults('start_task')[0]?.text ?? '', option.old ? /experimental form/ : /config doesn't let Pi use/);
    } finally { await pi.stop(); rmSync(w.dir, { recursive: true, force: true }); }
});

test('Pi print mode cannot start a task without a person to ask', { timeout: 20000 }, () => {
    const w = world();
    const home = join(w.dir, 'home');
    mkdirSync(home);
    try {
        const output = execFileSync(process.execPath, [
            piBin, '--offline', '--mode', 'json', '--no-session', '--provider', 'scripted', '--model', 'm1',
            '-e', BRAIN, '-e', extension, '-p', 'start slow'
        ], {
            cwd: w.dir, encoding: 'utf8', timeout: 15000,
            env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: w.agentDir, PI_TEST_RULES: JSON.stringify(rules) }
        });
        assert.match(output, /the user could not be asked/);
        assert.ok(!w.requests().some((req) => req.method === 'tools/call'));
    } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('Pi --no-mcp prevents the extension from contacting the server', { timeout: 20000 }, async () => {
    const w = world();
    const pi = launch(w, { args: ['--no-mcp'] });
    try {
        await pi.ready(); await pi.prompt('start slow');
        assert.match(pi.toolResults('start_task')[0]?.text ?? '', /unavailable in this Pi session/);
        assert.equal(pi.ui.length, 0);
        assert.deepEqual(w.requests(), []);
    } finally { await pi.stop(); rmSync(w.dir, { recursive: true, force: true }); }
});

test('a second Pi window defers task starts until the first closes', { timeout: 25000 }, async () => {
    const w = world();
    const sessionDir = join(w.dir, 'sessions');
    const first = launch(w, { sessionDir });
    let second: Pi | undefined;
    try {
        await first.ready(); await first.prompt('list');
        const file = readdirSync(sessionDir).find((name) => name.endsWith('.jsonl'));
        assert.ok(file);
        second = launch(w, { session: join(sessionDir, file) });
        await second.ready(); await second.prompt('start slow');
        assert.match(second.toolResults('start_task')[0]?.text ?? '', /Another window is handling tasks/);
        assert.equal(second.ui.length, 0);
        assert.ok(!w.requests().some((req) => req.method === 'tools/call'));
        await first.stop();
        await second.prompt('start slow');
        assert.match(second.toolResults('start_task').at(-1)?.text ?? '', /Started task t-/);
        assert.equal(w.requests().filter((req) => req.method === 'tools/call').length, 1);
    } finally {
        if (second) await second.stop();
        await first.stop();
        rmSync(w.dir, { recursive: true, force: true });
    }
});
