import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { World, textOf, waitFor } from '../../../../tools/opencode/harness.ts';

const plugin = fileURLToPath(new URL('../plugin', import.meta.url));
const fixture = fileURLToPath(new URL('../../codex/test/fixture-tasks-server.mjs', import.meta.url));

test('OpenCode routes the full question and one scoped answer to its task session', { timeout: 90_000 }, async () => {
    const temp = mkdtempSync(join(tmpdir(), 'opencode-tasks-test-'));
    const log = join(temp, 'upstream.jsonl');
    writeFileSync(log, '');
    const world = new World({ plugins: [plugin], mcp: { jobs: {
        type: 'local', command: [process.execPath, fixture],
        environment: { FIXTURE_LOG: log, FIXTURE_TASK_MS: '1500' }
    } } });
    const abort = new AbortController();
    const prompts: { sessionID: string; ticket: string }[] = [];
    async function events() {
        const response = await fetch(world.url + '/api/event', {
            headers: { authorization: `Basic ${Buffer.from(`opencode:${world.password}`).toString('base64')}` },
            signal: abort.signal
        });
        assert.ok(response.ok && response.body);
        const stream = response.body.pipeThrough(new TextDecoderStream()).getReader();
        const pump = async () => {
            let buffered = '';
            try {
                for (;;) {
                    const next = await stream.read();
                    if (next.done) return;
                    buffered += next.value;
                    let newline: number;
                    while ((newline = buffered.indexOf('\n\n')) >= 0) {
                        const block = buffered.slice(0, newline);
                        buffered = buffered.slice(newline + 2);
                        const json = block.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
                        if (!json) continue;
                        const event = JSON.parse(json);
                        if (event.type === 'rpc.mcp-tasks-dialog.question') prompts.push(event.data);
                    }
                }
            } catch (error) {
                if (!abort.signal.aborted) throw error;
            } finally { stream.releaseLock(); }
        };
        return { pump };
    }
    let listening: Promise<void> | undefined;
    try {
        await world.start();
        const sessionID = await world.createSession();
        const other = await world.createSession();
        listening = (await events()).pump();
        const dialog = (method: string, input: Record<string, unknown>) => world.api<{ output: Record<string, unknown> }>(
            'POST', `/api/rpc/mcp-tasks-dialog/${method}?location[directory]=${encodeURIComponent(world.project)}`, { input });
        const next = async () => {
            const event = await waitFor(() => prompts.shift(), 15_000, 'the OpenCode dialog request');
            assert.equal(event.sessionID, sessionID);
            assert.deepEqual(Object.keys(event).sort(), ['sessionID', 'ticket']);
            assert.deepEqual((await dialog('question', { sessionID: other, ticket: event.ticket })).output, {});
            const { output: question } = await dialog('question', event);
            assert.ok(question.proof);
            return { event, question, reply: (action: string, value?: string) =>
                dialog('reply', { ...event, proof: question.proof, action, ...(value ? { value } : {}) }) };
        };
        const request = 'CALL mcp_tasks_start_task {"server":"jobs","tool":"ask","arguments":{"text":"exact payload"}}';
        await world.prompt(sessionID, request);
        let shown = await next();
        assert.match(String(shown.question.message), /jobs[\s\S]*Tool: ask[\s\S]*"text": "exact payload"/);
        await shown.reply('decline');
        await world.idle(sessionID);
        assert.doesNotMatch(readFileSync(log, 'utf8'), /"method":"tools\/call"/);
        let since = (await world.session(sessionID)).time.idle;
        await world.prompt(sessionID, request);
        shown = await next();
        await shown.reply('accept');
        await world.idle(sessionID, since);
        const notice = await waitFor(async () => (await world.messages(sessionID))
            .find((message) => message.type === 'synthetic' && /\[mcp-tasks\].*needs input/.test(textOf(message))), 15_000, 'the input wake');
        assert.doesNotMatch(textOf(notice), /exact payload/);
        const task = textOf(notice).match(/t-[0-9a-f]{6}/)?.[0];
        assert.ok(task);
        await world.idle(sessionID);
        since = (await world.session(sessionID)).time.idle;
        await world.prompt(sessionID, `CALL mcp_tasks_provide_task_input {"task":"${task}"}`);
        shown = await next();
        assert.match(String(shown.question.message), /What is your name\?/);
        await shown.reply('accept', '{"name":"Luca"}');
        await world.idle(sessionID, since);
        const requests = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        assert.deepEqual(requests.filter((request) => request.method === 'tools/call').map((request) => request.params.arguments), [{ text: 'exact payload' }]);
        assert.deepEqual(requests.find((request) => request.method === 'tasks/update')?.params.inputResponses.k1, { action: 'accept', content: { name: 'Luca' } });
    } finally {
        abort.abort();
        await listening;
        await world.stop();
        rmSync(temp, { recursive: true, force: true });
    }
});
