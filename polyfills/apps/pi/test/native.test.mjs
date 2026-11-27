import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeBridge } from '../native.mjs';
import { hostActions } from '../actions.mjs';

test('concurrent native calls keep a distinct private receipt and revoke it after replacement', async () => {
    nativeBridge.interactive = true;
    const definition = {name:'original',_meta:{ui:{resourceUri:'ui://test/view'}}};
    const hidden = {name:'app',_meta:{ui:{visibility:['app']}}};
    const model = {name:'model',_meta:{ui:{visibility:['model']}}};
    const client = {connectionState:'connected',serverCapabilities:{resources:{}},
        async callTool(name, args) { return {content:[],_meta:{receipt:args.id},structuredContent:{value:args.id}}; }};
    const owner = {entry:{name:'fixture',config:{}},client};
    assert.deepEqual(nativeBridge.catalog(client,[definition,hidden,model]), [definition,model]);
    nativeBridge.started = () => { throw Error('Early view is unavailable'); };
    const [first, second] = await Promise.all([1,2].map(id => nativeBridge.call(owner,client,'original',{id},{})))
        .finally(() => { nativeBridge.started = undefined; });
    assert.deepEqual([first,second],[{content:[]},{content:[]}]);
    const one = nativeBridge.take(first.content), two = nativeBridge.take(second.content);
    assert.equal(one.result._meta.receipt,1);
    assert.equal(two.result._meta.receipt,2);
    assert.equal(nativeBridge.take([]),undefined);
    assert.deepEqual((await one.resource('tools/list',{})).tools,[definition,hidden]);
    assert.equal((await one.toolCall(hidden,{id:3}))._meta.receipt,3);
    await assert.rejects(one.toolCall(model,{}),/does not grant/);
    owner.entry.config.toolExposure = {app:'hidden'};
    await assert.rejects(one.toolCall(hidden,{}),/does not grant/);
    delete owner.entry.config.toolExposure;
    await assert.rejects(one.toolCall(definition,{},undefined,() =>
        nativeBridge.call(owner,client,'original',{substituted:true},{})), /changed/);
    nativeBridge.catalog(client,[definition,model]);
    await assert.rejects(one.toolCall(hidden,{}),/does not grant/);
    owner.client = {...client};
    await assert.rejects(two.resource('resources/list',{}),/original Pi MCP connection/);
});

test('host actions apply the reviewed value, await the action and report refusal', async () => {
    const operations = [], prompts = [];
    let grant = false;
    const {request} = hostActions({ confirm(title, text){ prompts.push([title,text]); return grant; },
        send:text => operations.push(['message',text]), setContext:text => operations.push(['context',text]),
        launch: async url => operations.push(['url',url]), copy: async text => operations.push(['clipboard',text]), display: () => 'inline' });
    await assert.rejects(request('ui/open-link',{url:'https://example.org/test'}),/declined/);
    await assert.rejects(request('ui/message',{role:'user',content:[{type:'text',text:'Hello'}]}),/declined/);
    assert.deepEqual(operations,[]);
    grant = true;
    await request('ui/message',{role:'user',content:[{type:'text',text:'Hello'}]});
    await request('ui/update-model-context',{structuredContent:{value:3}});
    await request('ui/open-link',{url:'https://example.org/test'});
    await request('ui/copy',{text:'Hello'});
    assert.deepEqual(operations,[['message','Hello'],['context','{"value":3}'],['url','https://example.org/test'],['clipboard','Hello']]);
    await assert.rejects(request('ui/open-link',{url:'file:///tmp/readme'}));
    await assert.rejects(request('ui/message',{role:'assistant',content:[{type:'text',text:'Hello'}]}));
    assert.deepEqual(await request('ui/allow-download',{files:[{name:'report.txt',size:8}]}),{allow:true});
    assert.deepEqual(prompts.at(-1),['Save to your Downloads folder?','report.txt (8 bytes)']);
    assert.deepEqual(await request('ui/request-display-mode',{mode:'pip'}),{mode:'inline'});
});
