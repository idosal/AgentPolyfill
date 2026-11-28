import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, symlinkSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { skill, scenarioOf } from '../../polyfills/skills/core/test-fixtures/harness.ts';
import { deliverOnce, destination } from '../../polyfills/events/grok-bot/src/deliver.ts';

import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { cardDraft, taskDraft } from './grok-draft.ts';
import { actions as approvalActions } from './skill-trace.mjs';
import { readDecision } from '../../polyfills/skills/muse/src/approval.ts';

test('skill approval policy names who decides before a file may be fetched', () => {
    for (const askBeforeReading of [undefined, true, false]) {
        for (const nested of [false, true]) {
            assert.equal(readDecision({ remote: true, ownerDialog: true, nested, askBeforeReading }), nested ? 'decline' : 'ask');
            assert.equal(readDecision({ remote: true, ownerDialog: false, nested, askBeforeReading }), !nested && askBeforeReading === false ? 'read' : 'decline');
            assert.equal(readDecision({ remote: false, ownerDialog: false, nested, askBeforeReading }), !nested && askBeforeReading === false ? 'read' : 'ask');
        }
    }
});

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
async function plugin(feature, config, http = false, environment = {}, commandArgs) {
    const dir = scratch(), path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify(config));
    const secret = randomBytes(32).toString('hex');
    const bundle = join(process.env.MUSE_GROK_TEST_KIT || root, 'polyfills', feature, 'muse/plugin/dist/server.mjs');
    const proc = child([bundle,...(commandArgs ?? ['--config',path]),...(http ? ['--http'] : [])], { AGENTPOLYFILL_TOKEN: secret, PORT:'0', ...environment });
    let rpc;
    if (http) {
        const [line] = await once(proc.stderr, 'data');
        const url = 'http://127.0.0.1:' + line.toString().match(/Listening on 127\.0\.0\.1:(\d+)/)[1] + '/mcp';
        assert.equal((await fetch(url, { method:'POST' })).status, 401);
        const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + secret };
        const get = await fetch(url, { headers });
        assert.equal(get.status, 405);
        assert.equal(get.headers.get('allow'), 'POST');
        const unsupported = await fetch(url, { method: 'POST', headers: { ...headers, 'mcp-protocol-version': 'unknown' } });
        assert.equal(unsupported.status, 400);
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
test('the installer checks all selected sources before changing any plugin', () => {
    const dir = scratch(), fake = join(dir, 'muse'), log = join(dir, 'commands');
    writeFileSync(fake, [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'const args = process.argv.slice(2);',
        'fs.appendFileSync(process.env.MUSE_TEST_LOG, JSON.stringify(args) + "\\n");',
        'if (args[1] === "list") console.log(process.env.MUSE_TEST_INVENTORY);'
    ].join('\n'), { mode: 0o700 });
    function install(source) {
        writeFileSync(log, '');
        const inventory = { plugins: [{ record: { id: 'mcp-task-monitor', source: { path: source } } }] };
        const result = spawnSync(process.execPath, ['tools/muse-grok/install-muse.mjs', 'events', 'tasks'], {
            cwd: root, encoding: 'utf8', env: { ...process.env, PATH: dir + ':' + process.env.PATH,
                MUSE_TEST_INVENTORY: JSON.stringify(inventory), MUSE_TEST_LOG: log }
        });
        const commands = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        return { result, commands };
    }
    const conflict = install(join(dir, 'other-source'));
    assert.equal(conflict.result.status, 1);
    assert.match(conflict.result.stderr, /different source/);
    assert.deepEqual(conflict.commands, [['plugins', 'list', '--json']]);
    const same = install(resolve(root, 'polyfills/tasks/muse/plugin'));
    assert.equal(same.result.status, 0, same.result.stderr);
    assert.deepEqual(same.commands.slice(1), [
        ['plugins', 'install', resolve(root, 'polyfills/events/muse/plugin')],
        ['plugins', 'update', 'mcp-task-monitor']
    ]);
});

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
    await assert.rejects(call('read_skill',{source:'local',uri:nested.uri}), /declined/);
    assert.equal(reads(),0);
    const byDefault = await plugin('skills', { sources: { local: url } }, true);
    await assert.rejects(byDefault('read_skill', { source: 'local', uri: b.uri }), /cannot show the approval dialog/);
    assert.equal(reads(), 0);
    const result = await call('read_skill',{source:'local',uri:b.uri});
    assert.equal(result.uri,b.uri); assert.match(result.instructions,/Body of setup/); assert.equal(reads(),1);
    scenario.files[b.uri].text += '!'; writeFileSync(src,JSON.stringify(scenario));
    await assert.rejects(call('read_skill',{source:'local',uri:b.uri}));
    await assert.rejects(call('read_skill',{source:'unconfigured',uri:a.uri}));
});
test('Muse uses only selected connections and binds a guide approval to its publisher', { timeout: 30000 }, async () => {
    const dir = scratch(), src = join(dir, 'catalog'), log = join(dir, 'reads');
    const guide = skill('queue-guide', { 'ref.txt': 'shared queue' });
    writeFileSync(src, JSON.stringify(scenarioOf([skill('other'), guide])));
    const fixture = 'polyfills/skills/core/test-fixtures/fixture-skills-server.ts';
    const uri = await publisher(fixture, { FIXTURE_SCENARIO:src, FIXTURE_LOG:log });
    const other = await publisher(fixture, { FIXTURE_SCENARIO:src, FIXTURE_LOG:join(dir,'ignored') });
    mkdirSync(join(dir, 'muse'));
    const config = join(dir, 'muse/settings.json');
    const save = connection => writeFileSync(config, JSON.stringify({ mcpServers: {
        'team.docs': connection, other: { url: other }
    } }));
    save({ url: uri });
    writeFileSync(join(dir,'native-config-home.json'), JSON.stringify(dir));
    writeFileSync(join(dir,'muse-servers.json'), JSON.stringify(['team.docs']));
    copyFileSync(join(root, 'polyfills/events/muse/test/fake-muse.mjs'), join(dir,'muse-cli'));
    mkdirSync(join(dir,'bin'));
    symlinkSync(join(dir,'muse-cli'), join(dir,'bin/muse'));
    chmodSync(join(dir,'muse-cli'),0o700);
    const env = { HOME:dir, MUSE_PLUGIN_DATA_DIR:dir, PATH:join(dir,'bin') + ':' + process.env.PATH };
    const configFile = { sources:{}, askBeforeReading:false };
    const call = await plugin('skills',configFile,false,env);
    const query = () => call('discover_skills', { query:'queue' });
    const [found] = await query();
    assert.equal(found.source,'team.docs');
    const nativeList = join(dir,'muse','skills');
    const owned = () => readdirSync(nativeList).filter(name => name.startsWith('mcp-skill-reference--team.docs-'));
    assert.ok(owned().length);
    await assert.rejects(call('discover_skills', { source:'unconfigured' }), /configured source/);
    assert.ok(owned().length);
    assert.equal(found.skills[0].uri,guide.uri);
    assert(!existsSync(join(dir,'ignored')));
    const args = { source:'team.docs', uri:guide.uri };
    await call('read_skill',args);
    save({url:other});
    await assert.rejects(call('read_skill_file',{...args,path:'ref.txt'}), /Open the guide again/);
    save({url:uri});
    await assert.rejects(call('read_skill_file',{...args,path:'ref.txt'}), /first/);
    for (const unsupported of [{ disabled:true }, { oauth:true }, { headers:{ Authorization:'Bearer ${AUTH}' } }]) {
        save({url:uri, ...unsupported});
        assert.ok((await query())[0].error);
    }
    save({url:uri});
    writeFileSync(join(dir,'muse-servers.json'), '[]');
    assert.ok((await query())[0].error);
    assert.deepEqual(owned(), []);
    await assert.rejects(call('read_skill',args), /no longer selected/);
    writeFileSync(join(dir,'muse-servers.json'), JSON.stringify(['team.docs']));
    const managed = await plugin('skills',configFile,false,{...env,FAKE_MUSE_POLICY:'present'});
    assert.ok((await managed('discover_skills'))[0].error);
    const remote = await plugin('skills',configFile,true,env);
    assert.deepEqual(await remote('discover_skills'),[]);
});

