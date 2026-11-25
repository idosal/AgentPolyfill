// Between the server T3 Code's agent starts for each thread and the one watcher that
// runs every thread's watches: one JSON line asked, one JSON line answered, over a
// local socket only the user can open.
//
// Where the socket is: <state>/watcher.sock when that path is short enough for the
// platform (Unix sockets have a limit of about 100 bytes), else a private folder of the
// user's own in the temporary directory. On Windows, a named pipe named after the
// state folder.
//
// Who can ask: any process of the same user can reach the socket, as it can already run
// `t3 thread send` (T3 Code lets the machine's own user message any thread without a
// sign-in). The folder holding the socket is the user's alone (0700), so nobody else can.

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

export type Request =
    | { op: 'call'; thread: string; name: string; args: Record<string, unknown> }
    | { op: 'ping' }
    | { op: 'stop' };
export type Answer = { text: string; isError?: boolean } | { pong: true; pid: number; version: string } | { stopping: true };

const MAX_LINE = 4 * 1024 * 1024;

export function socketPath(base: string, platform: NodeJS.Platform = process.platform): string {
    const id = createHash('sha256').update(resolve(base)).digest('hex').slice(0, 16);
    if (platform === 'win32') return `\\\\.\\pipe\\mcp-events-t3-${id}`;
    const near = join(base, 'watcher.sock');
    if (Buffer.byteLength(near) < 100) return near;
    let uid = 'user';
    try {
        uid = String(userInfo().uid);
    } catch {
        // no uid: the hash alone names it
    }
    const dir = join(tmpdir(), `mcp-events-t3-${uid}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Somebody else's folder, or one others can enter, is never used.
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || (typeof process.getuid === 'function' && st.uid !== process.getuid()) || (st.mode & 0o077) !== 0)
        throw new Error(`${dir} is not a private folder of this user's; set MCP_EVENTS_STATE to a shorter path`);
    return join(dir, `${id}.sock`);
}

/** Asks the watcher once. Rejects when nothing answers at the socket. */
export function ask(path: string, req: Request, timeoutMs = 120000): Promise<Answer> {
    return new Promise((done, fail) => {
        let buf = '';
        let settled = false;
        const sock: Socket = createConnection(path);
        const finish = (e: Error | undefined, a?: Answer) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            sock.destroy();
            if (e) fail(e);
            else done(a!);
        };
        const timer = setTimeout(() => finish(new Error('the watcher did not answer in time')), timeoutMs);
        sock.setEncoding('utf8');
        sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
        sock.on('data', (d: string) => {
            buf += d;
            if (buf.length > MAX_LINE) return finish(new Error('the watcher answered too much'));
            const nl = buf.indexOf('\n');
            if (nl < 0) return;
            try {
                finish(undefined, JSON.parse(buf.slice(0, nl)) as Answer);
            } catch {
                finish(new Error('the watcher answered something that is not JSON'));
            }
        });
        sock.on('error', (e) => finish(e));
        sock.on('close', () => finish(new Error('the watcher closed the connection without answering')));
    });
}

/** Reads one request line from a connection the watcher accepted. */
export function readRequest(sock: Socket, handle: (req: Request) => Promise<Answer>): void {
    let buf = '';
    let done = false;
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', (d: string) => {
        if (done) return;
        buf += d;
        if (buf.length > MAX_LINE) {
            done = true;
            return void sock.destroy();
        }
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        done = true;
        let req: Request;
        try {
            req = JSON.parse(buf.slice(0, nl)) as Request;
        } catch {
            return void sock.end(JSON.stringify({ text: 'not JSON', isError: true }) + '\n');
        }
        void handle(req)
            .catch((e: unknown) => ({ text: `the watcher failed to answer (${e instanceof Error ? e.message : String(e)}); its log says more`, isError: true }))
            .then((a) => sock.end(JSON.stringify(a) + '\n'));
    });
}
