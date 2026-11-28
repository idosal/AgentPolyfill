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
async function plugin(feature, config, http = false, environment = {}) {
    const dir = scratch(), path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify(config));
    const secret = randomBytes(32).toString('hex');
    const proc = child(['polyfills/' + feature + '/muse/plugin/dist/server.mjs','--config',path,...(http ? ['--http'] : [])], { AGENTPOLYFILL_TOKEN: secret, PORT:'0', ...environment });
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
    assert.match(stub,/read_skill/);
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
