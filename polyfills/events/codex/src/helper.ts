#!/usr/bin/env node
// mcp-events for Codex: the plugin's MCP server.
//
// Codex starts this (plugin/.mcp.json) for each session, over stdio. It serves the six
// tools; each call says, in `_meta.threadId`, which Codex session it is from, and a
// watch belongs to that session. The Events client (polyfills/events/core) connects
// to the MCP servers in Codex's configuration, runs the watches, and stores every
// event; then `codex queue --resume` hands the session a message saying what is new,
// which wakes it if it is idle.
//
// It ends when Codex closes its standard input (the session was closed or unloaded).

import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventsConnection, preStandardPolicy } from '../../core/src/events-client.ts';
import { oneLine } from '../../core/src/format.ts';
import { configureHost } from '../../core/src/host.ts';
import { readRelaySettings } from '../../core/src/relay.ts';
import { pruneSessions } from '../../core/src/store.ts';
import type { Unavailable } from '../../core/src/tools.ts';
import { describeError, secrets } from '../../core/src/untrusted.ts';
import { isHttp } from '../../core/src/upstream.ts';
import { codexHome, readCodexServers } from './codex-config.ts';
import { serve } from './mcp-server.ts';
import { isThePersons, threadOf } from './meta.ts';
import { ThreadSession } from './threads.ts';
import { VERSION } from './version.ts';
import { findCodex, queueMessage, THREAD_ID, type Wake } from './waker.ts';
import { CODEX, INSTRUCTIONS, SERVER_NAME, TOOLS } from './words.ts';

configureHost(CODEX);
const env = process.env;
const off = env.MCP_EVENTS_OFF === '1';
const base = env.MCP_EVENTS_STATE || join(codexHome(env), 'mcp-events');
mkdirSync(base, { recursive: true, mode: 0o700 });

