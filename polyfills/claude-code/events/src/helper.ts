#!/usr/bin/env node
// mcp-events: the mod's helper process.
//
// A Claude Code hooks module has no network or process of its own, so the
// Events client lives here. The hooks module (mod/hooks/register.ts) starts this
// with the session's variables and talks to it two ways:
//
//   stdout  one JSON message per line, from here to the hooks module:
//             {t:"ready", url, token}     where the local endpoint listens
//             {t:"servers", names}        which configured servers this would connect to;
//                                         the hooks module answers with Claude Code's own
//                                         verdict on each (POST /verdict)
//             {t:"catalog", text, ...}    what can be watched, for the session's instructions
//             {t:"pending"}               events wait to be shown (POST /take, then /ack)
//             {t:"standby"}               nothing to do: this process is about to exit, and
//                                         is started again when a tool is called
//   http    a local endpoint (127.0.0.1, a random port, a bearer token said only on
//           stdout), from the hooks module to here: /tool, /verdict, /take, /ack, /stop
//
// It connects to the MCP servers Claude Code is configured with and itself uses,
// finds the ones that offer events, resumes this project's watches, and serves
// the tools Claude uses to manage them.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { discoverServers, isHttp } from './config.ts';
import { Delivery, type Batch } from './delivery.ts';
import { EventsConnection, preStandardPolicy } from './events-client.ts';
import { oneLine } from './format.ts';
import { readRelaySettings } from './relay.ts';
import { ProjectState, pruneSessions, sessionId, Spool, stateDir } from './store.ts';
import { createTools, type Unavailable } from './tools.ts';
import { describeError, secrets } from './untrusted.ts';
import { VERSION } from './version.ts';
import { WakeBudget, wakeLimits } from './wake.ts';
import { WatchManager } from './watcher.ts';

const env = process.env;
const base = stateDir();
const session = sessionId();
mkdirSync(base, { recursive: true, mode: 0o700 });

// The log is for the user: private to them, kept to a few megabytes, and with known secrets taken out.
const logFile = join(base, 'mcp-events.log');
const redact = secrets;
try {
    if (existsSync(logFile) && statSync(logFile).size > 2 * 1024 * 1024) renameSync(logFile, logFile + '.1');
    if (!existsSync(logFile)) writeFileSync(logFile, '', { mode: 0o600 });
    chmodSync(logFile, 0o600);
} catch {
    // logging is best effort
}
let logged = 0;
const log = (s: string) => {
    const line = `${new Date().toISOString()} [${session.slice(0, 8)}] ${oneLine(redact.scrub(s), 600)}`;
    try {
        // Checked now and then while running too, so a chatty server cannot fill the disk through the log.
        if (++logged % 200 === 0 && statSync(logFile).size > 2 * 1024 * 1024) {
            renameSync(logFile, logFile + '.1');
            writeFileSync(logFile, '', { mode: 0o600 });
        }
        appendFileSync(logFile, line + '\n');
    } catch {
        // state dir not ready yet
    }
};
// Nothing that goes wrong in the background should take the helper down with it.
process.on('unhandledRejection', (e) => log(`unexpected failure (${describeError(e)})`));

let stopping = false;
let tick: NodeJS.Timeout | undefined;
let pendingTimer: NodeJS.Timeout | undefined;

/** One message to the hooks module. If Claude Code is gone the pipe is too, and so is the reason to run. */
const emit = (m: Record<string, unknown>) => {
    try {
        process.stdout.write(JSON.stringify(m) + '\n');
    } catch {
        void stop();
    }
};
process.stdout.on('error', () => void stop());

const project = new ProjectState(base, resolve(env.CLAUDE_PROJECT_DIR ?? process.cwd()));
const spool = new Spool(base, session);
const delivery = new Delivery(spool, { values: env.MCP_EVENTS_WAKE_VALUES === '1' });
// How often events may wake this session (see wake.ts). Kept with the session's events, so a
// helper that restarts carries on counting.
const budget = new WakeBudget(wakeLimits(env), join(spool.dir, 'wakes.json'));
// Sessions that ended more than two weeks ago have nobody left to read their events.
try {
    const gone = pruneSessions(base, session);
    if (gone) log(`removed the stored events of ${gone} session(s) that ended more than two weeks ago`);
} catch {
    // best effort
}
const timeout = Number(env.MCP_EVENTS_CONNECT_TIMEOUT_MS ?? 10000);
const BATCH_MS = Number(env.MCP_EVENTS_BATCH_MS ?? 1000);
/** How long this waits with nothing to do before it stands by (exits until a tool is called). */
const STANDBY_MS = Number(env.MCP_EVENTS_STANDBY_MS ?? 20000);

