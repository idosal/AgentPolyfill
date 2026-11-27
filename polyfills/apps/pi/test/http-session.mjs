// Loopback-only MCP transport and token endpoint for the isolated Pi TUI test.
// Both bearer values and the refresh grant are synthetic, scoped to this process.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const log = process.argv[2], session = randomUUID();
const fixture = spawn(process.execPath,[fileURLToPath(new URL('session-server.mjs',import.meta.url)),log,'http'],{stdio:['pipe','pipe','inherit']});
const pending = new Map();
let expired = false, origin;
function json(res, status, value, headers = {}) {
    res.writeHead(status, {'Content-Type':'application/json',...headers});
    res.end(JSON.stringify(value));
}
const server = createServer(async (req,res) => {
    if (req.url.startsWith('/.well-known/oauth-protected-resource')) {
        json(res,200,{resource:origin+'/mcp',authorization_servers:[origin]}); return;
    }
    if (req.url.startsWith('/.well-known/oauth-authorization-server')) {
        json(res,200,{issuer:origin,authorization_endpoint:origin+'/authorize',token_endpoint:origin+'/token',
            response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],
            token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256']}); return;
    }
    if (req.url === '/token') {
        let body='';
        for await(const chunk of req) body+=chunk;
        const form = new URLSearchParams(body);
        if (form.get('grant_type') !== 'refresh_token' || form.get('refresh_token') !== 'fixture-refresh') {json(res,400,{error:'invalid_grant'});return;}
        appendFileSync(log,JSON.stringify({refresh:true})+'\n');
        json(res,200,{access_token:'fixture-current',refresh_token:'fixture-refresh',token_type:'Bearer',expires_in:3600}); return;
    }
    if (req.url !== '/mcp') {res.writeHead(404).end();return;}
    if (req.method === 'GET' || req.method === 'DELETE') {res.writeHead(405).end();return;}
    const valid = req.headers.authorization === 'Bearer fixture-current' || (!expired && req.headers.authorization === 'Bearer fixture-initial');
    if (!valid) {json(res,401,{}, {'WWW-Authenticate':'Bearer resource_metadata="'+origin+'/.well-known/oauth-protected-resource"'});return;}
    let body='';
    for await (const chunk of req) body+=chunk;
    const message = JSON.parse(body);
    if (message.method !== 'initialize' && req.headers['mcp-session-id'] !== session) {json(res,404,{});return;}
    if (message.id === undefined) {res.writeHead(202).end();return;}
    if (message.method === 'tools/call' && message.params.name === 'start') expired = true;
    pending.set(message.id,res);
    fixture.stdin.write(body+'\n');
});
createInterface({input:fixture.stdout}).on('line', line => {
    const message = JSON.parse(line), res=pending.get(message.id);
    if (res) {pending.delete(message.id);json(res,200,message,{'Mcp-Session-Id':session});}
});
server.listen(0,'127.0.0.1',() => {
    origin = 'http://127.0.0.1:'+server.address().port;
    console.log(origin+'/mcp');
});
process.once('SIGTERM',() => {fixture.kill();server.closeAllConnections();server.close();});
