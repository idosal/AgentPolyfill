// Independent stdio fixture. The view displays the result supplied by Pi and requests
// a second tool call only when the user activates its button.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const uri = 'ui://fixture/example';
const html = `<button autofocus>Refresh</button><p>waiting</p><script>
const send = m => parent.postMessage({jsonrpc:'2.0', ...m}, '*');
addEventListener('message', ({data:m}) => {
  if (m.id === 1 && m.result) send({method:'ui/notifications/initialized'});
  if (m.method === 'ui/notifications/tool-result') document.querySelector('p').textContent = m.params.structuredContent.label;
  if (m.id === 2) document.querySelector('p').textContent = m.error ? 'DECLINED' : m.result.structuredContent.label;
});
document.querySelector('button').onclick = () => send({id:2,method:'tools/call',params:{name:'example',arguments:{}}});
send({id:1,method:'ui/initialize',params:{protocolVersion:'2026-01-26',appInfo:{name:'fixture',version:'1'},appCapabilities:{}}});
</script>`;
for await (const line of createInterface({input:process.stdin})) {
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    appendFileSync(process.argv[2], m.method + '\n');
    const result = {
        initialize: {protocolVersion:'2025-11-25',capabilities:{tools:{},resources:{}},serverInfo:{name:'fixture',version:'1'}},
        'tools/list': {tools:[{name:'example',inputSchema:{type:'object'},_meta:{ui:{resourceUri:uri}}}]},
        'resources/read': {contents:[{uri,mimeType:'text/html;profile=mcp-app',text:html}]}
    }[m.method];
    console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,...(result ? {result} : {error:{code:-32601,message:'Unsupported'}})}));
}
