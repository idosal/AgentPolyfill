import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

test('desktop entry scopes questions to a focused visit and drops an answer after switching sessions', async () => {
    const events = new Map<string, (event: unknown) => Promise<void>>();
    const answers: Record<string, unknown>[] = [];
    const messages: string[] = [];
    const rpc = {
        events: { on(name: string, handler: (event: unknown) => Promise<void>) { events.set(name, handler); return () => events.delete(name); } },
        async pending() { return {}; },
        async question() { return { title: 'Start', message: 'server: jobs, tool: slow, args: {}', proof: 'one-use', input }; },
        async reply(answer: Record<string, unknown>) { answers.push(answer); }
    };
    let current = { id: 'a', visit: {}, directory: '/p', server: { client: { rpc: () => rpc } } };
    let input = false;
    let approve = false;
    let switchDuringInput = false;
    const module = { exports: {} as { default?: { setup(ctx: unknown): void } } };
    const shim = { Plugin: { define: (d: unknown) => d }, Rpc: { define: (d: unknown) => d },
        createKeyed: (read: () => unknown, listen: (d: unknown) => void) => listen(read()), onCleanup() {} };
    runInNewContext(readFileSync(new URL('../plugin/gui.cjs', import.meta.url), 'utf8'), {
        module, exports: module.exports, require: () => shim, document: { hasFocus: () => true }, window: { addEventListener() {}, removeEventListener() {} }, AbortSignal
    });
    module.exports.default!.setup({ sessions: { current: () => current },
        toast: { show: ({ description }: { description: string }) => messages.push(description) },
        dialogs: { confirm: async (q: {description: string}) => { assert.match(q.description, /args: \{\}/); return approve; },
            prompt: async () => { if (switchDuringInput) current = { ...current, visit: {} }; return '{"name":"Luca"}'; } } });
    const send = (name: string, sessionID: string, directory = '/p') =>
        events.get(name)!({ data: { sessionID, ticket: 'ticket', message: 'task finished' }, location: { directory } });
    await send('question','b');
    await send('question','a','/other');
    assert.equal(answers.length,0);
    await send('question','a');
    approve = true;
    await send('question','a');
    input = true;
    await send('question','a');
    await send('wake','a');
    switchDuringInput = true;
    await send('question','a');
    assert.deepEqual(answers.map(x => x.action), ['decline','accept','accept','cancel']);
    assert.equal(answers[2].value, '{"name":"Luca"}');
    assert.equal(answers[3].value, undefined);
    assert.deepEqual(messages, ['task finished']);
});
