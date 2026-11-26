import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claimSessionOwner } from '../../core/src/owner.ts';

const ownerModule = new URL('../../core/src/owner.ts', import.meta.url).href;

function worker(dir: string, source: string) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, dir, ownerModule], {
        cwd: dir, env: {}, stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let errors = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { errors += chunk; });
    const exit = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
            if (code === 0 || signal === 'SIGKILL') resolve();
            else reject(new Error(`Owner worker exited with ${code}: ${errors}`));
        });
    });
    return { child, exit, result: () => output.trim(), async started() {
        if (!output) await Promise.race([
            new Promise((resolve) => child.stdout.once('data', resolve)),
            exit
        ]);
        return output.trim();
    } };
}

const acquire = `
    const { claimSessionOwner } = await import(process.argv[2]);
    const release = claimSessionOwner(process.argv[1]);
    console.log(release ? 'owner' : 'waiting');
    if (release) setInterval(() => {}, 1000);
`;

test('a crashed owner and simultaneous contenders leave exactly one live session owner', { timeout: 15_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tasks-owner-'));
    const workers: ReturnType<typeof worker>[] = [];
    try {
        const crashed = worker(dir, acquire);
        workers.push(crashed);
        assert.equal(await crashed.started(), 'owner');
        assert.equal(claimSessionOwner(dir), undefined);
        crashed.child.kill('SIGKILL');
        await crashed.exit;
        const contenders = Array.from({ length: 5 }, () => worker(dir, acquire));
        workers.push(...contenders);
        const results = await Promise.all(contenders.map((contender) => contender.started()));
        assert.deepEqual(results.sort(), ['owner', 'waiting', 'waiting', 'waiting', 'waiting']);
        assert.equal(readdirSync(join(dir, 'owner.v2')).length, 1);
    } finally {
        for (const contender of workers) contender.child.kill('SIGKILL');
        await Promise.allSettled(workers.map((contender) => contender.exit));
        rmSync(dir, { recursive: true, force: true });
    }
});

test('takeover recovers an empty lock directory without touching task state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tasks-owner-'));
    try {
        mkdirSync(join(dir, 'owner.v2'));
        writeFileSync(join(dir, 'tasks.json'), '{"tasks":[]}');
        const release = claimSessionOwner(dir);
        assert.ok(release);
        assert.equal(readFileSync(join(dir, 'tasks.json'), 'utf8'), '{"tasks":[]}');
        assert.equal(claimSessionOwner(dir), undefined);
        release();
        const successor = claimSessionOwner(dir);
        assert.ok(successor);
        release();
        assert.equal(claimSessionOwner(dir), undefined);
        successor();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('migration observes a live legacy PID and leaves an unidentified legacy reclaim in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tasks-owner-'));
    try {
        const owner = join(dir, 'owner.pid');
        mkdirSync(owner + '.reclaim');
        writeFileSync(owner, String(process.pid));
        assert.equal(claimSessionOwner(dir), undefined);
        assert.equal(readFileSync(owner, 'utf8'), String(process.pid));
        rmSync(owner + '.reclaim', { recursive: true });
        assert.equal(claimSessionOwner(dir), undefined);
        assert.equal(readFileSync(owner, 'utf8'), String(process.pid));
        rmSync(owner);
        const release = claimSessionOwner(dir);
        assert.ok(release);
        assert.throws(() => writeFileSync(owner, String(process.pid), { flag: 'wx' }), { code: 'EEXIST' });
        release();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