// The log is for the user: private to them, kept to a few megabytes, and with known secrets taken out.
const logFile = join(base, 'mcp-events.log');
try {
    if (existsSync(logFile) && statSync(logFile).size > 2 * 1024 * 1024) renameSync(logFile, logFile + '.1');
    if (!existsSync(logFile)) writeFileSync(logFile, '', { mode: 0o600 });
    chmodSync(logFile, 0o600);
} catch {
    // logging is best effort
}
let logged = 0;
const log = (s: string) => {
    try {
        if (++logged % 200 === 0 && statSync(logFile).size > 2 * 1024 * 1024) {
            renameSync(logFile, logFile + '.1');
            writeFileSync(logFile, '', { mode: 0o600 });
        }
        appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${oneLine(secrets.scrub(s), 600)}\n`);
    } catch {
        // state dir not ready
    }
};
process.on('unhandledRejection', (e) => log(`unexpected failure (${describeError(e)})`));
log(`mcp-events ${VERSION} for Codex started${off ? ' (MCP_EVENTS_OFF=1: doing nothing)' : ''}`);

// ---- Which servers ----

const table = off ? { servers: {}, skipped: {} } : readCodexServers(env, log);
secrets.add(env.MCP_EVENTS_RELAY_ACCESS_KEY, readRelaySettings(env)?.accessKey);
for (const cfg of Object.values(table.servers)) {
    if (isHttp(cfg)) {
        secrets.add(...Object.values(cfg.headers ?? {}));
        try {
            const u = new URL(cfg.url);
            secrets.add(u.password, u.username, ...[...u.searchParams.values()]);
        } catch {
            // not an address: it will fail to connect
        }
    } else secrets.add(...Object.values(cfg.env ?? {}));
}
const unavailable: Unavailable[] = Object.entries(table.skipped).map(([name, why]) => ({ name, why }));
const connections = new Map<string, EventsConnection>();
const preStandard = preStandardPolicy(env.MCP_EVENTS_PRE_STANDARD);
const timeout = Number(env.MCP_EVENTS_CONNECT_TIMEOUT_MS ?? 10000);

// A server that turned out not to offer events is not connected to again in every session (for a
// local server that means starting it a second time): the answer is kept for a day, by how the
// server is reached. A server a saved watch names is always asked.
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
/** Servers named by a saved watch of any session: never skipped as "known without events". */
const watchedServers = (): Set<string> => {
    const out = new Set<string>();
    try {
        for (const id of readdirSync(join(base, 'threads'))) {
            try {
                const j = JSON.parse(readFileSync(join(base, 'threads', id, 'watches.json'), 'utf8')) as { watches?: { server?: unknown }[] };
                for (const w of j.watches ?? []) if (typeof w.server === 'string') out.add(w.server);
            } catch {
                // no watches there
            }
        }
    } catch {
        // no threads yet
    }
    return out;
};

let discovery: Promise<void> | undefined;
/** Connects to each configured server once, the first time a tool is called, and keeps those that offer events. */
const discover = (): Promise<void> =>
    (discovery ??= (async () => {
        const watched = watchedServers();
        await Promise.all(
            Object.entries(table.servers).map(async ([name, cfg]) => {
                const c = new EventsConnection(name, cfg, { preStandard: preStandard(name) });
                c.log = log;
                if (!watched.has(name) && typeof without[c.fingerprint] === 'number' && Date.now() - without[c.fingerprint]! < PROBE_TTL_MS) return;
                try {
                    await c.connect(timeout);
                } catch {
                    if (c.needsSignIn) unavailable.push({ name, why: c.error ?? 'needs sign-in' });
                    log(`${name}: not connected: ${c.error}`);
                    return;
                }
                if (!c.declaration) {
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
                    connections.set(name, c);
                    log(`${name}: ${c.eventTypes.length} event type(s) (protocol revision ${c.revision}${c.declaration === 'pre-standard' ? '; it advertises events in the form from before the standard' : ''})`);
                } catch (e) {
                    unavailable.push({ name, why: `events/list failed: ${describeError(e)}` });
                    await c.close();
                }
            })
        );
    })());

// ---- Sessions ----

const codex = findCodex(env);
if (!off && !codex) log('no `codex` found on PATH or where its installers put it; events are stored but cannot wake a session (set MCP_EVENTS_CODEX_BIN)');
const wake: Wake = async (thread, text) => {
    if (!codex) return { ok: false, why: 'no `codex` command was found to run `codex queue` with (set MCP_EVENTS_CODEX_BIN to its full path)' };
    return queueMessage(codex, thread, text, env);
};

const sessions = new Map<string, ThreadSession>();
const sessionFor = (id: string): ThreadSession => {
    let s = sessions.get(id);
    if (!s) {
        s = new ThreadSession(id, { base, connections, unavailable: () => unavailable, wake, log, env, connectTimeoutMs: timeout });
        sessions.set(id, s);
        s.start();
    }
    return s;
};

const names = new Set(TOOLS.map((t) => t.name));
const server = serve({
    name: SERVER_NAME,
    title: 'MCP Events',
    version: VERSION,
    instructions: off ? 'mcp-events is installed but turned off (MCP_EVENTS_OFF=1).' : INSTRUCTIONS,
    tools: () => (off ? [] : TOOLS),
    log,
    onClose: () => void stop(),
    async call(name, args, meta) {
        if (off || !names.has(name)) return { text: 'mcp-events has no tool by that name.', isError: true };
        const thread = threadOf(meta);
        const trigger = (meta['x-codex-turn-metadata'] as { turn_trigger?: unknown } | undefined)?.turn_trigger;
        log(`${name} from session ${thread?.slice(0, 8) ?? '(none)'} (turn started by ${typeof trigger === 'string' ? oneLine(trigger, 40) : 'unknown'})`);
        if (!thread) return { text: 'mcp-events needs Codex to say which session this call is from (`_meta.threadId` on the call), and this call did not. Codex 0.170 or newer says so.', isError: true };
        // A tool called while the servers are still being looked at waits for them, within reason.
        await Promise.race([discover(), new Promise((r) => setTimeout(r, timeout + 5000).unref())]);
        const s = sessionFor(thread);
        if (!s.manager.owner) s.start();
        if (isThePersons(meta)) s.spoke();
        return s.call(name, args);
    }
});

// Saved sessions that ended long ago have nobody left to read their events.
try {
    const gone = pruneSessions(base, '');
    if (gone) log(`removed the stored events of ${gone} session(s) not heard from in two weeks`);
    const root = join(base, 'threads');
    for (const id of existsSync(root) ? readdirSync(root) : []) {
        if (!THREAD_ID.test(id)) continue;
        const dir = join(root, id);
        const watches = join(dir, 'watches.json');
        let any = false;
        try {
            any = ((JSON.parse(readFileSync(watches, 'utf8')) as { watches?: unknown[] }).watches ?? []).length > 0;
        } catch {
            // none saved
        }
        if (!any && Date.now() - statSync(dir).mtimeMs > 14 * 24 * 3600 * 1000) rmSync(dir, { recursive: true, force: true });
    }
} catch {
    // best effort
}

// A second process with the same session open (a second window) leaves the watches to the first;
// if the first goes, this one takes them over.
const parent = process.ppid;
const tick = setInterval(() => {
    // Orphaned: whoever started this is gone, and stdin may not say so.
    if (process.ppid !== parent) return void stop();
    for (const s of sessions.values()) {
        if (!s.manager.owner && s.start()) log(`[${s.id.slice(0, 8)}] the process that ran this session's watches has gone; this one runs them now`);
    }
}, 5000);
tick.unref();

let stopping = false;
async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearInterval(tick);
    server.close();
    // Whatever happens below, this process ends.
    setTimeout(() => process.exit(0), 8000).unref();
    await Promise.all([...sessions.values()].map((s) => s.stop().catch(() => {})));
    await Promise.all([...connections.values()].map((c) => c.close().catch(() => {})));
    log('stopped');
    process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGHUP', () => void stop());
process.on('SIGINT', () => void stop());
