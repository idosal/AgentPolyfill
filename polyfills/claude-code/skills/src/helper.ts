#!/usr/bin/env node
// mcp-skills: the mod's helper process.
//
// A Claude Code hooks module has no network or process of its own, and Claude
// Code gives a mod no way to send a request of an extension's own over its MCP
// connections. So the Skills client lives here, on connections of its own. The
// hooks module (mod/hooks/register.ts) starts this with the session's variables and
// talks to it two ways:
//
//   stdout  one JSON message per line, from here to the hooks module:
//             {t:"ready", url, token}     where the local endpoint listens
//             {t:"servers", names}        which configured servers this would connect to;
//                                         the hooks module answers with Claude Code's own
//                                         verdict on each (POST /verdict)
//             {t:"catalog", text, ...}    the skills found, for the session's skill listing
//   http    a local endpoint (127.0.0.1, a random port, a bearer token said only on
//           stdout), from the hooks module to here: /tool, /verdict, /catalog, /status,
//           /release, /stop
//
// Two things are written to disk: a log, and which of your servers serve skills (so the others are
// not connected to at every start). No skill content, no approvals, no tokens.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { App, type Known, type Verdict } from './app.ts';
import { discoverServers } from './config.ts';
import { describeError, LocalError, oneLine, secrets } from './untrusted.ts';
import { VERSION } from './version.ts';

const env = process.env;
const base = env.MCP_SKILLS_STATE || env.CLAUDE_PLUGIN_DATA || join(env.HOME ?? homedir(), '.mcp-skills');