const conns: EventsConnection[] = [];
const unavailable: Unavailable[] = [];
const manager = new WatchManager({ connections: new Map(), project, spool, session, log, connectTimeoutMs: timeout, redact });
const tools = createTools(
    () => conns,
    () => unavailable,
    manager
);

// ---- Events waiting to be shown ----

/** What `/take` last handed over, until it is acknowledged: a batch of events, or the one notice that waking has stopped. */
let taken: { batch: Batch } | { notice: true } | undefined;

/** The next thing to hand to Claude Code, if the wake budget allows one now. */
function next(): { lines: string[]; upto: number } | { waitMs: number } | undefined {
    const batch = delivery.take();
    if (!batch) return undefined;
    // Nothing to show (blank lines): it is only marked as read.
    if (!batch.lines.length) return { lines: [], upto: batch.upto };
    const gate = budget.gate(batch.watches);
    if (gate.kind === 'go') {
        taken = { batch };
        return { lines: batch.lines, upto: batch.upto };
    }
    if (gate.kind === 'notice') {
        // The events stay where they are: the notice is handed over with the position unchanged.
        taken = { notice: true };
        return { lines: [budget.notice(batch.events)], upto: delivery.position };
    }
    return gate.kind === 'wait' ? { waitMs: gate.ms } : undefined;
}

let pendingAt = 0;
const announce = (afterMs = BATCH_MS) => {
    // A burst is announced once, a moment after it starts, so it is handed over as one batch. A
    // look that is already due sooner stands; one due later gives way.
    const at = Date.now() + afterMs;
    if (pendingTimer && pendingAt <= at) return;
    clearTimeout(pendingTimer);
    pendingAt = at;
    pendingTimer = setTimeout(() => {
        pendingTimer = undefined;
        if (!delivery.pending) return;
        const n = next();
        if (!n) return; // waking has stopped until the person speaks
        if ('waitMs' in n) return announce(n.waitMs + 50); // a watch woke the session less than its gap ago
        emit({ t: 'pending' });
    }, afterMs);
};
spool.onAppend = (rec) => {
    // An event of a watch that may not wake the session yet waits for its time, without the spool being read for it.
    const gate = budget.gate([String(rec.watch ?? '')]);
    if (gate.kind === 'paused') return;
    announce(gate.kind === 'wait' ? gate.ms + 50 : BATCH_MS);
};

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

type Verdict = { ok: boolean; reason?: string };
const verdictWaiters = new Map<string, (v: Verdict) => void>();
/** Resolved once every configured server has been looked at (or the wait for them is over). */
let settled!: () => void;
const allSettled = new Promise<void>((r) => (settled = r));
let lastActivity = Date.now();
let inFlight = 0;

const routes: Record<string, (p: Record<string, unknown>) => Promise<unknown> | unknown> = {
    async '/tool'(p) {
        // A tool called while servers are still being looked at waits for them, within reason.
        await Promise.race([allSettled, new Promise((r) => setTimeout(r, timeout + 5000).unref())]);
        return tools.call(String(p.name ?? ''), p.input);
    },
    '/verdict'(p) {
        const name = String(p.name ?? '');
        verdictWaiters.get(name)?.({ ok: p.ok === true, reason: typeof p.reason === 'string' ? p.reason : undefined });
        return {};
    },
    '/take'() {
        const n = next();
        return n && 'lines' in n ? n : {};
    },
    '/ack'(p) {
        const upto = Number(p.upto);
        // Claude Code took it, so it counts: a batch as one wake for its watches, the notice as said.
        if (taken && 'notice' in taken) budget.pause();
        else if (taken && upto >= taken.batch.upto) budget.woke(taken.batch.watches);
        taken = undefined;
        delivery.ack(upto);
        if (delivery.pending) announce();
        return {};
    },
    // The person sent a message of their own: if waking had stopped at its hourly limit, it starts again.
    '/spoke'() {
        budget.spoke();
        if (delivery.pending) announce();
        return {};
    },
    '/catalog': () => catalog(),
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
    inFlight++;
    lastActivity = Date.now();
    body(req)
        .then((p) => route(p))
        .then(
            (value) => answer(200, value ?? {}),
            (e) => {
                log(`local endpoint: a request failed (${describeError(e)})`);
                answer(500, { error: 'failed' });
            }
        )
        .finally(() => {
            inFlight--;
            lastActivity = Date.now();
        });
});
http.keepAliveTimeout = 60000;
await new Promise<void>((done, fail) => {
    http.once('error', fail);
    http.listen(0, '127.0.0.1', done);
});
emit({ t: 'ready', url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, token, pid: process.pid, version: VERSION });

