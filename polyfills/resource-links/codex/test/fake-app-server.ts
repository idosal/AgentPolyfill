// A stand-in for Codex's app server, for the reader's tests: `initialize` and
// `mcpServer/resource/read`, as Codex 0.172 answers them. A read starts the fixture
// server (../../core/test/fixture-links-server.ts) as the named MCP server and asks
// it, as Codex opens a connection for a read. A read with a thread id this stand-in
// was not told about fails with "thread not loaded", as Codex's does.
//
//   node fake-app-server.ts                 JSON-RPC over stdio (codex app-server)
//   node fake-app-server.ts --listen <sock> the daemon: WebSocket frames over a Unix socket
//
// Env: FAKE_LOADED (comma-separated thread ids it has), FAKE_LOG (one JSON line per request).

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

type Json = Record<string, unknown>;
const FIXTURE = fileURLToPath(new URL('../../core/test/fixture-links-server.ts', import.meta.url));
const LOADED = (process.env.FAKE_LOADED ?? '').split(',').filter(Boolean);

function fixtureRead(server: string, uri: string): Promise<Json> {
    return new Promise((done) => {
        const p = spawn(process.execPath, [FIXTURE], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, FIXTURE_NAME: server, FIXTURE_LOG: '' } });
        const rl = createInterface({ input: p.stdout });
        rl.on('line', (l) => {
            const m = JSON.parse(l) as Json;
            if (m.id === 2) {
                p.kill();
                done(m.error ? { error: { code: -32603, message: `resources/read failed for \`${server}\` (${uri}): Mcp error: ${(m.error as Json).code}: ${(m.error as Json).message}` } } : { result: { ...(m.result as Json), originCallId: null } });
            }
        });
        p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake-codex', version: '0' } } }) + '\n');
        p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri } }) + '\n');
    });
}

async function handle(m: Json): Promise<Json | undefined> {
    if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ via: process.argv.includes('--listen') ? 'daemon' : 'stdio', method: m.method, params: m.params }) + '\n');
    if (m.id === undefined) return undefined;
    const p = (m.params ?? {}) as Json;
    switch (m.method) {
        case 'initialize':
            return { result: { userAgent: 'fake-codex/0.172.0', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' } };
        case 'mcpServer/resource/read': {
            if (typeof p.threadId === 'string' && !LOADED.includes(p.threadId)) return { error: { code: -32600, message: `thread not loaded: ${p.threadId}` } };
            return fixtureRead(String(p.server), String(p.uri));
        }
        default:
            return { error: { code: -32601, message: 'Method not found' } };
    }
}

const at = process.argv.indexOf('--listen');
if (at < 0) {
    createInterface({ input: process.stdin }).on('line', async (l) => {
        const m = JSON.parse(l) as Json;
        const a = await handle(m);
        if (a) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...a }) + '\n');
    });
} else {
    const frame = (text: string) => {
        const body = Buffer.from(text);
        const n = body.length;
        const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 0xff]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
        return Buffer.concat([head, body]);
    };
    createServer((s: Socket) => {
        let raw = Buffer.alloc(0);
        let open = false;
        s.on('data', async (d: Buffer) => {
            raw = Buffer.concat([raw, d]);
            if (!open) {
                const end = raw.indexOf('\r\n\r\n');
                if (end < 0) return;
                raw = raw.subarray(end + 4);
                open = true;
                s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: x\r\n\r\n');
            }
            for (;;) {
                if (raw.length < 2) return;
                let len = raw[1]! & 0x7f;
                let off = 2;
                if (len === 126) {
                    len = raw.readUInt16BE(2);
                    off = 4;
                } else if (len === 127) {
                    len = Number(raw.readBigUInt64BE(2));
                    off = 10;
                }
                if (raw.length < off + 4 + len) return;
                const mask = raw.subarray(off, off + 4);
                const body = Buffer.from(raw.subarray(off + 4, off + 4 + len));
                raw = raw.subarray(off + 4 + len);
                for (let i = 0; i < body.length; i++) body[i]! ^= mask[i & 3]!;
                const m = JSON.parse(body.toString()) as Json;
                const a = await handle(m);
                if (a) s.write(frame(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...a })));
            }
        });
        s.on('error', () => {});
    }).listen(process.argv[at + 1], () => process.stdout.write('listening\n'));
}