// The log is for the user: private to them, kept small, and with known secrets taken out.
const logFile = join(base, 'mcp-skills.log');
try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    if (existsSync(logFile) && statSync(logFile).size > 2 * 1024 * 1024) renameSync(logFile, logFile + '.1');
    if (!existsSync(logFile)) writeFileSync(logFile, '', { mode: 0o600 });
    chmodSync(logFile, 0o600);
} catch {
    // logging is best effort
}
const log = (s: string) => {
    try {
        appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${oneLine(secrets.scrub(s), 600)}\n`);
    } catch {
        // no log
    }
};
// Nothing that goes wrong in the background should take the helper down with it.
process.on('unhandledRejection', (e) => log(`unexpected failure (${describeError(e)})`));

let stopping = false;
/** One message to the hooks module. If Claude Code is gone the pipe is too, and so is the reason to run. */
const emit = (m: Record<string, unknown>) => {
    try {
        process.stdout.write(JSON.stringify(m) + '\n');
    } catch {
        void stop();
    }
};
process.stdout.on('error', () => void stop());

// ---- Which servers, and Claude Code's verdict on each ----

const table = discoverServers(env, log);
// A servers file of the user's own (MCP_SKILLS_CONFIG) is not Claude Code's list, so Claude Code is not asked about it.
const askClaudeCode = !env.MCP_SKILLS_CONFIG;
const verdictWaiters = new Map<string, (v: Verdict) => void>();
const verdicts = new Map<string, Promise<Verdict>>(
    Object.keys(table.servers).map((name) => [
        name,
        askClaudeCode
            ? new Promise<Verdict>((done) => {
                  verdictWaiters.set(name, done);
                  // Claude Code may itself wait for the server to connect before it answers.
                  setTimeout(() => done({ ok: false, reason: 'unanswered' }), 45_000).unref();
              })
            : Promise.resolve({ ok: true })
    ])
);

// What earlier sessions learned of each server, by its name in the config: where it is (a
// fingerprint of its address or command, no credentials), and whether it declared the extension.
const knownFile = join(base, 'servers.json');
let known: Record<string, Known> = {};
try {
    const read = JSON.parse(readFileSync(knownFile, 'utf8')) as unknown;
    if (typeof read === 'object' && read !== null && !Array.isArray(read)) known = read as Record<string, Known>;
} catch {
    // nothing learned yet
}
const learn = (name: string, k: Known) => {
    known[name] = k;
    try {
        writeFileSync(knownFile, JSON.stringify(known), { mode: 0o600 });
    } catch {
        // it is looked at again next time
    }
};

let catalogSent = false;
const sendCatalog = () => {
    catalogSent = true;
    emit({ t: 'catalog', ...app.catalog() });
};
const app = new App({
    table,
    verdict: (name) => verdicts.get(name) ?? Promise.resolve({ ok: false, reason: 'unlisted' }),
    log,
    connectTimeoutMs: Number(env.MCP_SKILLS_CONNECT_TIMEOUT_MS ?? 10_000),
    onChange: () => catalogSent && sendCatalog(),
    known,
    onKnown: learn
});

// ---- The local endpoint ----

const token = randomBytes(32).toString('base64url');
const authorized = (req: IncomingMessage): boolean => {
    const given = Buffer.from(String(req.headers.authorization ?? ''));
    const wanted = Buffer.from(`Bearer ${token}`);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
};
const MAX_BODY = 1024 * 1024;
const body = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((done, fail) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY) {
                fail(new Error('too large'));
                req.destroy();
            } else chunks.push(c);
        });
        req.on('end', () => {
            try {
                const j = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) : {};
                done(typeof j === 'object' && j !== null && !Array.isArray(j) ? (j as Record<string, unknown>) : {});
            } catch (e) {
                fail(e as Error);
            }
        });
        req.on('error', fail);
    });

/** A call that arrives while servers are still being looked at waits for them, within reason. */
const settled = () => Promise.race([app.settled, new Promise((r) => setTimeout(r, 20_000).unref())]);
const routes: Record<string, (p: Record<string, unknown>) => Promise<unknown> | unknown> = {
    async '/tool'(p) {
        await settled();
        return app.call(String(p.name ?? ''), p.input);
    },
    '/verdict'(p) {
        verdictWaiters.get(String(p.name ?? ''))?.({ ok: p.ok === true, reason: typeof p.reason === 'string' ? p.reason : undefined });
        return {};
    },
    async '/catalog'() {
        await settled();
        return app.catalog();
    },
    async '/status'(p) {
        await settled();
        return { text: app.status(undefined, p.compact === true, typeof p.columns === 'number' ? p.columns : undefined), names: [...new Set(app.skills.map((l) => l.entry.frontmatter.name))].slice(0, 500), servers: app.configured };
    },
    // The facts of a skill's entry, for the approval question: no file is fetched.
    async '/entry'(p) {
        await settled();
        try {
            return await app.entry(String(p.server ?? ''), String(p.uri ?? ''));
        } catch (e) {
            return { error: e instanceof LocalError ? e.message : describeError(e) };
        }
    },
    // A skill's SKILL.md for the person to read. Not a load: nothing is held.
    async '/preview'(p) {
        await settled();
        try {
            const found = app.find(String(p.what ?? ''));
            if (found.length !== 1) return { candidates: found.map((l) => ({ server: l.label, uri: l.entry.uri, name: l.entry.frontmatter.name })) };
            const { entry, body, isVerified } = await app.host.preview(found[0]!.label, found[0]!.entry.uri);
            return { server: found[0]!.label, uri: entry.uri, name: entry.frontmatter.name, description: oneLine(entry.frontmatter.description, 1024), body, isVerified, files: entry.resources === 'dynamic' ? [] : entry.resources.filter((r) => r.uri !== entry.uri).map((r) => r.uri.slice(entry.uri.length - 'SKILL.md'.length)) };
        } catch (e) {
            return { error: e instanceof LocalError ? e.message : describeError(e) };
        }
    },
    async '/find'(p) {
        await settled();
        return { found: app.find(String(p.what ?? '')).map((l) => ({ server: l.label, uri: l.entry.uri, name: l.entry.frontmatter.name })) };
    },
    async '/refresh'() {
        await settled();
        await app.refresh();
        return {};
    },
    '/release'() {
        app.release();
        return {};
    },
    '/stop'() {
        setTimeout(() => void stop(), 10);
        return {};
    }
};

const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const answer = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
    };
    const route = req.method === 'POST' ? routes[new URL(req.url ?? '/', 'http://localhost').pathname] : undefined;
    if (!authorized(req)) return answer(401, { error: 'unauthorized' });
    if (!route) return answer(404, { error: 'not found' });
    body(req)
        .then((p) => route(p))
        .then(
            (value) => answer(200, value ?? {}),
            (e) => {
                log(`local endpoint: a request failed (${describeError(e)})`);
                answer(500, { error: 'failed' });
            }
        );
});
http.keepAliveTimeout = 60_000;
await new Promise<void>((done, fail) => {
    http.once('error', fail);
    http.listen(0, '127.0.0.1', done);
});
// `expects`: how many servers are known to serve skills or have not been looked at yet. The session
// waits a moment for those, so their skills are in its first listing; with none, it waits for nothing.
emit({ t: 'ready', url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, token, pid: process.pid, version: VERSION, expects: app.expected.length });
if (askClaudeCode && verdicts.size) emit({ t: 'servers', names: [...verdicts.keys()] });

void app.start().then(sendCatalog);

// The helper's standard input is closed from the start, so that is no signal: a tick notices
// when Claude Code itself has gone.
const parent = Number(env.CLAUDE_PID) || process.ppid;
const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
};
const tick = setInterval(() => {
    if (!alive(parent)) void stop();
}, 5000);

async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearInterval(tick);
    // Whatever happens below, this process ends.
    setTimeout(() => process.exit(0), 5000).unref();
    await app.stop().catch(() => {});
    http.close();
    http.closeAllConnections();
    process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGHUP', () => void stop());
// Ctrl-C in the terminal reaches every process of the session, and in Claude Code it interrupts a
// turn; it does not end the session. Claude Code stops the helper when the session ends.
process.on('SIGINT', () => {});
