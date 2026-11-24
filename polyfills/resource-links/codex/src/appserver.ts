// Reading a resource through Codex's own app server, with its
// `mcpServer/resource/read` request (Codex 0.172, experimental API). Codex does
// the reading, with its own configuration, server approvals and sign-in; the
// plugin never sees a credential and opens no connection to an MCP server.
//
//   1. The app-server daemon ($CODEX_HOME/app-server-control/app-server-control.sock,
//      WebSocket frames over a Unix socket), which the terminal UI and the desktop app
//      use, with the session's thread id: Codex reads through that session's own live
//      connection to the server.
//   2. Otherwise (no daemon, or the daemon doesn't have the thread, as under `codex
//      exec`), a `codex app-server` the plugin starts over stdio, without a thread id:
//      Codex opens a fresh connection to the server for the read.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { describeError, oneLine } from '../../core/src/untrusted.ts';
import { codexCandidates, daemonSocketOf } from './config.ts';
import { PLUGIN, VERSION } from './version.ts';

type Json = Record<string, unknown>;
export type Answer = { result?: unknown; error?: { code?: number; message?: string } };

/** One JSON-RPC connection to an app server. */
interface Channel {
    request(method: string, params: Json, timeoutMs: number): Promise<Answer>;
    close(): void;
}

/** What reads a resource for the plugin; tests give their own. */
export interface Reader {
    read(server: string, uri: string, thread: string | undefined): Promise<{ contents: unknown; via: string } | { error: string }>;
    close(): void;
}

const TIMEOUT_MS = 60_000;

function rpc(write: (line: string) => void): { onMessage: (text: string) => void; request: Channel['request']; failAll: (why: string) => void } {
    let id = 0;
    const pending = new Map<number, (a: Answer) => void>();
    return {
        onMessage(text) {
            let m: Json;
            try {
                m = JSON.parse(text) as Json;
            } catch {
                return;
            }
            if (typeof m.id === 'number' && m.method === undefined) {
                pending.get(m.id)?.({ result: m.result, error: m.error as Answer['error'] });
                pending.delete(m.id);
            } else if (m.id !== undefined && typeof m.method === 'string') {
                // A request from the app server to its client (an approval, a question): this client
                // answers none of them, so nothing is decided in the person's place.
                write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `${PLUGIN} does not answer this` } }));
            }
        },
        request(method, params, timeoutMs) {
            const n = ++id;
            return new Promise<Answer>((done) => {
                const timer = setTimeout(() => {
                    pending.delete(n);
                    done({ error: { message: `no answer to ${method} in ${Math.round(timeoutMs / 1000)} s` } });
                }, timeoutMs);
                pending.set(n, (a) => {
                    clearTimeout(timer);
                    done(a);
                });
                write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }));
            });
        },
        failAll(why) {
            for (const [n, done] of pending) done({ error: { message: why } });
            pending.clear();
        },
    };
}

async function opened(ch: Channel): Promise<Channel> {
    const init = await ch.request('initialize', { clientInfo: { name: PLUGIN, version: VERSION }, capabilities: { experimentalApi: true } }, 20_000);
    if (init.error) {
        ch.close();
        throw new Error(`Codex's app server did not start a session (${oneLine(init.error.message)})`);
    }
    return ch;
}

/** `codex app-server` over stdio, started by the plugin. `command` replaces it (tests). */
export async function stdioChannel(env: NodeJS.ProcessEnv, command?: readonly string[]): Promise<Channel> {
    let last = 'codex was not found';
    const tries: [string, string[]][] = command ? [[command[0]!, command.slice(1)]] : codexCandidates(env).map((bin) => [bin, ['app-server']]);
    for (const [bin, args] of tries) {
        const child: ChildProcess = spawn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'], env });
        const started = await new Promise<boolean>((done) => {
            child.once('spawn', () => done(true));
            child.once('error', (e) => {
                last = describeError(e);
                done(false);
            });
        });
        if (!started) continue;
        const r = rpc((line) => child.stdin?.write(line + '\n'));
        createInterface({ input: child.stdout! }).on('line', r.onMessage);
        child.once('exit', () => r.failAll("Codex's app server stopped"));
        child.stdin?.on('error', () => {});
        const ch: Channel = { request: r.request, close: () => child.kill() };
        return opened(ch).then((c) => {
            child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
            return c;
        });
    }
    throw new Error(`could not start codex app-server (${last})`);
}

/** One WebSocket frame from a client: final, masked. */
function frame(opcode: number, payload: string): Buffer {
    const body = Buffer.from(payload);
    const n = body.length;
    let head: Buffer;
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
    for (let i = 0; i < n; i++) body[i]! ^= mask[i & 3]!;
    return Buffer.concat([head, mask, body]);
}

