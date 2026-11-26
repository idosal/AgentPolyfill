import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { openRenderer } from '../renderer.mjs';

test('renders the original structured result without replay and enforces nested consent', async t => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-apps-test-'));
    t.after(() => rm(cwd, {recursive:true, force:true}));
    const log = join(cwd, 'methods');
    let text = '', approved = false, nested = 0;
    const viewer = await openRenderer({
        server:'fixture', tool:'example', input:{}, result:{content:[],structuredContent:{label:'ORIGINAL'}},
        config:{command:process.execPath,args:[fileURLToPath(new URL('app-server.mjs', import.meta.url)), log]},
        cols:80, rows:24, cwd,
        onFrame(frame) { text = frame.flat().map(cell => cell[0]).join(''); },
        allowTool(name, args) { assert.equal(name, 'example'); assert.deepEqual(args, {}); return approved; },
        onTool() { nested++; return {content:[],structuredContent:{label:'UPDATED'}}; }
    });
    t.after(async () => { viewer.close(); await viewer.closed; });
    async function see(label) {
        for (let i=0; i<100 && !text.includes(label); i++) await sleep(75);
        assert.ok(text.includes(label), text);
    }
    await see('ORIGINAL');
    const key = key => viewer.input({kind:'key', key});
    await key('tab');
    await key('return');
    await see('DECLINED');
    assert.equal(nested, 0);
    approved = true;
    await key('return');
    await see('UPDATED');
    assert.equal(nested, 1);
    assert.ok(!(await readFile(log, 'utf8')).includes('tools/call'));
});

test('an image-capable viewer receives a PNG', async t => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-apps-image-'));
    t.after(() => rm(cwd, {recursive:true, force:true}));
    const frame = Promise.withResolvers();
    const viewer = await openRenderer({
        server:'fixture', tool:'example', input:{}, result:{content:[],structuredContent:{label:'IMAGE'}},
        config:{command:process.execPath,args:[fileURLToPath(new URL('app-server.mjs', import.meta.url)), join(cwd, 'methods')]},
        cols:50, rows:12, cwd, onFrame() {}, onImage:frame.resolve
    });
    try {
        const bytes = Buffer.from(await Promise.race([frame.promise, sleep(6000, null, {ref:false})]), 'base64');
        assert.equal(bytes.subarray(0,8).toString('hex'), '89504e470d0a1a0a');
    } finally {
        viewer.close();
        await viewer.closed;
    }
});
