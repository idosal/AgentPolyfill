import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Pi, temp, waitFor } from '../../../../events/pi/test/pi-rpc.ts';

const plugin = fileURLToPath(new URL('../../extension', import.meta.url));
const piBin = fileURLToPath(new URL('../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
const server = fileURLToPath(new URL('../../../codex/test/interop/fastmcp_server.py', import.meta.url));

async function freePort(): Promise<number> {
    const listener = createServer();
    return new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', () => {
            const address = listener.address();
            assert.ok(address && typeof address !== 'string');
            listener.close((error) => error ? reject(error) : resolve(address.port));
        });
    });
}

test('real Pi completes a FastMCP task and answers an in-task form over HTTP', { timeout: 60_000 }, async () => {
    const python = process.env.MCP_TASKS_INTEROP_PYTHON;
    assert.ok(python, 'Set MCP_TASKS_INTEROP_PYTHON to the Python from the pinned FastMCP test environment.');
    const port = await freePort();
    const endpoint = `http://127.0.0.1:${port}/mcp`;
    const dir = temp('pi-tasks-fastmcp-');
    const agentDir = join(dir, 'agent');
    const home = join(dir, 'home');
    mkdirSync(home);
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { jobs: { url: endpoint } } }));
    const child = spawn(python, ['-I', server, String(port)], {
        cwd: dir,
        env: { HOME: home, PATH: dirname(python), LANG: 'C.UTF-8' },
        stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk).slice(-5000); });
    let spawnError: Error | undefined;
    child.once('error', (error) => { spawnError = error; });
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    let pi: Pi | undefined;
    try {
        await waitFor(async () => {
            if (spawnError || child.exitCode !== null) throw new Error(`FastMCP failed to listen: ${spawnError?.message ?? stderr}`);
            try {
                return (await fetch(endpoint, { method: 'POST', body: '{}', signal: AbortSignal.timeout(1000) })).status > 0;
            } catch {
                return false;
            }
        }, 15_000, 'FastMCP to listen');
        pi = new Pi({
            extensions: [plugin], piBin, agentDir, cwd: dir,
            answer: (question) => question.method === 'input' ? '{"name":"Luca"}' : question.options?.at(-1),
            rules: [
                { when: '^add$', call: { name: 'start_task', args: { server: 'jobs', tool: 'slow_add', arguments: { a: 2, b: 40, seconds: 1 } } } },
                { when: '^greet$', call: { name: 'start_task', args: { server: 'jobs', tool: 'greet', arguments: {} } } },
                { when: '^\\[mcp-tasks\\].* Task (t-[0-9a-f]{6}) .* has finished', call: { name: 'get_task_result', args: { task: '$1' } } },
                { when: '^\\[mcp-tasks\\].* Task (t-[0-9a-f]{6}) .* needs input', call: { name: 'provide_task_input', args: { task: '$1' } } },
                { when: '^result (t-[0-9a-f]{6})$', call: { name: 'get_task_result', args: { task: '$1' } } }
            ]
        });
        const session = pi;
        await session.ready();
        await session.prompt('add');
        const sum = await waitFor(() => session.toolResults('get_task_result')[0], 15_000, 'the FastMCP completion wake');
        assert.match(sum.text, /2 \+ 40 = 42/);
        await session.prompt('greet');
        const sent = await waitFor(() => session.toolResults('provide_task_input')[0], 15_000, 'the FastMCP form and answer');
        assert.match(sent.text, /Sent 1 answer/);
        assert.ok(session.ui.some((question) => question.method === 'select' && /What is your name/.test(question.title ?? '')));
        assert.ok(session.ui.some((question) => question.method === 'input' && question.title === 'Answer for the MCP server (JSON)'));
        const task = session.toolResults('start_task')[1]?.text.match(/\b(t-[0-9a-f]{6})\b/)?.[1];
        assert.ok(task);
        const persisted = join(agentDir, 'mcp-tasks', 'threads');
        const [sessionId] = readdirSync(persisted);
        assert.ok(sessionId);
        const taskFile = join(persisted, sessionId, 'tasks.json');
        await waitFor(() => {
            const state = JSON.parse(readFileSync(taskFile, 'utf8')) as { tasks: { id: string; outcome: string }[] };
            return state.tasks.some((record) => record.id === task && record.outcome === 'completed');
        }, 15_000, 'Pi to poll the completed task');
        await session.prompt(`result ${task}`);
        assert.match(session.toolResults('get_task_result').at(-1)?.text ?? '', /Hello, Luca!/);
    } finally {
        try {
            await pi?.stop();
        } finally {
            child.kill();
            const force = setTimeout(() => child.kill('SIGKILL'), 2000);
            await closed;
            clearTimeout(force);
            rmSync(dir, { recursive: true, force: true });
        }
    }
});
