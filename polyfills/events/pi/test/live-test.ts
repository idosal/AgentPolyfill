// The live-run scripts (live/run.ts in the Pi forms) use a throwaway agent folder,
// never the person's own: live/agent-dir.ts, shared by the three forms.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { temp } from './pi-rpc.ts';

const LIVE = fileURLToPath(new URL('../live/', import.meta.url));
const MARK = '.agentpolyfill-live-run.json';

test('--new-agent-dir makes an empty folder marked for live runs, and a run of any form refuses an unmarked one', () => {
    const dir = join(temp('live-'), 'agent');
    const made = spawnSync(process.execPath, ['--no-warnings', join(LIVE, 'run.ts'), '--new-agent-dir', dir], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    assert.ok(existsSync(join(dir, MARK)));
    assert.match(made.stdout, /PI_CODING_AGENT_DIR=.* pi\n {2}\/login/);
    const unmarked = temp('live-');
    for (const script of [join(LIVE, 'run.ts'), fileURLToPath(new URL('../../../skills/pi/live/run.ts', import.meta.url)), fileURLToPath(new URL('../../../server-cards/pi/live/run.ts', import.meta.url))]) {
        const r = spawnSync(process.execPath, ['--no-warnings', script, 'a prompt'], { encoding: 'utf8', env: { ...process.env, PI_LIVE_AGENT_DIR: unmarked, PI_LIVE_PROVIDER: 'x', PI_LIVE_MODEL: 'y' } });
        assert.notEqual(r.status, 0, script);
        assert.match(r.stderr, /isn't marked as a folder for live runs/, script);
    }
    assert.ok(!existsSync(join(unmarked, 'mcp.json')), 'nothing was written to the unmarked folder');
});

test("Pi's own agent folder is refused even when marked; an mcp.json a run didn't leave is never overwritten; what is printed leaves out credentials", async () => {
    const home = temp('live-home-');
    const own = join(home, '.pi', 'agent');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, MARK), '{}');
    const before = process.env.HOME;
    process.env.HOME = home;
    try {
        const { liveAgentDir, mcpServersAfter, writeMcpJson } = await import('../live/agent-dir.ts');
        assert.throws(() => liveAgentDir(own), /Pi's own agent folder/);
        const dir = temp('live-');
        writeFileSync(join(dir, MARK), JSON.stringify({ purpose: 'test' }));
        assert.equal(liveAgentDir(dir).length > 0, true);
        // A folder that already has an mcp.json of its own: left as it is.
        writeFileSync(join(dir, 'mcp.json'), '{"mcpServers":{"mine":{"url":"https://mine.example/mcp","headers":{"Authorization":"Bearer secret"}}}}');
        assert.throws(() => writeMcpJson(dir, { mcpServers: {} }), /wasn't left by a live run/);
        assert.match(readFileSync(join(dir, 'mcp.json'), 'utf8'), /mine/);
        // One the run wrote, then changed during the run (an added server), is the run's to print and write again.
        const fresh = temp('live-');
        writeFileSync(join(fresh, MARK), JSON.stringify({ purpose: 'test' }));
        writeMcpJson(fresh, { mcpServers: {} });
        writeFileSync(join(fresh, 'mcp.json'), JSON.stringify({ mcpServers: { docs: { url: 'https://user:pw@docs.example/mcp?token=abc', headers: { Authorization: 'Bearer secret' } }, local: { command: 'node', env: { KEY: 'secret' } } } }));
        const printed = mcpServersAfter(fresh);
        assert.equal(printed, 'docs: https://docs.example/mcp\nlocal: a local command');
        writeMcpJson(fresh, { mcpServers: {} });
    } finally {
        process.env.HOME = before;
    }
});

test('the three forms share one live/agent-dir.ts', () => {
    const events = readFileSync(join(LIVE, 'agent-dir.ts'), 'utf8');
    for (const form of ['skills', 'server-cards']) assert.equal(readFileSync(fileURLToPath(new URL(`../../../${form}/pi/live/agent-dir.ts`, import.meta.url)), 'utf8'), events, form);
});