// ---- Which servers, and Claude Code's verdict on each ----

const REFUSALS: Record<string, string> = {
    unlisted: 'Claude Code does not list a server by that name in this session',
    unapproved: 'it is not approved in Claude Code yet',
    disabled: 'it is switched off in Claude Code',
    policy: "your organisation's MCP policy does not allow it",
    auth: 'Claude Code says it needs a sign-in (run /mcp), and this mod cannot use Claude Code\'s sign-in: see "Servers that need sign-in" in the README',
    unanswered: 'Claude Code did not say whether it uses this server'
};

const table = discoverServers(env, log);
redact.add(env.MCP_EVENTS_RELAY_ACCESS_KEY, readRelaySettings(env)?.accessKey);
for (const cfg of Object.values(table.servers)) {
    if (isHttp(cfg)) {
        redact.add(...Object.values(cfg.headers ?? {}));
        try {
            const u = new URL(cfg.url);
            redact.add(u.password, u.username, ...[...u.searchParams.values()]);
        } catch {
            // not an address: it will fail to connect
        }
    } else redact.add(...Object.values(cfg.env ?? {}));
}
unavailable.push(...Object.entries(table.skipped).map(([name, why]) => ({ name, why })));
// Servers that advertise events only in the form that came before the standard (the one ChatGPT
// reads) are used too, unless MCP_EVENTS_PRE_STANDARD turns that off or names the only ones to use.
const preStandard = preStandardPolicy(env.MCP_EVENTS_PRE_STANDARD);
// A servers file of the user's own (MCP_EVENTS_CONFIG) is not Claude Code's list, so Claude Code is not asked about it.
const askClaudeCode = !env.MCP_EVENTS_CONFIG;
const names = Object.keys(table.servers);
const verdicts = new Map<string, Promise<Verdict>>(
    names.map((name) => [
        name,
        askClaudeCode
            ? new Promise<Verdict>((done) => {
                  verdictWaiters.set(name, done);
                  // Claude Code may itself wait for the server to connect before it answers.
                  setTimeout(() => done({ ok: false, reason: 'unanswered' }), 45000).unref();
              })
            : Promise.resolve({ ok: true })
    ])
);
if (askClaudeCode && names.length) emit({ t: 'servers', names });

// A server that turned out not to offer events is not connected to again at every session start
// (for a local server that would mean starting it a second time, every time): the answer is kept
// for a day, by how the server is reached. It is asked again when Claude calls a tool (the hooks
// module then starts the helper with MCP_EVENTS_PROBE=fresh), and always when a watch names it.
const PROBE_TTL_MS = 24 * 60 * 60 * 1000;
const probeFile = join(base, 'servers-without-events.json');
const without: Record<string, number> = (() => {
    try {
        const j = JSON.parse(readFileSync(probeFile, 'utf8')) as unknown;
        return typeof j === 'object' && j !== null && !Array.isArray(j) ? (j as Record<string, number>) : {};
    } catch {
        return {};
    }
})();
const freshProbe = env.MCP_EVENTS_PROBE === 'fresh';
const watched = new Set(project.watches.filter((w) => w.status !== 'ended').map((w) => w.server));
const knownWithout = (name: string, fingerprint: string) => !freshProbe && !watched.has(name) && typeof without[fingerprint] === 'number' && Date.now() - without[fingerprint]! < PROBE_TTL_MS;
const remember = (fingerprint: string, has: boolean) => {
    if (has && !(fingerprint in without)) return;
    if (has) delete without[fingerprint];
    else without[fingerprint] = Date.now();
    for (const [k, at] of Object.entries(without)) if (Date.now() - at >= PROBE_TTL_MS) delete without[k];
    try {
        writeFileSync(probeFile, JSON.stringify(without), { mode: 0o600 });
    } catch {
        // asked again next time
    }
};