test('Muse lists publisher metadata and reads only supporting files of the opened manifest in this session', { timeout:30000 }, async () => {
    const dir = scratch(), src = join(dir, 'catalog'), log = join(dir, 'reads');
    const path = 'references/queues.md';
    const guide = skill('queue-guide', { [path]: 'Keep all GPU listeners in one queue.' });
    const scenario = scenarioOf([guide]);
    writeFileSync(src, JSON.stringify(scenario));
    const url = await publisher('polyfills/skills/core/test-fixtures/fixture-skills-server.ts', { FIXTURE_SCENARIO:src, FIXTURE_LOG:log });
    const cfg = { sources:{ public:url }, askBeforeReading:false };
    // Muse strips XDG_CONFIG_HOME from its child. The installer records the caller's config home.
    writeFileSync(join(dir,'native-config-home.json'), JSON.stringify(dir));
    const env = { XDG_CONFIG_HOME:'', HOME:dir, MUSE_PLUGIN_DATA_DIR:dir };
    const call = await plugin('skills', cfg, false, env);
    const args = { source:'public', uri:guide.uri, path };
    await call('discover_skills');
    const list = join(dir,'muse','skills');
    const [folder] = readdirSync(list).filter(n => n.startsWith('mcp-skill-reference--'));
    const stub = readFileSync(join(list,folder,'SKILL.md'),'utf8');
    assert.match(stub,/mcp-skills:public:queue-guide/);
    assert.ok(stub.includes('Reference 1: '+path));
    assert.ok(!stub.includes('Keep all GPU listeners'));
    const reads = () => readFileSync(log,'utf8').split('\n').filter(l => l && JSON.parse(l).method === 'resources/read').length;
    await assert.rejects(call('read_skill_file',args));
    assert.equal(reads(),0);
    const opened = await call('read_skill',{source:'public',uri:guide.uri});
    assert.deepEqual(opened.files,[guide.root+'/'+path]);
    assert.equal(reads(),1);
    await assert.rejects(call('read_skill_file',{...args,path:'../other.txt'}));
    await assert.rejects(call('read_skill_file',{...args,path:'SKILL.md'}));
    await assert.rejects(call('read_skill_file',{...args,path:'unlisted.md'}));
    const other = await plugin('skills',cfg);
    await assert.rejects(other('read_skill_file',args));
    assert.equal(reads(),1);
    assert.equal((await call('read_skill_file',args)).text,'Keep all GPU listeners in one queue.');
    const hook = join(root, 'polyfills/skills/muse/plugin/dist/user-prompt-submit.mjs');
    const withHook = (prompt, enabled) => {
        writeFileSync(join(dir,'muse/settings.json'), JSON.stringify({runtime_capabilities:{'plugin:mcp-skill-reference:mcp_server:skills':{enabled}}}));
        return spawnSync(process.execPath,[hook],{env:{...process.env,...env},input:JSON.stringify({prompt}),encoding:'utf8'}).stdout;
    };
    assert.match(withHook('How should I set up the queue?',true),/mcp-skills:public:queue-guide/);
    assert.equal(withHook('Tell me the time',true),'');
    assert.equal(withHook('How should I set up the queue?',false),'');
    assert.ok(!call.tools.some(t=>t.name.startsWith('consult_')));
    assert.equal(withHook('Use what we already opened about the queue.',true),'');
    const before = reads();
    await assert.rejects(call('read_skill',{...args, reference:'../other.md'}));
    assert.equal(reads(), before);
    const combined = await call('read_skill',{...args,reference:path});
    assert.equal(combined.uri, guide.uri);
    assert.deepEqual(combined.reference, { uri: guide.root + '/' + path, text: 'Keep all GPU listeners in one queue.' });
    assert.equal(reads(), before + 2);
    scenario.files[guide.root+'/'+path].text = 'Unverified bytes';
    writeFileSync(src,JSON.stringify(scenario));
    await assert.rejects(call('read_skill_file',args));
    const changed = skill('queue-guide',{[path]:'A changed reference.'});
    writeFileSync(src,JSON.stringify(scenarioOf([changed])));
    await assert.rejects(call('read_skill_file',args));
    writeFileSync(src,JSON.stringify(scenarioOf([guide])));
    await assert.rejects(call('read_skill_file',args));
    const remote = await plugin('skills',cfg,true);
    assert.equal(remote.tools.some(t => t.name==='read_skill_file'),false);
    writeFileSync(src,JSON.stringify(scenarioOf([])));
    await call('discover_skills');
    assert.equal(existsSync(join(list,folder,'SKILL.md')),false);
    assert.equal(existsSync(join(dir,'.config','muse','skills')),false);
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
test('foreground wait receives a new event, times out, and releases its single watch on cancellation', { timeout: 30000 }, async () => {
    const dir = scratch(), log = join(dir, 'wire'), feed = join(dir, 'feed');
    writeFileSync(feed, '');
    const url = await publisher('polyfills/events/claude-code/test/fixture-events-server.ts', { FIXTURE_UPSTREAM: feed, FIXTURE_LOG: log });
    const call = await plugin('events', { sources: { tickets: url } });
    const watch = seconds => call('wait_for_event', { source: 'tickets', event: 'ticket.created', seconds });
    await assert.rejects(watch(0));
    assert.equal((await watch(1)).status, 'timed_out');
    const pending = watch(10);
    await assert.rejects(watch(1));
    await call('stop_watch');
    assert.equal((await pending).status, 'stopped');
    const ready = watch(10);
    await delay(200);
    const event = { name: 'ticket.created', eventId: 'once', timestamp: new Date().toISOString(), data: { title: 'Blue notebook' } };
    writeFileSync(feed, JSON.stringify(event) + '\n');
    const notice = await ready;
    assert.equal(notice.status, 'received');
    assert.deepEqual(notice.event.data, event.data);
    assert.match(await call('read_notice'), /No active watch/);
});

test('packaged reader replays the scoped approval and changed-manifest trace', async () => {
    const dir = scratch(), scenario = join(dir, 'catalog'), log = join(dir, 'wire');
    const path = 'references/queue.md';
    const publish = body => {
        const guide = skill('queue-guide', { [path]: body });
        writeFileSync(scenario,JSON.stringify(scenarioOf([guide])));
        return guide.uri;
    };
    const uri = publish('first version');
    const url = await publisher('polyfills/skills/core/test-fixtures/fixture-skills-server.ts', {FIXTURE_SCENARIO:scenario, FIXTURE_LOG:log});
    const denied = await plugin('skills',{sources:{public:url}},true);
    const second = await plugin('skills',{sources:{public:url},askBeforeReading:false});
    const guide = {source:'public',uri}, file = {...guide,path};
    const trace = ['Ask'];
    await assert.rejects(denied('read_skill',guide),/declined/);
    assert.ok(!readFileSync(log,'utf8').includes('"resources/read"'));
    trace.push('Decline','Ask');
    await second('read_skill',guide);
    trace.push('Allow');
    assert.equal((await second('read_skill_file',file)).text,'first version');
    trace.push('ReadFile');
    publish('second version');
    trace.push('Change');
    await assert.rejects(second('read_skill_file',file),/changed/);
    await assert.rejects(second('read_skill_file',file),/first/);
    trace.push('Reopen','Ask');
    await second('read_skill',guide);
    trace.push('Allow');
    assert.equal((await second('read_skill_file',file)).text,'second version');
    trace.push('ReadFile');
    assert.deepEqual(trace,approvalActions);
});

const fastMcpUrl = process.env.MUSE_GROK_FASTMCP_URL;
test('the packaged Tasks adapters finish a job on FastMCP over both transports', { skip: !fastMcpUrl, timeout: 45000 }, async () => {
    const config = { sources: { arithmetic: fastMcpUrl }, tools: { arithmetic: ['slow_add'] } };
    for (const remote of [false, true]) {
        const call = await plugin('tasks', config, remote);
        const job = call.tools.find(t => t.name.startsWith('job_arithmetic_slow_add_'));
        assert.ok(job, 'FastMCP advertised its addition job');
        let state = await call(job.name, { a: 37, b: 48, seconds: 0.5 });
        const handle = state.handle;
        assert.equal(typeof handle, 'string');
        while (state.status === 'working') {
            await delay(Math.max(250, state.retryAfterMs));
            state = await call('check_task', { handle });
        }
        assert.equal(state.status, 'completed');
        assert.match(JSON.stringify(state.result), /37 \+ 48 = 85/);
    }
});

test('Command uses one allowlisted job and keeps its handle', {skip: !fastMcpUrl, timeout: 25000}, async () => {
    const endpoint = 'https://public.example/mcp', shim = join(scratch(), 'fixture.mjs');
    writeFileSync(shim, `const send = globalThis.fetch; globalThis.fetch = (url, opts) => {
        if (String(url) !== ${JSON.stringify(endpoint)}) throw Error('Unexpected destination');
        return send(${JSON.stringify(fastMcpUrl)}, opts);
    };`);
    const args = ['--publisher', endpoint, '--allow-tool', 'slow_add'];
    const call = await plugin('tasks', {}, false, { NODE_OPTIONS: '--import=' + shim }, args);
    const jobs = call.tools.filter(t => t.name.startsWith('job_'));
    assert.equal(jobs.length, 1);
    await assert.rejects(call('run_task', {source:'publisher', tool:'greet', arguments:{}}));
    let state = await call(jobs[0].name, {a:37,b:48,seconds:0.5});
    assert.ok(state.handle);
    while (state.status === 'working') {
        await delay(Math.max(250, state.retryAfterMs));
        state = await call('check_task', {handle: state.handle});
    }
    assert.match(JSON.stringify(state.result), /37 \+ 48 = 85/);
});
test('Command rejects credential URLs and mixed transport arguments', () => {
    for (const args of [
        ['--publisher','http://example.org','--allow-tool','add'],
        ['--publisher','https://user@public.example/mcp','--allow-tool','add'],
        ['--publisher','https://public.example/mcp?key=test','--allow-tool','add'],
        ['--publisher','https://public.example/mcp','--allow-tool','add','--http'],
        ['--publisher','https://public.example/mcp','--config','fixture']
    ]) {
        const run = spawnSync(process.execPath, ['polyfills/tasks/muse/plugin/dist/server.mjs',...args], { cwd:root, encoding:'utf8' });
        assert.equal(run.status,1); assert.match(run.stderr,/credential-free URL/);
    }
});

test('a Grok routine gets one empty POST across concurrent senders and ambiguous failures', async () => {
    const dir=scratch();
    const url=destination('https://api2.cursor.sh/automations/webhook/01234567-1234-1234-1234-123456789abc');
    assert.throws(()=>destination('https://example.org/'));
    let sent=0;
    const send=async (_url, opts) => { sent++; assert.equal(opts.body,''); assert.equal(opts.redirect,'error'); throw Error('connection lost after dispatch'); };
    const attempt=()=>deliverOnce(url,'test-test-test-key',dir,send);
    chmodSync(dir, 0o755);
    await assert.rejects(attempt(), /private receipt directory/);
    assert.equal(sent, 0);
    chmodSync(dir, 0o700);
    await Promise.all([assert.rejects(attempt()),assert.rejects(attempt())]); await assert.rejects(attempt());
    assert.equal(sent,1);
});

test('private config diagnostics withhold settings text and connections require safe transport', async () => {
    const { readMuseSettings, parseMuseServer } = await import('../../polyfills/events/muse/src/muse-config.ts');
    const dir = scratch(), file = join(dir,'settings.json'), marker = 'PRIVATE_FIXTURE_VALUE';
    writeFileSync(file, marker);
    const logs = [];
    const result = readMuseSettings({}, { file, only: ['chosen'], log: entry => logs.push(entry) });
    assert.deepEqual(Object.keys(result.servers), []);
    assert.ok(logs.length);
    assert.ok(!JSON.stringify([result.skipped,logs]).includes(marker));
    assert.deepEqual(Object.keys(readMuseSettings({}, { file, only: [] }).skipped), []);
    const configRoot = join(dir, 'muse');
    mkdirSync(configRoot);
    writeFileSync(join(configRoot,'settings.json'), marker);
    const args = [join(root,'tools/muse-grok/select-muse-sources.mjs'), 'skills'];
    const env = { ...process.env, HOME:dir, XDG_CONFIG_HOME:dir, XDG_DATA_HOME:dir };
    const choose = spawnSync(process.execPath, [...args,'chosen'], { env, encoding:'utf8' });
    assert.equal(choose.status, 1);
    assert.ok(!choose.stderr.includes(marker));
    assert.equal(spawnSync(process.execPath, [...args,'--clear'], { env, encoding:'utf8' }).status, 0);
    for (const url of ['http://source.example/mcp','https://source.example/mcp?inline=value','invalid']) {
        assert.ok('skip' in parseMuseServer({ url, headers: { 'X-Test': 'fixture' } }, dir));
    }
    assert.equal(parseMuseServer({ url:'https://source.example/mcp' }, dir).url, 'https://source.example/mcp');
    assert.equal(parseMuseServer({ url:'http://127.0.0.1/mcp' }, dir).url, 'http://127.0.0.1/mcp');
});

test('native skill activation and remote approvals disclose only the chosen verified files', { timeout:30000 }, async () => {
    const dir=scratch(), file=join(dir,'catalog'), wire=join(dir,'wire'), config=join(dir,'sources.json');
    const path='references/output.md', guide=skill('output-guide',{[path]:'Use a different file for each request.'});
    writeFileSync(file,JSON.stringify(scenarioOf([guide])));
    const url=await publisher('polyfills/skills/core/test-fixtures/fixture-skills-server.ts',{FIXTURE_SCENARIO:file,FIXTURE_LOG:wire});
    writeFileSync(config,JSON.stringify({sources:{fixture:url},askBeforeReading:false}));
    mkdirSync(join(dir,'muse'),{recursive:true});
    writeFileSync(join(dir,'native-config-home.json'),JSON.stringify(dir));
    writeFileSync(join(dir,'muse/settings.json'),JSON.stringify({runtime_capabilities:{'plugin:mcp-skill-reference:mcp_server:skills':{enabled:true}}}));
    const mock=join(dir,'dialog.mjs'), decision=join(dir,'decision');
    // Run the Linux CI bundle with a mock of the macOS dialog for only the loopback fixture.
    writeFileSync(mock,`import cp from 'node:child_process'; import fs from 'node:fs'; import {promisify} from 'node:util'; import {syncBuiltinESMExports} from 'node:module';
        Object.defineProperty(process,'platform',{value:'darwin'});
        const original=cp.execFile.bind(cp),custom=cp.execFile[promisify.custom];
        cp.execFile=(...args)=>original(...args);
        cp.execFile[promisify.custom]=async(...args)=>{
            if(args[0]!=='/usr/bin/osascript')return custom.apply(cp,args);
            const msg=args[1].at(-1);
            if(!msg.includes(${JSON.stringify(' from '+url+' (')}) || !msg.includes(${JSON.stringify(path)})) throw Error('Unexpected dialog');
            return {stdout:fs.readFileSync(${JSON.stringify(decision)},'utf8'),stderr:''};
        };syncBuiltinESMExports();`);
    const env={MUSE_PLUGIN_DATA_DIR:dir,HOME:dir,XDG_CONFIG_HOME:'',NODE_OPTIONS:'--import='+mock};
    const reader=await plugin('skills',{},false,env,['--native-catalog','--config',config]);
    assert.deepEqual(reader.tools.map(t=>t.name),['read_publisher_files']);
    const list=join(dir,'muse/skills');
    for(let i=0;i<80 && !existsSync(join(dir,'guide-routes.json'));i++) await delay(50);
    const route=JSON.parse(readFileSync(join(dir,'guide-routes.json')))[0];
    const filename=join(list,route.folder,'SKILL.md');
    const hook=join(process.env.MUSE_GROK_TEST_KIT || root,'polyfills/skills/muse/plugin/dist/native-open.mjs');
    let turn=0;
    function select(name=filename,turnId='turn-'+(++turn)) {
        const payload={session_id:'test-session',turn_id:turnId,hook_event_name:'PostToolUse',tool_name:'read_skill',tool_response:'<read-skill-result name="output-guide" status="ok">\n<metadata>\npath: '+name+'\nlocator: file://'+name+'\nsource: user\n'};
        return spawnSync(process.execPath,[hook],{input:JSON.stringify(payload),encoding:'utf8',env:{...process.env,...env}}).stdout;
    }
    assert.equal(select(join(dir,'other/SKILL.md')),'');
    const selection=(turnId)=>{const msg=select(filename,turnId);assert.ok(!msg.includes('different file'));return msg.match(/selection ([a-f0-9]{48})/)[1]};
    const reads=()=>readFileSync(wire,'utf8').split('\n').filter(l=>l&&JSON.parse(l).method==='resources/read').map(l=>JSON.parse(l).params.uri);
    const suggest=join(process.env.MUSE_GROK_TEST_KIT || root,'polyfills/skills/muse/plugin/dist/user-prompt-submit.mjs');
    const event={hook_event_name:'UserPromptSubmit',session_id:'test-session',turn_id:'existing',prompt:'Use what we already opened.'};
    const previous=selection('previous-turn');
    spawnSync(process.execPath,[suggest],{input:JSON.stringify(event),env:{...process.env,...env}});
    assert.ok(select(filename,'existing').includes('already-open material'));
    await assert.rejects(reader('read_publisher_files',{selection:previous,reference:1}),/already in this conversation/);
    assert.deepEqual(reads(),[]);
    function begin(turn_id) {
        spawnSync(process.execPath,[suggest],{input:JSON.stringify({...event,turn_id,prompt:'Consult the selected skill.'}),env:{...process.env,...env}});
    }
    begin('declined-turn');
    writeFileSync(decision,'Decline');
    const first=selection('declined-turn');
    await assert.rejects(reader('read_publisher_files',{selection:first,reference:1}),/declined/);
    assert.deepEqual(reads(),[]);
    await assert.rejects(reader('read_publisher_files',{selection:first,reference:1}),/expired or was used/);
    writeFileSync(decision,'Read once');
    await assert.rejects(reader('read_publisher_files',{selection:selection('declined-turn'),reference:1}),/already requested/);
    assert.deepEqual(reads(),[]);
    begin('approved-turn');
    const second=selection('approved-turn'), calls=await Promise.allSettled([1,2].map(()=>reader('read_publisher_files',{selection:second,reference:1})));
    assert.equal(calls.filter(r=>r.status==='fulfilled').length,1);
    assert.deepEqual(reads(),[guide.uri,guide.root+'/'+path]);
    const remote=await plugin('skills',{},true,env,['--config',config,'--owner-approval']);
    await assert.rejects(remote('read_skill',{source:'fixture',uri:guide.uri,reference:'references/missing.md'}));
    assert.equal(reads().length,2);
    assert.equal((await remote('read_skill',{source:'fixture',uri:guide.uri,reference:path})).reference.text,'Use a different file for each request.');
    writeFileSync(decision,'Decline');
    await assert.rejects(remote('read_skill',{source:'fixture',uri:guide.uri,reference:path}),/declined/);
    assert.equal(reads().length,4);
    const unattended=await plugin('skills',{},true,{},['--config',config]);
    await assert.rejects(unattended('read_skill',{source:'fixture',uri:guide.uri,reference:path}),/requires owner approval/);
    assert.equal(reads().length,4);
});

test('Grok native skill ZIP supports a live catalog or one verified portable skill', async () => {
    const dir=scratch(), config=join(dir,'config'), scenario=join(dir,'catalog'), wire=join(dir,'wire');
    const path='references/output.md', first=skill('output-guide',{[path]:'A unique temporary path.'}), second=skill('other-guide');
    writeFileSync(scenario,JSON.stringify(scenarioOf([first,second])));
    const url=await publisher('polyfills/skills/core/test-fixtures/fixture-skills-server.ts',{FIXTURE_SCENARIO:scenario,FIXTURE_LOG:wire});
    writeFileSync(config,JSON.stringify({sources:{fixture:url}}));
    const pack=async (name,...extra)=>{
        const dest=join(dir,name+'.zip');
        await promisify(execFile)('python3',[join(process.env.MUSE_GROK_TEST_KIT||root,'tools/muse-grok/package.py'),dest,'--grok-skills-config',config,'--source','fixture',...extra]);
        const script="import json,sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({n:z.read(n).decode() for n in z.namelist()}))";
        return JSON.parse((await promisify(execFile)('python3',['-c',script,dest])).stdout);
    };
    const live=await pack('live');
    assert.equal(Object.keys(live).filter(path=>path.endsWith('/SKILL.md')).length,2);
    assert.ok(!JSON.stringify(live).includes('A unique temporary path.'));
    assert.ok(!readFileSync(wire,'utf8').includes('"resources/read"'));
    const archived=await pack('snapshot','--snapshot-skill',first.uri,'--reference',path);
    const manifestName = files => JSON.parse(files['.claude-plugin/plugin.json']).name;
    const other = await pack('other','--snapshot-skill',second.uri);
    assert.equal(new Set([live,archived,other].map(manifestName)).size,3);
    assert.equal(manifestName(await pack('same-guide','--snapshot-skill',first.uri)),manifestName(archived));
    assert.equal(Object.keys(archived).length,3);
    const body=Object.entries(archived).find(([n])=>n.endsWith('/SKILL.md'))[1];
    assert.ok(!body.includes('read_skill'));
    assert.ok(body.endsWith(first.files[first.uri].text.split('---\n').at(-1).trimEnd()) || body.trimEnd().endsWith(first.files[first.uri].text.split('---\n').at(-1).trim()));
    assert.equal(Object.entries(archived).find(([n])=>n.endsWith('/'+path))[1],'A unique temporary path.');
    assert.ok(!JSON.stringify(archived).includes(url));
});

test('publisher reference hints use general topics and leave ties unresolved', async () => {
    const {suggestedReference} = await import('../../polyfills/skills/muse/src/routes.ts');
    const refs = ['references/parallelism.md','references/billing.md'];
    assert.equal(suggestedReference('My workers share the same queue',refs),refs[0]);
    assert.equal(suggestedReference('How does billing work?',refs),refs[1]);
    assert.equal(suggestedReference('In Foobar both users get each other’s files', ['references/how-foobar-works.md',...refs],['foobar']),refs[0]);
    assert.equal(suggestedReference('How can I get started?',refs),undefined);
    assert.equal(suggestedReference('Configure parallel workers',[...refs,'references/concurrency.md']),undefined);
});

test('Grok installation drafts contain only reviewed parameters and wait for Send', () => {
    const id='00000000-0000-4000-8000-000000000001', url='https://publisher.example/mcp', c={url,headers:[],urlSecrets:[]};
    const draft=cardDraft(id,c,{kind:'none'});const parsed=new URL(draft.link);
    assert.equal(parsed.protocol,'grokbot:');assert.equal(parsed.pathname,'/v1/prompt');assert.equal(parsed.searchParams.get('text'),draft.text);
    assert.equal(parsed.searchParams.get('id'),id);assert.ok(draft.text.includes(url));
    assert.throws(()=>cardDraft(id,{...c,headers:[{}]},{kind:'none'}));
    assert.throws(()=>cardDraft(id,{...c,url:url+'?key=private'},{kind:'none'}));
    assert.throws(()=>cardDraft(id,c,{kind:'dynamic'}));
    const module='/opt/ap/polyfills/tasks/muse/plugin/dist/server.mjs';
    assert.ok(taskDraft(id,'/usr/bin/node',module,url,'add_numbers').text.includes(JSON.stringify([module,'--publisher',url,'--allow-tool','add_numbers'])));
    assert.throws(()=>taskDraft(id,'/usr/bin/sh',module,url,'add_numbers'));
    assert.throws(()=>taskDraft(id,'/usr/bin/node',module,url,'add numbers'));
});
