import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { start, type Join } from '../src/main.ts';

const fixture = fileURLToPath(new URL('../../codex/test/fixture-tasks-server.mjs', import.meta.url));

test('Copilot declines without a call and routes an accepted task and its answer through the joined session', { timeout: 20_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), 'copilot-tasks-'));
    const log = join(home, 'fixture.jsonl');
    writeFileSync(log, '');
    mkdirSync(join(home, 'state'));
    writeFileSync(join(home, 'mcp-config.json'), JSON.stringify({ mcpServers: { jobs: {
        type: 'local', command: process.execPath, args: [fixture], env: { FIXTURE_LOG: log, FIXTURE_TASK_MS: '1600' }
    } } }));
    const sessionId = randomUUID();
    type Admit = Parameters<Join>[0]['tools'];
    let tools: Admit;
    const wakes: Parameters<Awaited<ReturnType<Join>>['send']>[0][] = [];
    const questions: string[] = [];
    let allow = false;
    const runtime = await start(async (config) => {
        tools = config.tools;
        return {
            sessionId,
            on: () => () => {},
            send: async (message) => { wakes.push(message); return randomUUID(); },
            capabilities: { ui: { elicitation: true } },
            rpc: { mcp: { listConfigured: async () => ({ servers: [{ name: 'jobs', enabled: true, source: 'user' }] }) } },
            ui: { elicitation: async ({ message, requestedSchema }) => {
                questions.push(message);
                const decision = (requestedSchema.properties as { decision?: { enum: string[] } }).decision?.enum.at(-1);
                return allow ? { action: 'accept', content: decision ? { decision } : { name: 'Luca' } } : { action: 'decline' };
            } }
        };
    }, { COPILOT_HOME: home, MCP_TASKS_STATE: join(home, 'state') });
    const run = (name: string, args: Record<string, unknown>, id = sessionId) => tools!.find((tool) => tool.name === name)!.handler(args, { sessionId: id });
    const requests = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    try {
        const task = { server: 'jobs', tool: 'ask', arguments: { text: 'exact payload' } };
        assert.match((await run('start_task', task, randomUUID())).textResultForLlm, /joined Copilot session/);
        assert.match((await run('start_task', task)).textResultForLlm, /chose not to start/);
        assert.ok(!requests().some((request) => request.method === 'tools/call'));
        allow = true;
        const accepted = await run('start_task', task);
        const id = accepted.textResultForLlm.match(/t-[a-f0-9]{6}/)?.[0];
        assert.ok(id, accepted.textResultForLlm);
        const call = requests().find((request) => request.method === 'tools/call');
        assert.deepEqual(call?.params.arguments, task.arguments);
        assert.match(questions.join('\n'), /exact payload/);
        const until = Date.now() + 8000;
        while (!wakes.length && Date.now() < until) await delay(100);
        assert.equal(wakes[0]?.source, 'automation-mcp-tasks');
        assert.match(wakes[0]?.prompt ?? '', /needs input/);
        assert.doesNotMatch(wakes[0]?.prompt ?? '', /exact payload/);
        const submitted = await run('provide_task_input', { task: id });
        assert.match(submitted.textResultForLlm, /Sent 1 answer/);
        const update = requests().find((request) => request.method === 'tasks/update');
        assert.deepEqual(update?.params.inputResponses.k1, { action: 'accept', content: { name: 'Luca' } });
    } finally {
        await runtime.stop();
        rmSync(home, { force: true, recursive: true });
    }
});