const MAX_FRAME = 64 * 1024 * 1024;

/** The app-server daemon's control socket, as Codex's own clients reach it. */
export async function daemonChannel(codexHome: string): Promise<Channel | undefined> {
    const path = daemonSocketOf(codexHome);
    if (!existsSync(path)) return undefined;
    // The socket's path is a link to a short one (a Unix socket's path is limited to about 100 bytes).
    let real: string;
    try {
        real = realpathSync(path);
    } catch {
        return undefined;
    }
    const socket: Socket = connect(real);
    const r = rpc((line) => socket.write(frame(0x1, line)));
    const ok = await new Promise<boolean>((done) => {
        let raw = Buffer.alloc(0);
        let parts: Buffer[] = [];
        let upgraded = false;
        socket.once('error', () => done(false));
        socket.on('close', () => r.failAll("Codex's app-server daemon closed the connection"));
        socket.on('connect', () => {
            socket.write(`GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
        });
        socket.on('data', (d: Buffer) => {
            raw = Buffer.concat([raw, d]);
            if (!upgraded) {
                const end = raw.indexOf('\r\n\r\n');
                if (end < 0) return;
                if (!/^HTTP\/1\.1 101\b/.test(raw.subarray(0, end).toString().split('\r\n')[0] ?? '')) {
                    socket.destroy();
                    return done(false);
                }
                raw = raw.subarray(end + 4);
                upgraded = true;
                done(true);
            }
            for (;;) {
                if (raw.length < 2) return;
                const fin = (raw[0]! & 0x80) !== 0;
                const op = raw[0]! & 0x0f;
                const masked = (raw[1]! & 0x80) !== 0;
                let len = raw[1]! & 0x7f;
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
                if (len > MAX_FRAME) {
                    socket.destroy();
                    return;
                }
                if (raw.length < at + (masked ? 4 : 0) + len) return;
                const mask = masked ? raw.subarray(at, at + 4) : undefined;
                if (masked) at += 4;
                const payload = Buffer.from(raw.subarray(at, at + len));
                raw = raw.subarray(at + len);
                if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
                if (op === 0x9) socket.write(frame(0xa, payload.toString()));
                else if (op === 0x8) socket.destroy();
                else if (op === 0x1 || op === 0x2 || op === 0x0) {
                    parts.push(payload);
                    if (fin) {
                        const text = Buffer.concat(parts).toString('utf8');
                        parts = [];
                        r.onMessage(text);
                    }
                }
            }
        });
    });
    if (!ok) return undefined;
    const ch: Channel = { request: r.request, close: () => socket.destroy() };
    const c = await opened(ch).catch(() => undefined);
    if (c) socket.write(frame(0x1, JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })));
    return c;
}

/** Codex's app server, as the plugin uses it: the daemon with the thread when it has it, else a stdio app server. */
export class AppServerReader implements Reader {
    private stdio?: Promise<Channel>;
    private readonly codexHome: string;
    private readonly env: NodeJS.ProcessEnv;
    private readonly log: (line: string) => void;
    private readonly command?: readonly string[];
    /** `o.command` replaces `codex app-server` (tests). */
    constructor(codexHome: string, env: NodeJS.ProcessEnv, log: (line: string) => void = () => {}, o: { command?: readonly string[] } = {}) {
        this.codexHome = codexHome;
        this.env = env;
        this.log = log;
        this.command = o.command;
    }

    async read(server: string, uri: string, thread: string | undefined): ReturnType<Reader['read']> {
        if (thread) {
            const daemon = await daemonChannel(this.codexHome).catch(() => undefined);
            if (daemon) {
                try {
                    const a = await daemon.request('mcpServer/resource/read', { threadId: thread, server, uri }, TIMEOUT_MS);
                    if (!a.error) return { contents: a.result, via: "the session's own connection (Codex's app-server daemon)" };
                    // The daemon doesn't have this session (codex exec runs its own): read without it.
                    if (!/thread/i.test(String(a.error.message))) return { error: oneLine(a.error.message, 300) };
                    this.log(`the daemon does not have session ${thread}; reading through a stdio app server`);
                } finally {
                    daemon.close();
                }
            }
        }
        try {
            this.stdio ??= stdioChannel(this.env, this.command);
            const ch = await this.stdio;
            const a = await ch.request('mcpServer/resource/read', { server, uri }, TIMEOUT_MS);
            if (a.error) {
                if (/stopped/.test(String(a.error.message))) this.stdio = undefined;
                return { error: oneLine(a.error.message, 300) };
            }
            return { contents: a.result, via: 'a new connection Codex opened for this read (codex app-server)' };
        } catch (e) {
            this.stdio = undefined;
            return { error: describeError(e) };
        }
    }

    close() {
        this.stdio?.then((c) => c.close()).catch(() => {});
    }
}
