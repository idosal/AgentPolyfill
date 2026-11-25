// The reader: through the app-server daemon with the session's thread when the daemon
// has it, else through a stdio app server without a thread. Against a stand-in for
// Codex's app server (fake-app-server.ts) that reads from the fixture server.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { contentsOf } from '../../core/src/links.ts';
import { AppServerReader } from '../src/appserver.ts';

const FAKE = fileURLToPath(new URL('./fake-app-server.ts', import.meta.url));
const started: ChildProcess[] = [];
const readers: AppServerReader[] = [];
after(() => {
    for (const r of readers) r.close();
    for (const p of started) p.kill();
});

function setup(loaded: string[] = [], extra: Record<string, string> = {}) {
    const home = mkdtempSync(join(tmpdir(), 'rl-codex-home-'));
    const log = join(home, 'requests.jsonl');
    const env = { ...process.env, FAKE_LOADED: loaded.join(','), FAKE_LOG: log, ...extra };
    const reader = new AppServerReader(home, env, () => {}, { command: [process.execPath, FAKE] });
    readers.push(reader);
    const requests = () =>
        readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { via: string; method: string; params: Record<string, unknown>; answer?: Record<string, unknown> })
            .filter((q) => !q.answer);
    const answers = () =>
        readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { answer?: Record<string, unknown> })
            .flatMap((q) => (q.answer ? [q.answer] : []));
    return { home, env, reader, requests, answers };
}

/** Starts the stand-in as Codex's daemon, at the socket path Codex uses (a link to a short path). */
async function daemon(home: string, env: NodeJS.ProcessEnv) {
    const short = join('/tmp', `rl-${process.pid}-${started.length}.sock`);
    const p = spawn(process.execPath, [FAKE, '--listen', short], { stdio: ['ignore', 'pipe', 'ignore'], env });
    started.push(p);
    await new Promise<void>((done) => p.stdout!.once('data', () => done()));
    mkdirSync(join(home, 'app-server-control'), { recursive: true });
    symlinkSync(short, join(home, 'app-server-control', 'app-server-control.sock'));
}

test('with no daemon, a read goes through a stdio app server, without a thread id', async () => {
    const { reader, requests } = setup();
    const r = await reader.read('docs', 'fixture://docs/report.txt', 'thread-1');
    assert.ok('contents' in r, JSON.stringify(r));
    assert.match(contentsOf(r.contents)?.[0]?.text ?? '', /MARKER-TEXT-DOCS-OCTARINE/);
    const reads = requests().filter((q) => q.method === 'mcpServer/resource/read');
    assert.deepEqual(reads, [{ via: 'stdio', method: 'mcpServer/resource/read', params: { server: 'docs', uri: 'fixture://docs/report.txt' } }]);
    // The reader sends Codex only these requests: nothing else is asked of it.
    assert.deepEqual([...new Set(requests().map((q) => q.method))].sort(), ['initialize', 'initialized', 'mcpServer/resource/read']);
});

test("a question from Codex's app server (an approval) is answered with an error: the plugin decides nothing", async () => {
    const { reader, answers } = setup([], { FAKE_ASK: '1' });
    const r = await reader.read('docs', 'fixture://docs/report.txt', undefined);
    assert.ok('contents' in r, JSON.stringify(r));
    const [a, ...more] = answers();
    assert.equal(more.length, 0);
    assert.equal(a?.id, 'ask-1');
    assert.equal(a?.result, undefined);
    assert.equal((a?.error as { code?: number })?.code, -32601);
});

test('an image comes back as the base64 blob Codex returns', async () => {
    const { reader } = setup();
    const r = await reader.read('docs', 'fixture://docs/chart.png', undefined);
    assert.ok('contents' in r);
    assert.equal(contentsOf(r.contents)?.[0]?.mimeType, 'image/png');
    assert.match(contentsOf(r.contents)?.[0]?.blob ?? '', /^iVBORw0KGgo/);
});

test("a read Codex can't do comes back as an error in one line", async () => {
    const { reader } = setup();
    const r = await reader.read('docs', 'fixture://docs/gone.txt', undefined);
    assert.ok('error' in r);
    assert.match(r.error, /Resource not found/);
});

test("when the daemon has the session, the read goes there with the session's thread id", { skip: process.platform === 'win32' }, async () => {
    const { home, env, reader, requests } = setup(['thread-live']);
    await daemon(home, env);
    const r = await reader.read('docs', 'fixture://docs/report.txt', 'thread-live');
    assert.ok('contents' in r, JSON.stringify(r));
    assert.match(r.via, /session's own connection/);
    const reads = requests().filter((q) => q.method === 'mcpServer/resource/read');
    assert.deepEqual(reads, [{ via: 'daemon', method: 'mcpServer/resource/read', params: { threadId: 'thread-live', server: 'docs', uri: 'fixture://docs/report.txt' } }]);
});

test("when the daemon doesn't have the session (codex exec), the read falls back to a stdio app server", { skip: process.platform === 'win32' }, async () => {
    const { home, env, reader, requests } = setup([]);
    await daemon(home, env);
    const r = await reader.read('docs', 'fixture://docs/report.txt', 'thread-exec');
    assert.ok('contents' in r, JSON.stringify(r));
    assert.match(r.via, /new connection/);
    const reads = requests().filter((q) => q.method === 'mcpServer/resource/read');
    assert.deepEqual(
        reads.map((q) => [q.via, q.params.threadId]),
        [
            ['daemon', 'thread-exec'],
            ['stdio', undefined],
        ],
    );
});

test('with no codex to start, the read fails with a message, not a crash', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rl-nocodex-'));
    const reader = new AppServerReader(home, { PATH: '' }, () => {}, { command: [join(home, 'no-such-codex')] });
    readers.push(reader);
    const r = await reader.read('docs', 'u', undefined);
    assert.ok('error' in r);
    assert.match(r.error, /could not start codex app-server/);
});
