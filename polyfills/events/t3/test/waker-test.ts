// Waking a thread: what `t3 thread send` is given, and what each of T3 Code's answers means.

import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { findT3, sendMessage, THREAD_ID } from '../src/waker.ts';
import { cleanup, FAKE_T3, temp } from './harness.ts';

after(cleanup);

const setup = (mode = 'ok') => {
    const dir = temp();
    const log = join(dir, 'sent.jsonl');
    const modeFile = join(dir, 'mode');
    writeFileSync(modeFile, mode);
    chmodSync(FAKE_T3, 0o755);
    const env = { PATH: process.env.PATH, FAKE_T3_LOG: log, FAKE_T3_MODE: modeFile, MCP_EVENTS_SECRET_SETTING: 'x', T3CODE_THREAD_ID: 'mcp:other' };
    const sent = () =>
        readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { args: string[]; stdin: string; leaked: string[] });
    return { dir, env, sent, t3: { command: FAKE_T3, args: [] } };
};

test('the message goes on standard input, never on the command line, and the thread id is the last argument before "-"', async () => {
    const w = setup();
    const text = '[mcp-events] hello\n--wait\n$(rm -rf /)';
    const r = await sendMessage(w.t3, 'mcp:0d3c2d8e-3f43-4a35-8b23-6b8f5f3b5c11', text, w.env);
    assert.deepEqual(r, { ok: true });
    const [s] = w.sent();
    assert.deepEqual(s!.args, ['thread', 'send', '--json', 'mcp:0d3c2d8e-3f43-4a35-8b23-6b8f5f3b5c11', '-']);
    assert.equal(s!.stdin, text);
});

test("this polyfill's settings don't reach t3 (MCP_EVENTS_* stays out; the caller removes T3CODE_THREAD_ID)", async () => {
    const w = setup();
    await sendMessage(w.t3, 'a1b2', 'x', w.env);
    assert.deepEqual(w.sent()[0]!.leaked, ['T3CODE_THREAD_ID']);
});

test('a thread id that could be read as a flag, or holds anything T3 Code does not make, is never passed', async () => {
    const w = setup();
    for (const bad of ['--wait', '-', '', 'a b', 'x\ny', 'a;b', 'é', 'x'.repeat(200)]) {
        assert.equal(THREAD_ID.test(bad), false, bad);
        const r = await sendMessage(w.t3, bad, 'x', w.env);
        assert.equal(r.ok, false);
    }
    for (const good of ['mcp:fecbc73d-0b10-4be7-8872-cbf6a55abf41', 'fecbc73d-0b10-4be7-8872-cbf6a55abf41', 'thread_1']) assert.equal(THREAD_ID.test(good), true, good);
});

test('T3 Code not running is tried again later; an unknown thread is not tried again; a hang may have delivered', async () => {
    const down = setup('down');
    const a = await sendMessage(down.t3, 'abc', 'x', down.env);
    assert.equal(a.ok, false);
    assert.ok(!a.ok && !a.unreachable && !a.maybe && /not running/.test(a.why));

    const gone = setup('gone');
    const b = await sendMessage(gone.t3, 'abc', 'x', gone.env);
    assert.ok(!b.ok && b.unreachable === true);

    const fail = setup('fail');
    const c = await sendMessage(fail.t3, 'abc', 'x', fail.env);
    assert.ok(!c.ok && !c.unreachable && !c.maybe);
    // T3 Code's own words are not repeated.
    assert.ok(!c.ok && !/Something else/.test(c.why));

    const hang = setup('hang');
    const d = await sendMessage(hang.t3, 'abc', 'x', hang.env, 1500);
    assert.ok(!d.ok && d.maybe === true);
});

test('findT3: MCP_EVENTS_T3_BIN must be a full path to a program or to the package\'s bin.mjs; never a .cmd or .bat', () => {
    const dir = temp();
    const prog = join(dir, 't3');
    writeFileSync(prog, '#!/bin/sh\n');
    chmodSync(prog, 0o755);
    const mjs = join(dir, 'bin.mjs');
    writeFileSync(mjs, '');
    const cmd = join(dir, 't3.cmd');
    writeFileSync(cmd, '');
    assert.deepEqual(findT3({ MCP_EVENTS_T3_BIN: prog }, 'linux'), { command: prog, args: [] });
    assert.deepEqual(findT3({ MCP_EVENTS_T3_BIN: mjs }, 'linux'), { command: process.execPath, args: [mjs] });
    assert.equal(findT3({ MCP_EVENTS_T3_BIN: cmd }, 'win32'), undefined);
    assert.equal(findT3({ MCP_EVENTS_T3_BIN: 't3' }, 'linux'), undefined);
    const onPath = join(dir, 'path');
    mkdirSync(onPath);
    writeFileSync(join(onPath, 't3'), '#!/bin/sh\n');
    chmodSync(join(onPath, 't3'), 0o755);
    assert.deepEqual(findT3({ PATH: onPath, HOME: dir }, 'linux'), { command: join(onPath, 't3'), args: [] });
    // On Windows only t3.exe is looked for on PATH: never a .cmd shim.
    writeFileSync(join(onPath, 't3.cmd'), '');
    assert.equal(findT3({ PATH: onPath }, 'win32'), undefined);
});

test('a .cmd or .bat is refused even when handed over directly', async () => {
    const r = await sendMessage({ command: 'C:\\t3\\t3.cmd', args: [] }, 'abc', 'x', {});
    assert.ok(!r.ok && r.unreachable === true);
});
