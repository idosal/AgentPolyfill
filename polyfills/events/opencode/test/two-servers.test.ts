// The same OpenCode session open in two OpenCode servers (the background service and another, say):
// two processes over one state folder, of which one runs the session's watches and wakes it, and the
// other only lists them and takes over if the first goes. As in the Codex form (review EVH1): the one
// taking over reads the wake count again, and the one that doesn't run the watches never writes it.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const DRIVER = fileURLToPath(new URL('./session-driver.ts', import.meta.url));
const ID = 'ses_twoServersTest01';

function server(base: string) {
    const child = spawn(process.execPath, ['--no-warnings', DRIVER, base, ID], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, MCP_EVENTS_WAKE_GAP_S: '0' } });
    const lines = createInterface({ input: child.stdout! });
    const queue: ((v: { owner: boolean }) => void)[] = [];
    const got: { owner: boolean }[] = [];
    lines.on('line', (l) => {
        const v = JSON.parse(l) as { owner: boolean };
        const next = queue.shift();
        if (next) next(v);
        else got.push(v);
    });
    const read = () => new Promise<{ owner: boolean }>((r) => (got.length ? r(got.shift()!) : queue.push(r)));
    return {
        ready: read(),
        send: (cmd: string) => {
            child.stdin!.write(cmd + '\n');
            return read();
        },
        kill: () => new Promise<void>((r) => {
            if (child.exitCode !== null || child.signalCode !== null) return r();
            child.once('exit', () => r());
            child.kill('SIGKILL');
        })
    };
}

const wakesFile = (base: string) => join(base, 'sessions', ID, 'wakes.json');

test("the server that doesn't run the watches never writes the wake count", async () => {
    const base = mkdtempSync(join(tmpdir(), 'mcp-events-two-'));
    // Waking stopped at its hourly limit before either server started: both read that.
    mkdirSync(join(base, 'sessions', ID), { recursive: true });
    writeFileSync(wakesFile(base), JSON.stringify({ wakes: [Date.now()], paused: true, last: {} }));
    const first = server(base);
    assert.equal((await first.ready).owner, true);
    const second = server(base);
    try {
        assert.equal((await second.ready).owner, false);
        // The first, which runs the watches, then records a hand-over.
        writeFileSync(wakesFile(base), JSON.stringify({ wakes: [Date.now()], paused: true, last: {}, handed: { watches: ['w-abc123'], upto: 0 } }));
        // The person writes in the second server. Saving its older count would lose that record.
        await second.send('spoke');
        const saved = JSON.parse(readFileSync(wakesFile(base), 'utf8')) as { handed?: { upto: number }; paused?: boolean };
        assert.deepEqual(saved.handed, { watches: ['w-abc123'], upto: 0 });
        assert.equal(saved.paused, true);
    } finally {
        await first.kill();
        await second.kill();
        rmSync(base, { recursive: true, force: true });
    }
});

test('the server taking over reads the wake count again, and counts a hand-over the first one recorded', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mcp-events-two-'));
    const first = server(base);
    assert.equal((await first.ready).owner, true);
    const second = server(base);
    try {
    assert.equal((await second.ready).owner, false);
    // After the second read it, the first records a batch as handed over and dies before it hears back.
    mkdirSync(join(base, 'sessions', ID), { recursive: true });
    writeFileSync(wakesFile(base), JSON.stringify({ wakes: [], last: {}, handed: { watches: ['w-abc123'], upto: 0 } }));
    await first.kill();
    // The second takes over: it must count that hand-over (a wake), not hand the batch over again.
    assert.equal((await second.send('start')).owner, true);
    const saved = JSON.parse(readFileSync(wakesFile(base), 'utf8')) as { wakes: number[]; handed?: unknown };
    assert.equal(saved.wakes.length, 1);
    assert.equal(saved.handed, undefined);
    } finally {
        await first.kill().catch(() => {});
        await second.kill();
        rmSync(base, { recursive: true, force: true });
    }
});
