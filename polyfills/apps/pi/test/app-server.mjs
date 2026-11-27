// Independent stdio fixture. The view displays the result supplied by Pi and requests
// a second tool call only when the user activates its button.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const uri = 'ui://fixture/example';
// The second version lets the review test detect an unintended second read.
let resourceReads = 0;
const policyFixture = process.argv[3] === 'review';
const blobFrame = process.argv[3] === 'blob-frame';
const testFrame = blobFrame || process.argv[3] === 'default-frame';
const embeddedPage = testFrame ? `<output></output><iframe title="local page"></iframe><script>
  const frame = document.querySelector('iframe');
  const status = document.querySelector('output');
  addEventListener('securitypolicyviolation', event => {
    if (event.effectiveDirective === 'frame-src') status.textContent = 'FRAME BLOCKED';
  });
  frame.addEventListener('load', () => {
    const text = frame.contentDocument?.body?.textContent;
    if (text) status.textContent = text;
  });
  frame.src = URL.createObjectURL(new Blob(['<p>LOCAL FRAME</p>'], {type:'text/html'}));
</script>` : '';
const policyProbe = process.argv[3] === 'check-header' ? `<output></output><script>
addEventListener('securitypolicyviolation', event => {
  const rules = event.originalPolicy.split(';').map(rule => rule.trim());
  if (event.effectiveDirective === 'img-src' && rules.includes("default-src 'none'") &&
      rules.includes("connect-src 'none'") && rules.includes("frame-src 'none'") &&
      rules.includes("script-src 'self' 'unsafe-inline'")) {
    document.querySelector('output').textContent = 'STRICT HEADER';
  }
});
const picture = new Image();
picture.src = URL.createObjectURL(new Blob([], {type:'image/png'}));
</script>` : '';
const html = `<button autofocus>Refresh</button><p>waiting</p><script>
const send = m => parent.postMessage({jsonrpc:'2.0', ...m}, '*');
addEventListener('message', ({data:m}) => {
  if (m.id === 1 && m.result) send({method:'ui/notifications/initialized'});
  if (m.method === 'ui/notifications/tool-result') document.querySelector('p').textContent = m.params.structuredContent.label;
  if (m.id === 2) document.querySelector('p').textContent = m.error ? 'DECLINED' : m.result.structuredContent.label;
});
document.querySelector('button').onclick = () => send({id:2,method:'tools/call',params:{name:'example',arguments:{}}});
send({id:1,method:'ui/initialize',params:{protocolVersion:'2026-01-26',appInfo:{name:'fixture',version:'1'},appCapabilities:{}}});
</script>` + policyProbe + embeddedPage;
for await (const line of createInterface({input:process.stdin})) {
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    appendFileSync(process.argv[2], m.method + '\n');
    if (m.method === 'resources/read') resourceReads++;
    const result = {
        initialize: {protocolVersion:'2025-11-25',capabilities:{tools:{},resources:{}},serverInfo:{name:'fixture',version:'1'}},
        'tools/list': {tools:[{name:'example',inputSchema:{type:'object'},_meta:{ui:{resourceUri:uri}}}]},
        'resources/read': {contents:[{uri,mimeType:'text/html;profile=mcp-app',text:html,
            ...(blobFrame ? {_meta:{ui:{csp:{frameDomains:['blob:']}}}} : {}),
            ...(policyFixture ? {_meta:{ui:{csp:{connectDomains:[resourceReads === 1 ? 'https://review.example' : 'https://changed.example', '*']}}}} : {})}]}
    }[m.method];
    console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,...(result ? {result} : {error:{code:-32601,message:'Unsupported'}})}));
}