let catalogSent = false;
const catalog = () => ({ text: tools.instructions(), eventTypes: conns.reduce((n, c) => n + c.eventTypes.length, 0), watches: manager.watches.filter((w) => w.status !== 'ended').length });
const sendCatalog = () => {
    catalogSent = true;
    emit({ t: 'catalog', ...catalog() });
};

let started = false;
/** Claims this project's watches and resumes them, once the servers they need have been looked at. */
const startWatches = () => {
    if (started) return;
    started = true;
    manager.start();
    if (manager.watches.length) log(`resumed ${manager.watches.length} watch(es); owner=${manager.owner}`);
};

void Promise.all(
    Object.entries(table.servers).map(async ([name, cfg]) => {
        const verdict = await verdicts.get(name)!;
        if (!verdict.ok) {
            // Claude Code itself would not use this server (now): neither does this.
            const why = REFUSALS[verdict.reason ?? ''] ?? 'Claude Code does not use it in this session';
            unavailable.push({ name, why });
            log(`${name}: left alone: ${why}`);
            return;
        }
        const c = new EventsConnection(name, cfg, { preStandard: preStandard(name) });
        c.log = log;
        if (knownWithout(name, c.fingerprint)) return;
        try {
            await c.connect(timeout);
        } catch {
            if (c.needsSignIn) unavailable.push({ name, why: c.error ?? 'needs sign-in' });
            log(`${name}: not connected: ${c.error}`);
            return;
        }
        if (!c.declaration) {
            // No events as the extension defines them: nothing is sent, and no second connection is kept open.
            const why = c.outsideTheSpec;
            if (why) {
                unavailable.push({ name, why });
                log(`${name}: ${why}`);
            } else remember(c.fingerprint, false);
            await c.close();
            return;
        }
        try {
            await c.list();
            remember(c.fingerprint, true);
            conns.push(c);
            manager.connections.set(name, c);
            c.onListChanged = () => catalogSent && sendCatalog();
            log(`${name}: ${c.eventTypes.length} event type(s) (protocol revision ${c.revision}${c.declaration === 'pre-standard' ? '; it advertises events in the form from before the standard, which is used unless MCP_EVENTS_PRE_STANDARD=off' : ''})`);
        } catch (e) {
            unavailable.push({ name, why: `events/list failed: ${describeError(e)}` });
            await c.close();
        }
    })
).then(() => {
    startWatches();
    settled();
    sendCatalog();
    if (delivery.pending) announce();
});

// Another session ran this project's watches when this one started. If it goes, this one takes over.
// The same tick notices that Claude Code itself has gone (this helper's standard input is closed from
// the start, so that is no signal), and that there is nothing to do.
const parent = Number(env.CLAUDE_PID) || process.ppid;
const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
};
tick = setInterval(() => {
    if (!alive(parent)) return void stop();
    if (!started) return;
    if (!manager.owner && manager.start()) {
        log("the session that ran this project's watches has gone; this one runs them now");
        sendCatalog();
    }
    // Nothing offers events, nothing is watched, nothing waits to be shown, and nobody has asked for a
    // while: stand by. The hooks module starts this again when a tool is called.
    const watched = manager.watches.filter((w) => w.status !== 'ended').length;
    if (STANDBY_MS > 0 && conns.length === 0 && watched === 0 && !delivery.pending && inFlight === 0 && Date.now() - lastActivity > STANDBY_MS) {
        emit({ t: 'standby' });
        void stop();
    }
}, Math.min(5000, Math.max(250, STANDBY_MS / 4 || 5000)));

async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    if (tick) clearInterval(tick);
    if (pendingTimer) clearTimeout(pendingTimer);
    // Whatever happens below, this process ends.
    setTimeout(() => process.exit(0), 8000).unref();
    await manager.stop().catch(() => {});
    await Promise.all(conns.map((c) => c.close().catch(() => {})));
    http.close();
    http.closeAllConnections();
    process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGHUP', () => void stop());
// Ctrl-C in the terminal reaches every process of the session, and in Claude Code it interrupts a
// turn; it does not end the session. So it does not end this either: Claude Code stops the helper
// when the session ends (/stop, then SIGTERM), and the tick above notices if Claude Code is gone.
process.on('SIGINT', () => {});
