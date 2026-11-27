import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { skill, scenarioOf } from '../../polyfills/skills/core/test-fixtures/harness.ts';
import { deliverOnce, destination } from '../../polyfills/events/grok-bot/src/deliver.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const jobs = [];
const dirs = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'ap-packaged-')); dirs.push(dir); return dir; };
afterEach(async () => {
    for (const stop of jobs.splice(0).reverse()) await stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function child(args, env = {}) {
    const proc = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = once(proc, 'close');
    jobs.push(async () => { proc.kill(); await closed; });
    return proc;
}
function stdio(proc) {
    const waits = new Map();
    createInterface({ input: proc.stdout }).on('line', line => {
        const msg = JSON.parse(line); waits.get(msg.id)?.(msg); waits.delete(msg.id);
    });
    let id = 0;
    return async (method, params = {}) => {
        const msg = { jsonrpc: '2.0', id: ++id, method, params };
        const answer = new Promise(ok => waits.set(id, ok));
        proc.stdin.write(JSON.stringify(msg) + '\n');
        return answer;
    };
}
async function publisher(script, env) {
    // Expose the independently authored stdio publisher to an HTTP-only plugin.
    const rpc = stdio(child([script], env));
    const server = createServer(async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        let raw = ''; for await (const c of req) raw += c;
        const q = JSON.parse(raw);
        if (q.id == null) { res.writeHead(202).end(); return; }
        const reply = await rpc(q.method, q.params);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...reply, id: q.id }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    jobs.push(() => { server.closeAllConnections(); return new Promise(ok => server.close(ok)); });
    return 'http://127.0.0.1:' + server.address().port + '/mcp';
}
async function plugin(feature, config, http = false) {
    const dir = scratch(), path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify(config));
    const secret = randomBytes(32).toString('hex');
    const proc = child(['polyfills/' + feature + '/muse/plugin/dist/server.mjs','--config',path,...(http ? ['--http'] : [])], { AGENTPOLYFILL_TOKEN: secret, PORT:'0' });
    let rpc;
    if (http) {
        const [line] = await once(proc.stderr, 'data');
        const url = 'http://127.0.0.1:' + line.toString().match(/Listening on 127\.0\.0\.1:(\d+)/)[1] + '/mcp';
        assert.equal((await fetch(url, { method:'POST' })).status, 401);
        rpc = async (method, params = {}) => (await fetch(url, { method:'POST',headers:{ 'content-type':'application/json', authorization:'Bearer ' + secret },body:JSON.stringify({ jsonrpc:'2.0',id:1,method,params }) })).json();
    } else rpc = stdio(proc);
    assert.ok((await rpc('initialize', { protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'} })).result.capabilities.tools);
    const call = async (name, args = {}) => {
        const m = await rpc('tools/call', { name, arguments: args });
        if (m.error || m.result?.isError) throw Error(m.error?.message ?? m.result.content[0].text);
        const raw = m.result.content[0].text;
        try { return JSON.parse(raw); } catch { return raw; }
    };
    call.tools = (await rpc('tools/list')).result.tools;
    return call;
}
test('catalogs preserve identity and only read the selected verified root', { timeout: 30000 }, async () => {
    const dir = scratch(), src = join(dir, 'catalog'), log = join(dir, 'reads');
    const a = skill('guide/one/setup'), b = skill('guide/two/setup'), nested = skill('guide/one/setup/nested');
    const scenario = scenarioOf([a,b,nested]); writeFileSync(src, JSON.stringify(scenario));
    const url = await publisher('polyfills/skills/core/test-fixtures/fixture-skills-server.ts', { FIXTURE_SCENARIO:src, FIXTURE_LOG:log });
    const call = await plugin('skills', { sources:{ local:url },askBeforeReading:false }, true);
    const [catalog] = await call('discover_skills');
    assert.deepEqual(catalog.skills.map(s => s.uri).sort(), [a.uri,b.uri,nested.uri].sort());
    const reads = () => readFileSync(log,'utf8').split('\n').filter(l => l && JSON.parse(l).method === 'resources/read').length;
    assert.equal(reads(),0);
    assert.match(await call('read_skill',{source:'local',uri:nested.uri}), /declined/);
    assert.equal(reads(),0);
    const result = await call('read_skill',{source:'local',uri:b.uri});
    assert.equal(result.uri,b.uri); assert.match(result.instructions,/Body of setup/); assert.equal(reads(),1);
    scenario.files[b.uri].text += '!'; writeFileSync(src,JSON.stringify(scenario));
    await assert.rejects(call('read_skill',{source:'local',uri:b.uri}));
    await assert.rejects(call('read_skill',{source:'unconfigured',uri:a.uri}));
});
test('Tasks supports allowlisted calls, polling, results and cancellation through both transports', { timeout:30000 }, async () => {
    const dir = scratch(), port = join(dir,'port');
    child(['polyfills/tasks/codex/test/fixture-tasks-server.mjs','--http',port]);
    while (!existsSync(port)) await delay(20);
    const cfg = {sources:{demo:'http://127.0.0.1:' + readFileSync(port,'utf8') + '/mcp'},tools:{demo:['slow','long','echo','ask']}};
    for (const http of [false,true]) {
        const call = await plugin('tasks',cfg,http);
        assert.equal((await call('list_task_tools',{source:'demo'})).length,4);
        const direct = call.tools.find(t => t.name.startsWith('job_demo_echo_'));
        assert.equal(direct.inputSchema.properties.text.type,'string');
        assert.match(JSON.stringify(await call(direct.name,{text:'named job'})),/named job/);
        const run = (tool,args={}) => call('run_task',{source:'demo',tool,arguments:args});
        await assert.rejects(run('fail'));
        const a=await run('slow',{text:'blue lantern'}); assert.equal(a.status,'working');
        await delay(750); assert.match(JSON.stringify(await call('check_task',{handle:a.handle})),/done: blue lantern/);
        const b=await run('long'); assert.ok((await call('cancel_task',{handle:b.handle})).cancellationRequested);
        await delay(300); assert.equal((await call('check_task',{handle:b.handle})).status,'cancelled');
        await assert.rejects(call('check_task',{handle:'someone-elses-task'}));
    }
});
test('Muse monitor polls after attachment, wakes once with fixed text, and keeps payload in the inbox', { timeout:20000 }, async () => {
    const dir=scratch(), log=join(dir,'wire'), feed=join(dir,'feed');
    writeFileSync(feed,'');
    const url=await publisher('polyfills/events/claude-code/test/fixture-events-server.ts',{FIXTURE_UPSTREAM:feed,FIXTURE_LOG:log});
    const call=await plugin('events',{sources:{demo:url}});
    assert.ok((await call('list_events',{source:'demo'})).includes('ticket.created'));
    await assert.rejects(call('prepare_watch',{source:'demo',event:'pollable'}));
    const prepare = () => call('prepare_watch',{source:'demo',event:'ticket.created'});
    await prepare(); assert.equal((await call('read_notice')).status, 'awaiting_monitor'); await call('stop_watch');
    const count = () => readFileSync(log,'utf8').split('\n').filter(l => l && JSON.parse(l).m?.method === 'events/poll').length;
    assert.equal(count(),0);
    const { ws }=await prepare();
    const socket=new WebSocket(ws), message=once(socket,'message');
    await once(socket,'open');
    while (!count()) await delay(30);
    const occurrence = { name:'ticket.created',eventId:'receipt-1',timestamp:new Date().toISOString(),data:{title:'publisher content'} };
    writeFileSync(feed,JSON.stringify(occurrence)+'\n');
    const [event]=await message; assert.equal(event.data,'A subscribed event is ready. Read it with read_notice.');
    assert.equal((await call('read_notice')).event.data.title,'publisher content');
    assert.match(await call('read_notice'),/empty/);
});
test('a Grok routine gets one empty POST across concurrent senders and ambiguous failures', async () => {
    const dir=scratch();
    const url=destination('https://api2.cursor.sh/automations/webhook/01234567-1234-1234-1234-123456789abc');
    assert.throws(()=>destination('https://example.org/'));
    let sent=0;
    const send=async (_url, opts) => { sent++; assert.equal(opts.body,''); assert.equal(opts.redirect,'error'); throw Error('connection lost after dispatch'); };
    const attempt=()=>deliverOnce(url,'test-test-test-key',dir,send);
    await Promise.all([assert.rejects(attempt()),assert.rejects(attempt())]); await assert.rejects(attempt());
    assert.equal(sent,1);
});
