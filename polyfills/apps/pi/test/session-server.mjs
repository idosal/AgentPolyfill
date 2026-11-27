// This server exposes an app only to a client that negotiated the extension.
// The view needs the private result of this particular process and call.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const uri = 'ui://session/check';
const secret = randomUUID();
const tool = (name, ui) => ({name, inputSchema:{type:'object',properties:{label:{type:'string'},operation:{type:'string'}}}, _meta:{ui}});
const tools = [tool('start',{resourceUri:uri}), tool('view_action',{visibility:['app']}), tool('model_action',{visibility:['model']})];
const write = data => appendFileSync(process.argv[2], JSON.stringify({pid:process.pid,...data}) + '\n');
const html = `<!doctype html><button>Check session</button><p>Starting</p><script>
const output = document.querySelector('p');
const pending = new Map(), changes = new Set();
let id = 0, original, initialized;
const send = m => parent.postMessage({jsonrpc:'2.0',...m}, '*');
const call = (method,params={}) => new Promise((ok,fail) => { pending.set(++id,{ok,fail}); send({id,method,params}); });
addEventListener('message', ({data:m}) => {
  if (['notifications/tools/list_changed','notifications/resources/list_changed','notifications/prompts/list_changed'].includes(m.method)) changes.add(m.method);
  if (m.method === 'ui/resource-teardown') { send({id:m.id,result:{}}); return; }
  if (m.method === 'tools/list') { send({id:m.id,result:{tools:[{name:'echo',inputSchema:{type:'object'}}]}}); return; }
  if (m.method === 'tools/call') { send({id:m.id,result:{content:[{type:'text',text:'View tool completed'}]}}); return; }
  const waiter = pending.get(m.id);
  if (waiter) {pending.delete(m.id); m.error ? waiter.fail(Error(m.error.message)) : waiter.ok(m.result);}
  if (m.method === 'ui/notifications/tool-input') {
    initialized = m.params.arguments.label === 'originating call';
    if (${JSON.stringify(['live','cancel'].includes(process.argv[3]))}) call('resources/read',{uri:'fixture://finish'});
  }
  if (m.method === 'ui/notifications/tool-cancelled' && initialized) output.textContent = 'Active call cancelled';
  if (m.method === 'ui/notifications/tool-result') {
    original = m.params._meta?.receipt;
    output.textContent = original && initialized && m.params.structuredContent?.label === 'view data' ? 'Private result received' : 'WRONG RECEIPT';
  }
});
call('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'fixture',version:'1'},appCapabilities:{tools:{},availableDisplayModes:['inline','fullscreen','pip']}}).then(r=>{
  if (!r.hostCapabilities.serverTools || !r.hostCapabilities.serverResources) throw Error('Missing capability');
  send({method:'ui/notifications/initialized'});
  send({method:'notifications/message',params:{level:'info',data:'Private diagnostic from the view'}});
});
document.querySelector('button').onclick = async () => {
  try {
    try { await navigator.clipboard.writeText('Review clipboard text'); throw Error('Expected clipboard decline'); }
    catch(e) { if(e.message==='Expected clipboard decline') throw e; }
    await call('ping');
    const catalog = await call('tools/list');
    if (!catalog.tools.some(t=>t.name==='view_action') || catalog.tools.some(t=>t.name==='model_action')) throw Error('View catalog');
    try { await call('tools/call',{name:'model_action',arguments:{}}); throw Error('Expected denial'); }
    catch(e) { if(e.message==='Expected denial') throw e; }
    await call('resources/list'); await call('resources/templates/list'); await call('prompts/list');
    const read = await call('resources/read',{uri:'fixture://state'});
    if(read.contents[0].text !== original) throw Error('Wrong session');
    const update = await call('tools/call',{name:'view_action',arguments:{operation:'continue'}});
    if(update._meta.receipt !== original) throw Error('Private action');
    if (${JSON.stringify(process.argv[3] !== 'http')}) {
      for (let n=0; n<60 && changes.size<3; n++) await new Promise(done=>setTimeout(done,50));
      if (changes.size!==3) throw Error('Missing catalog change');
    }
    for (const mode of ['pip','fullscreen','inline']) {
      const result = await call('ui/request-display-mode',{mode});
      if (result.mode !== mode) throw Error('Display mode ' + mode);
    }
    try { await call('ui/open-link',{url:'https://example.org/pi-test'}); throw Error('Expected link decline'); }
    catch(e) { if(e.message==='Expected link decline') throw e; }
    const download = await call('ui/download-file',{contents:[{type:'resource',resource:{uri:'file:///session-note.txt',mimeType:'text/plain',text:'Verified Pi download'}}]});
    if(download.isError) throw Error('Download declined');
    await call('ui/update-model-context',{content:[{type:'text',text:'Previous selection'}]});
    await call('ui/update-model-context',{structuredContent:{selection:'Latest selection'}});
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    const ctx=canvas.getContext('2d'); ctx.fillStyle='#2255ee'; ctx.fillRect(0,0,16,16);
    await call('ui/message',{role:'user',content:[{type:'text',text:'Explain my selection'},
        {type:'image',mimeType:'image/png',data:canvas.toDataURL().split(',')[1]}]});
    output.textContent = 'Session checks passed';
  } catch (e) { output.textContent = 'Failed: '+e.message; }
};
</script>`;
let negotiated = false;
let pendingStart;
const original = {content:[{type:'text',text:'Public receipt ready'}],structuredContent:{label:'view data'},_meta:{receipt:secret}};

for await (const line of createInterface({input:process.stdin})) {
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    write({method:m.method, tool:m.params?.name});
    let result;
    switch (m.method) {
        case 'initialize':
            negotiated = m.params.capabilities.extensions?.['io.modelcontextprotocol/ui']?.mimeTypes?.includes('text/html;profile=mcp-app');
            write({negotiated:Boolean(negotiated)});
            result = {protocolVersion:'2025-11-25',serverInfo:{name:'session-check',version:'1'},capabilities:{tools:{listChanged:true},resources:{listChanged:true},prompts:{listChanged:true}}};
            break;
        case 'tools/list': result = {tools:negotiated ? tools : []}; break;
        case 'resources/list': result = {resources:[]}; break;
        case 'resources/templates/list': result = {resourceTemplates:[]}; break;
        case 'prompts/list': result = {prompts:[]}; break;
        case 'resources/read':
            if (m.params.uri === 'fixture://finish' && pendingStart !== undefined) {
                console.log(JSON.stringify({jsonrpc:'2.0',id:pendingStart,...(process.argv[3] === 'cancel' ? {error:{code:-32000,message:'Call stopped'}} : {result:original})}));
                pendingStart = undefined;
            }
            result = {contents:m.params.uri === uri ? [{uri,mimeType:'text/html;profile=mcp-app',_meta:{ui:{permissions:{clipboardWrite:{}}}},blob:Buffer.from(html).toString('base64')}]
                : [{uri:m.params.uri,text:secret}]}; break;
        case 'tools/call':
            if (m.params.name === 'start' && ['live','cancel'].includes(process.argv[3])) { pendingStart = m.id; continue; }
            if (m.params.name === 'view_action' && process.argv[3] !== 'http') {
                for (const kind of ['tools','resources','prompts']) console.log(JSON.stringify({jsonrpc:'2.0',method:'notifications/'+kind+'/list_changed'}));
            }
            result = original;
            break;
    }
    console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,...(result ? {result} : {error:{code:-32601,message:'Unsupported'}})}));
}
