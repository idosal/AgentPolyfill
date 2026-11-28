import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const cli = process.env.GROK_TEST_CLI || fileURLToPath(new URL('../dist/watch.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('../../claude-code/test/fixture-events-server.ts', import.meta.url));
const target = 'https://api2.cursor.sh/automations/webhook/00000000-0000-0000-0000-000000000001';

test('init creates private templates and preserves a configured profile', (t) => {
    const base = mkdtempSync(join(tmpdir(), 'grok-init-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const dir = join(base, 'profile');
    const init = () => spawnSync(process.execPath, [cli, 'init'], { env: { ...process.env, GROK_EVENTS_HOME: dir }, encoding: 'utf8' });
    const absent = spawnSync(process.execPath, [cli, 'status'], {env:{...process.env, GROK_EVENTS_HOME:dir}, encoding:'utf8'});
    assert.equal(JSON.parse(absent.stdout).initialized, false);
    assert.equal(existsSync(dir), false);
    const result = init();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const name of ['config.json', 'routine.json']) {
        const file = join(dir, name);
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.ok(JSON.parse(readFileSync(file, 'utf8')));
        writeFileSync(file, 'existing settings');
    }
    assert.equal(init().status, 0);
    for (const name of ['config.json', 'routine.json']) assert.equal(readFileSync(join(dir, name), 'utf8'), 'existing settings');
});

test('all operator commands check profile ownership and file permissions before opening any publisher', (t) => {
    const base = mkdtempSync(join(tmpdir(), 'grok-files-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const run = (command) => spawnSync(process.execPath, [cli, command], { env: { ...process.env, GROK_EVENTS_HOME: base }, encoding: 'utf8' });
    assert.equal(run('init').status, 0);
    chmodSync(base, 0o755);
    assert.match(run('list').stderr, /private profile/);
    chmodSync(base, 0o700);
    const credential = join(base, 'routine.json');
    chmodSync(credential, 0o644);
    assert.match(run('init').stderr, /owner-only/);
    chmodSync(credential, 0o600);
    const config = join(base,'config.json');
    chmodSync(config, 0o666);
    assert.match(run('list').stderr, /group or other writes/);
    chmodSync(config, 0o600);
    writeFileSync(config, JSON.stringify({servers:{desk:{upstream:{url:'http://source.example/mcp'}}}}));
    assert.match(run('list').stderr, /Use HTTPS/);
    unlinkSync(credential);
    symlinkSync(config, credential);
    assert.equal(run('init').status, 1);
});

async function waitFor(predicate, message) {
    for (let i = 0; i < 300; i++) {
        if (predicate()) return;
        await sleep(40);
    }
    throw Error(message);
}

test(
    'packaged once and follow share setup; two subsequent tickets produce separate webhook bodies without a reader',
    { timeout: 45000 },
    async (t) => {
        const home = mkdtempSync(join(tmpdir(), 'grok-cli-'));
        const feed = join(home, 'feed'),
            rpc = join(home, 'publisher-log');
        const config = {
            servers: {
                desk: {
                    upstream: {
                        command: process.execPath,
                        args: [fixture],
                        env: {
                            FIXTURE_UPSTREAM: feed,
                            FIXTURE_LOG: rpc,
                            FIXTURE_POLL_MS: '50',
                            FIXTURE_HEARTBEAT_MS: '100'
                        }
                    }
                }
            },
            watches: [{ server: 'desk', name: 'triage', event: 'ticket.created' }],
            minGapSeconds: 1,
            batchMs: 80
        };
        writeFileSync(join(home, 'config.json'), JSON.stringify(config));
        const credential = join(home, 'routine.json');
        writeFileSync(credential, JSON.stringify({ url: target, key: 'fixture-routine-key' }), { mode: 0o600 });
        writeFileSync(feed, '');
        const posts = [];
        let withholdAck = false;
        const receiver = createServer(async (req, res) => {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            posts.push({ body: JSON.parse(Buffer.concat(chunks)), auth: req.headers.authorization });
            if (!withholdAck) res.writeHead(200).end();
        });
        receiver.listen(0, '127.0.0.1');
        await once(receiver, 'listening');
        const mock = join(home, 'fixture-fetch.mjs');
        // Exercise the real HTTP body and headers on loopback. The test process can call only this fixture.
        writeFileSync(
            mock,
            `const send = globalThis.fetch;
        globalThis.fetch = (url, options) => {
            if (String(url) !== ${JSON.stringify(target)}) throw Error('Unexpected outgoing address');
            return send('http://127.0.0.1:${receiver.address().port}/routine', options);
        };`
        );
        const runs = [];
        function command(...args) {
            const proc = spawn(process.execPath, ['--import', mock, cli, ...args], {
                cwd: home,
                env: {
                    HOME: home,
                    GROK_EVENTS_HOME: home,
                    PATH: process.env.PATH,
                    MCP_EVENTS_MIN_POLL_MS: '50'
                },
                stdio: ['ignore', 'pipe', 'pipe']
            });
            const run = { proc, out: '', err: '', done: once(proc, 'close').then(([code]) => code) };
            proc.stderr.on('data', (chunk) => {
                run.err += chunk;
            });
            proc.stdout.on('data', (chunk) => {
                run.out += chunk;
            });
            runs.push(run);
            return run;
        }
        t.after(async () => {
            for (const run of runs) if (run.proc.exitCode === null && run.proc.signalCode === null) run.proc.kill();
            await Promise.all(runs.map((r) => r.done));
            receiver.closeAllConnections();
            await new Promise((resolve) => receiver.close(resolve));
            rmSync(home, { recursive: true, force: true });
        });
        const emit = (id, timestamp = new Date().toISOString()) =>
            appendFileSync(
                feed,
                JSON.stringify({
                    name: 'ticket.created',
                    eventId: 'notice-' + id,
                    timestamp,
                    data: { id, title: 'Private title', internal: 'External detail' }
                }) + '\n'
            );
        chmodSync(credential, 0o644);
        assert.equal(await command('once').done, 1);
        chmodSync(credential, 0o600);
        const first = command('once');
        await waitFor(() => first.err.includes('Watching desk/ticket.created'), 'First subscription did not start: ' + first.err);
        emit('STALE', '2020-01-01T00:00:00.000Z');
        emit('T-101');
        assert.equal(await first.done, 0, first.err);
        assert.deepEqual(
            posts.map((p) => p.body.events[0].ticketId),
            ['T-101']
        );
        assert.equal(await command('once').done, 1);
        const before = readFileSync(rpc, 'utf8').length;
        const following = command('follow');
        await waitFor(
            () => existsSync(rpc) && readFileSync(rpc, 'utf8').slice(before).includes('events/stream'),
            'Recurring watch did not resume'
        );
        const competing = command('follow');
        assert.equal(await competing.done, 1);
        assert.match(competing.err, /already running/);
        emit('T-102');
        await waitFor(() => posts.length === 2, 'First recurring wake was missing');
        emit('T-103');
        await waitFor(() => posts.length === 3, 'Second recurring wake was missing');
        following.proc.kill();
        assert.equal(await following.done, 0, following.err);
        assert.deepEqual(
            posts.map((p) => p.body.events[0].ticketId),
            ['T-101', 'T-102', 'T-103']
        );
        assert.equal(new Set(posts.map((p) => p.body.batch)).size, 3);
        for (const { body, auth } of posts) {
            assert.equal(auth, 'Bearer fixture-routine-key');
            assert.equal(body.events[0].watch, 'triage');
            assert.equal(body.events[0].title, undefined);
            assert.ok(!JSON.stringify(body).includes('External detail'));
        }
        for (const [index, post] of posts.entries()) {
            t.diagnostic(JSON.stringify({ mode: index === 0 ? 'once' : 'follow', receiver: 'local HTTP fixture', body: post.body }));
        }
        const read = command('read', posts[1].body.batch);
        assert.equal(await read.done, 0, read.err);
        assert.equal(JSON.parse(read.out).untrustedEvents[0].data.id, 'T-102');
        assert.equal(await command('read', posts[1].body.batch.replace(/\.e2-e2$/, '.e1-e3')).done, 1);

        // The receiver records the wake. Kill the actual sender before the response passes back.
        const status = async () => {
            const run = command('status');
            assert.equal(await run.done, 0, run.err);
            assert.doesNotMatch(run.out, /Private title|fixture-routine-key|External detail/);
            return JSON.parse(run.out);
        };
        const prior = await status();
        assert.equal(prior.lastAccepted.batch, posts[2].body.batch);
        const trace = [];
        withholdAck = true;
        const crash = command('follow');
        await waitFor(() => crash.proc.pid > 0, 'watcher did not start');
        emit('T-104');
        await waitFor(() => posts.length === 4, 'receiver never accepted the fourth ticket');
        trace.push('Append', 'Reserve', 'Post');
        crash.proc.kill('SIGKILL');
        await crash.done;
        const batch = posts[3].body.batch;
        const down = await status();
        trace.push('Crash');
        assert.equal(down.owner.processAlive, false);
        assert.equal(down.heldBatch, batch);
        assert.equal(down.lastAccepted.batch, prior.lastAccepted.batch);
        const resumed = command('follow');
        await waitFor(() => resumed.err.includes('Held batch ' + batch), 'restarted sender did not hold the delivery');
        const active = await status();
        trace.push('Restart');
        assert.equal(active.owner.pid, resumed.proc.pid);
        assert.equal(active.heldEvents, 1);
        emit('T-105');
        let observed;
        for (let i = 0; i < 30; i++) {
            observed = await status();
            if (observed.pending === 1) break;
            await sleep(80);
        }
        trace.push('Append');
        assert.equal(observed.pending, 1);
        assert.equal(posts.length, 4);
        assert.equal(await command('read', batch).done, 1);
        resumed.proc.kill();
        await resumed.done;
        withholdAck = false;
        const recovery = command('follow', '--accepted', batch);
        await waitFor(() => posts.length === 5 && recovery.err.includes('Accepted batch'), 'next ticket did not get a new wake');
        assert.equal(posts[4].body.events[0].ticketId, 'T-105');
        recovery.proc.kill();
        await recovery.done;
        assert.equal((await status()).heldBatch, null);
        assert.equal((await status()).lastAccepted.batch, posts[4].body.batch);
        assert.equal(await command('read', batch).done, 0);
        trace.push('Accept', 'Reserve', 'Post', 'Accept', 'Read');
        assert.deepEqual(trace, JSON.parse(readFileSync(new URL('../../../../tools/muse-grok/model/lost-ack.json', import.meta.url))));
        t.diagnostic('Receiver accepted T-104; SIGKILL before local ACK; restart held T-104 with one T-105 pending; operator confirmation released T-105. Five distinct wakes.');
    }
);
