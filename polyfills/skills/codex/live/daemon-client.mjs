// A client of a running Codex app-server daemon, as the terminal UI is one: it connects to the
// daemon's control socket ($CODEX_HOME/app-server-control/app-server-control.sock, WebSocket
// frames over a Unix socket, as Codex's own app-server client does), starts one new session, and
// sends a turn per prompt, answering the plugin's question "Load it", as a person would. Before
// each turn it asks Codex which skills it lists for the project (skills/list) and prints which of
// them are served, and how often the plugin's server has started (from the plugin's log), then
// each tool call and the answer. With no prompt, it only starts the session.
//   node daemon-client.mjs <project dir> <prompt> [<prompt> ...]
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [cwd, ...prompts] = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
// The socket's path is a link to a short one (a Unix socket's path is limited to about 100 bytes).
const socket = connect(realpathSync(join(codexHome, 'app-server-control', 'app-server-control.sock')));

/** One WebSocket frame from the client: final, masked. */
function frame(opcode, payload) {
    const body = Buffer.from(payload);
    const n = body.length;
    let head;
    if (n < 126) head = Buffer.from([0x80 | opcode, 0x80 | n]);
    else if (n < 65536) {
        head = Buffer.from([0x80 | opcode, 0x80 | 126, 0, 0]);
        head.writeUInt16BE(n, 2);
    } else {
        head = Buffer.alloc(10);
        head[0] = 0x80 | opcode;
        head[1] = 0x80 | 127;
        head.writeBigUInt64BE(BigInt(n), 2);
    }
    const mask = randomBytes(4);
    for (let i = 0; i < n; i++) body[i] ^= mask[i & 3];
    return Buffer.concat([head, mask, body]);
}

let id = 0;
const pending = new Map();
const waiting = [];
const send = (m) => socket.write(frame(0x1, JSON.stringify({ jsonrpc: '2.0', ...m })));

function onMessage(text) {
    let m;
    try {
        m = JSON.parse(text);
    } catch {
        return;
    }
    if (m.id !== undefined && m.method === undefined) {
        pending.get(m.id)?.(m);
        return;
    }
    if (m.id !== undefined && m.method) {
        // A request from Codex to its client.
        if (m.method === 'mcpServer/elicitation/request') {
            console.log(`  [the plugin's question] ${String(m.params?.message ?? JSON.stringify(m.params)).split('\n')[0]} -> "Load it"`);
            send({ id: m.id, result: { action: 'accept', content: { decision: 'load' }, _meta: null } });
        } else if (/requestApproval$/.test(m.method)) {
            send({ id: m.id, result: { decision: 'accept' } });
        } else send({ id: m.id, error: { code: -32601, message: 'not handled by this client' } });
        return;
    }
    if (m.method === 'item/completed') {
        const it = m.params?.item ?? {};
        if (it.type === 'mcpToolCall') console.log(`  [tool] ${it.server}.${it.tool} ${JSON.stringify(it.arguments)} -> ${it.status}`);
        else if (it.type === 'commandExecution') console.log(`  [command] ${String(it.command).slice(0, 160)}`);
        else if (it.type === 'agentMessage') console.log(`  [answer] ${String(it.text).replace(/\s+/g, ' ').slice(0, 400)}`);
    }
    for (const w of [...waiting]) if (w.method === m.method) {
        waiting.splice(waiting.indexOf(w), 1);
        w.done(m);
    }
}

let raw = Buffer.alloc(0);
let parts = [];
let upgraded;
const opened = new Promise((done) => (upgraded = done));
socket.on('error', (e) => {
    console.error(`the daemon's socket: ${e.message}`);
    process.exit(1);
});
socket.on('connect', () => {
    const key = randomBytes(16).toString('base64');
    socket.write(`GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
});
socket.on('data', (d) => {
    raw = Buffer.concat([raw, d]);
    if (upgraded) {
        const end = raw.indexOf('\r\n\r\n');
        if (end < 0) return;
        const status = raw.subarray(0, end).toString().split('\r\n')[0];
        if (!/^HTTP\/1\.1 101\b/.test(status)) {
            console.error(`the daemon refused the connection: ${status}`);
            process.exit(1);
        }
        raw = raw.subarray(end + 4);
        upgraded();
        upgraded = undefined;
    }
    for (;;) {
        if (raw.length < 2) return;
        const fin = (raw[0] & 0x80) !== 0;
        const op = raw[0] & 0x0f;
        const masked = (raw[1] & 0x80) !== 0;
        let len = raw[1] & 0x7f;
        let at = 2;
        if (len === 126) {
            if (raw.length < 4) return;
            len = raw.readUInt16BE(2);
            at = 4;
        } else if (len === 127) {
            if (raw.length < 10) return;
            len = Number(raw.readBigUInt64BE(2));
            at = 10;
        }
        if (raw.length < at + (masked ? 4 : 0) + len) return;
        const mask = masked ? raw.subarray(at, at + 4) : undefined;
        if (masked) at += 4;
        const payload = Buffer.from(raw.subarray(at, at + len));
        raw = raw.subarray(at + len);
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        if (op === 0x9) socket.write(frame(0xa, payload));
        else if (op === 0x8) {
            console.error('the daemon closed the connection');
            process.exit(1);
        } else if (op === 0x1 || op === 0x2 || op === 0x0) {
            parts.push(payload);
            if (fin) {
                const text = Buffer.concat(parts).toString('utf8');
                parts = [];
                onMessage(text);
            }
        }
    }
});

const request = (method, params) => new Promise((done) => {
    const n = ++id;
    pending.set(n, done);
    send({ id: n, method, params });
});
const next = (method) => new Promise((done) => waiting.push({ method, done }));
const log = join(codexHome, 'mcp-skills', 'mcp-skills.log');
const starts = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('server(s) to look at')).length : 0);

setTimeout(() => {
    console.error('no answer from the daemon in 10 minutes');
    process.exit(1);
}, 10 * 60_000).unref();
await opened;
await request('initialize', { clientInfo: { name: 'mcp-skills-daemon-check', version: '0' }, capabilities: { experimentalApi: true } });
send({ method: 'initialized' });
const started = await request('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'on-request' });
if (started.error) {
    console.error(`thread/start: ${JSON.stringify(started.error)}`);
    process.exit(1);
}
const threadId = started.result?.thread?.id;
console.log(`session ${threadId}`);
for (const [i, text] of prompts.entries()) {
    const listed = await request('skills/list', { cwds: [cwd], forceReload: false });
    const served = [...new Set(JSON.stringify(listed.result ?? {}).match(/mcp-skills:[a-z0-9_-]+:[a-z0-9:_-]+/g) ?? [])];
    console.log(`turn ${i + 1}: Codex lists ${served.length} served skill(s)${served.length ? `, e.g. ${served.slice(0, 2).join(', ')}` : ''}; the plugin's server has started ${starts()} time(s) on this daemon so far`);
    console.log(`  [prompt] ${text}`);
    const done = next('turn/completed');
    await request('turn/start', { threadId, input: [{ type: 'text', text }] });
    await done;
}
socket.write(frame(0x8, Buffer.alloc(0)));
socket.end();
process.exit(0);
