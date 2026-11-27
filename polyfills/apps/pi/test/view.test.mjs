import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { openRenderer, originalMcpResult } from '../renderer.mjs';

test('renders the original structured result without replay and enforces nested consent', async t => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-apps-test-'));
    t.after(() => rm(cwd, {recursive:true, force:true}));
    const log = join(cwd, 'methods');
    let text = '', approved = false, nested = 0, button;
    const viewer = await openRenderer({
        server:'fixture', tool:'example', input:{}, result:{content:[],structuredContent:{label:'ORIGINAL'}},
        config:{command:process.execPath,args:[fileURLToPath(new URL('app-server.mjs', import.meta.url)), log]},
        cols:80, rows:24, cwd, confirmOpen: () => true,
        onFrame(frame) {
            const rows = frame.map(row => row.map(cell => cell[0]).join(''));
            text = rows.join(' ');
            const y = rows.findIndex(row => row.includes('Refresh'));
            if (y >= 0) button = {x: rows[y].indexOf('Refresh') + 2.5, y: y + 0.5};
        },
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
    assert.ok(button, 'Refresh button is visible');
    // A quick click can enqueue release before the press request has completed.
    await Promise.all(['down', 'up'].map(type => viewer.input({kind:'pointer', type, button:'left', fine:button})));
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
        cols:50, rows:12, cwd, confirmOpen: () => true, onFrame() {}, onImage:frame.resolve
    });
    try {
        const bytes = Buffer.from(await Promise.race([frame.promise, sleep(6000, null, {ref:false})]), 'base64');
        assert.equal(bytes.subarray(0,8).toString('hex'), '89504e470d0a1a0a');
    } finally {
        viewer.close();
        await viewer.closed;
    }
});

test('forwards the MCP result Pi wrapped, including its original structured content', () => {
    const original = { content: [{ type: 'text', text: 'raw' }], structuredContent: { time: '12:30' }, isError: false };
    assert.deepEqual(originalMcpResult({ content: [{ type: 'text', text: 'preview' }], structuredContent: { ...original, _meta: { private: true } } }), original);
    assert.deepEqual(originalMcpResult(original), original);
});


test('reviews the filtered policy before any frame and opens only the reviewed resource', async t => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-apps-review-'));
    t.after(() => rm(cwd, {recursive:true, force:true}));
    for (const accept of [false, true]) {
        const log = join(cwd, String(accept));
        let reviews = 0, frames = 0;
        const drawn = Promise.withResolvers();
        const viewer = await openRenderer({
            server:'fixture', tool:'example', input:{}, result:{content:[],structuredContent:{label:'REVIEWED'}},
            config:{command:process.execPath,args:[fileURLToPath(new URL('app-server.mjs', import.meta.url)), log, 'review']},
            cwd, cols:50, rows:12,
            async confirmOpen(csp) {
                assert.deepEqual(csp, {connectDomains:['https://review.example']});
                assert.equal(frames, 0);
                reviews++;
                return accept;
            },
            onFrame(frame) {
                frames++;
                if (frame.flat().map(cell => cell[0]).join('').includes('REVIEWED')) drawn.resolve(true);
            }
        });
        assert.equal(reviews, 1);
        if (accept) {
            try {
                assert.equal(await Promise.race([drawn.promise, sleep(5000, false, {ref:false})]), true);
            } finally { viewer.close(); await viewer.closed; }
        } else {
            assert.equal(viewer, undefined);
            assert.equal(frames, 0);
        }
        const methods = (await readFile(log, 'utf8')).split('\n');
        assert.equal(methods.filter(m => m === 'resources/read').length, 1);
        assert.ok(!methods.includes('tools/call'));
    }
});

test('Chromium applies the restrictive default header to a resource without CSP metadata', async t => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-apps-header-'));
    t.after(() => rm(cwd, {recursive:true, force:true}));
    const reported = Promise.withResolvers();
    const viewer = await openRenderer({
        server:'fixture', tool:'example', input:{}, result:{content:[],structuredContent:{label:'HEADER'}},
        config:{command:process.execPath,args:[fileURLToPath(new URL('app-server.mjs', import.meta.url)), join(cwd,'methods'), 'check-header']},
        cwd, cols:60, rows:16, confirmOpen: () => true,
        onFrame(frame) {
            if (frame.flat().map(cell => cell[0]).join('').includes('STRICT HEADER')) reported.resolve(true);
        }
    });
    try {
        assert.equal(await Promise.race([reported.promise, sleep(5000, false, {ref:false})]), true);
    } finally { viewer.close(); await viewer.closed; }
});
