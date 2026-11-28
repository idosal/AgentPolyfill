#!/usr/bin/env node
// mcp-events for Hermes: the helper the plugin starts.
//
// The plugin (plugin/__init__.py, Python, inside the Hermes gateway) starts this once and
// talks to it over standard input and output (bridge.ts). It sends `initialize` with the MCP
// servers this plugin may use, as Hermes's own configuration describes them, then one `call`
// per tool call, naming the Hermes session the call is from. The Events client
// (polyfills/events/core) connects to those servers, runs the watches by webhook, push or poll, and
// stores every event; then the helper asks the plugin to `wake` the session, and the plugin
// hands Hermes the message with ctx.inject_message.
//
// It ends when the plugin closes its standard input (the gateway stopped or unloaded it).

import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventsConnection, preStandardPolicy } from '../../core/src/events-client.ts';
import { oneLine } from '../../core/src/format.ts';
import { configureHost } from '../../core/src/host.ts';
import { pruneSessions } from '../../core/src/store.ts';
import type { Unavailable } from '../../core/src/tools.ts';
import { describeError, secrets } from '../../core/src/untrusted.ts';
import { isHttp, type UpstreamConfig } from '../../core/src/upstream.ts';
import { Bridge, RpcError } from '../../../../tools/hermes/shared/bridge.ts';
import { HermesSession, savedKey, sessionId, watchesDir, type WakeResult } from './session.ts';
import { VERSION } from './version.ts';
import { HERMES, TOOLS } from './words.ts';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

configureHost(HERMES);

const env = { ...process.env };

let base = '';
let logFile = '';
let logged = 0;
const log = (s: string) => {
    if (!logFile) return;
    try {
        if (++logged % 200 === 0 && statSync(logFile).size > 2 * 1024 * 1024) {
            renameSync(logFile, logFile + '.1');
            writeFileSync(logFile, '', { mode: 0o600 });
        }
        appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${oneLine(secrets.scrub(s), 600)}\n`);
    } catch {
        // logging is best effort
    }
};
process.on('unhandledRejection', (e) => log(`unexpected failure (${describeError(e)})`));

const connections = new Map<string, EventsConnection>();
const unavailable: Unavailable[] = [];
let servers: Record<string, UpstreamConfig> = {};
const timeout = Number(env.MCP_EVENTS_CONNECT_TIMEOUT_MS ?? 10000);
const preStandard = preStandardPolicy(env.MCP_EVENTS_PRE_STANDARD);

let discovery: Promise<void> | undefined;
/** Connects to each server once, the first time it is needed, and keeps those that offer events. */
const discover = (): Promise<void> =>
    (discovery ??= (async () => {
        await Promise.all(
            Object.entries(servers).map(async ([name, cfg]) => {
                const c = new EventsConnection(name, cfg, { preStandard: preStandard(name) });
                c.log = log;
                try {
                    await c.connect(timeout);
                } catch {
                    unavailable.push({ name, why: c.needsSignIn ? (c.error ?? 'needs sign-in') : `could not connect (${c.error ?? 'no answer'})` });
                    log(`${name}: not connected: ${c.error}`);
                    return;
                }
                if (!c.declaration) {
                    const why = c.outsideTheSpec;
                    if (why) {
                        unavailable.push({ name, why });
                        log(`${name}: ${why}`);
                    } else log(`${name}: does not offer events`);
                    await c.close();
                    return;
                }
                try {
                    await c.list();
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

let bridge: Bridge;
const wake = async (key: string, text: string): Promise<WakeResult> => {
    try {
        const r = (await bridge.request('wake', { session: key, text }, 30000)) as { ok?: unknown; why?: unknown } | null;
        if (r && r.ok === true) return { ok: true };
        return { ok: false, why: typeof r?.why === 'string' ? oneLine(r.why, 300) : 'Hermes did not take the message' };
    } catch (e) {
        // No answer: the plugin may have handed it to Hermes before it went quiet.
        return { ok: false, why: e instanceof Error ? e.message : String(e), maybe: true };
    }
};

const sessions = new Map<string, HermesSession>();
const withdrawn = new Set<string>();
const startingWatches = new Map<Promise<unknown>, string>();
let restoring: Promise<void> | undefined;
const sessionFor = (key: string): HermesSession => {
    let s = sessions.get(key);
    if (!s) {
        s = new HermesSession(key, { base, connections, unavailable: () => unavailable, wake, log, env, connectTimeoutMs: timeout });
        sessions.set(key, s);
        s.start();
    }
    return s;
};

/** Sessions that saved watches before the gateway last stopped: started again, so their watches run with nobody typing. */
async function resumeSaved(): Promise<void> {
    const root = join(base, 'watch-sessions');
    let ids: string[] = [];
    try {
        ids = readdirSync(root);
    } catch {
        return;
    }
    const keys: string[] = [];
    for (const id of ids) {
        const key = savedKey(base, id);
        if (!key) continue;
        // A session folder with watches saved: watches.json holds at least one.
        let any = false;
        try {
            any = ((JSON.parse(readFileSync(join(watchesDir(base, id), 'watches.json'), 'utf8')) as { watches?: unknown[] }).watches ?? []).length > 0;
        } catch {
            any = false;
        }
        if (any) keys.push(key);
        else {
            try {
                if (Date.now() - statSync(watchesDir(base, id)).mtimeMs > 14 * 24 * 3600 * 1000) rmSync(watchesDir(base, id), { recursive: true, force: true });
            } catch {
                // best effort
            }
        }
    }
    if (!keys.length) return;
    await discover();
    for (const key of keys) {
        sessionFor(key);
        log(`[${sessionId(key).slice(1, 9)}] saved watches resumed`);
    }
}

const names = new Set(TOOLS.map((t) => t.name));

async function handle(method: string, params: Json): Promise<unknown> {
    switch (method) {
        case 'initialize': {
            if (base) throw new RpcError(-32600, 'already initialized');
            if (typeof params.state !== 'string' || !params.state) throw new RpcError(-32602, 'initialize needs `state`, a folder');
            base = params.state;
            // Only a relay selected for this gateway or profile may receive its events.
            if (!env.MCP_EVENTS_RELAY_FILE) env.MCP_EVENTS_RELAY_FILE = join(base, 'relay.json');
            mkdirSync(base, { recursive: true, mode: 0o700 });
            logFile = join(base, 'mcp-events.log');
            try {
                if (existsSync(logFile) && statSync(logFile).size > 2 * 1024 * 1024) renameSync(logFile, logFile + '.1');
                if (!existsSync(logFile)) writeFileSync(logFile, '', { mode: 0o600 });
                chmodSync(logFile, 0o600);
            } catch {
                // best effort
            }
            servers = {};
            const table = isObject(params.servers) ? params.servers : {};
            for (const [name, cfg] of Object.entries(table)) {
                if (!isObject(cfg)) continue;
                const c = cfg as UpstreamConfig;
                if (isHttp(c)) {
                    secrets.add(...Object.values(c.headers ?? {}));
                    try {
                        const u = new URL(c.url);
                        secrets.add(u.password, u.username, ...[...u.searchParams.values()]);
                    } catch {
                        // not an address: it will fail to connect
                    }
                } else secrets.add(...Object.values((c as { env?: Record<string, string> }).env ?? {}));
                servers[name] = c;
            }
            if (isObject(params.skipped)) for (const [name, why] of Object.entries(params.skipped)) if (typeof why === 'string') unavailable.push({ name, why });
            log(`mcp-events ${VERSION} for Hermes started, ${Object.keys(servers).length} server(s) to look at${unavailable.length ? `, ${unavailable.length} left alone` : ''}`);
            try {
                const gone = pruneSessions(base, '');
                if (gone) log(`removed the stored events of ${gone} session(s) not heard from in two weeks`);
            } catch {
                // best effort
            }
            restoring = resumeSaved().catch((e) => log(`resuming saved watches failed: ${describeError(e)}`));
            return { version: VERSION };
        }
        case 'call': {
            if (!base) throw new RpcError(-32002, 'not initialized');
            const name = typeof params.name === 'string' ? params.name : '';
            const key = typeof params.session === 'string' ? params.session : '';
            const args = isObject(params.arguments) ? params.arguments : {};
            if (!names.has(name)) return { text: 'mcp-events has no tool by that name.', isError: true };
            if (!key) return { text: 'mcp-events needs to know which Hermes session this call is from, and Hermes did not say. Watches belong to a session, so none can be set from here.', isError: true };
            log(`${name} from session ${sessionId(key).slice(1, 9)}`);
            await Promise.race([discover(), new Promise((r) => setTimeout(r, timeout + 5000).unref())]);
            const server = name === 'watch_event' && typeof args.server === 'string' ? args.server : undefined;
            if (server !== undefined && withdrawn.has(server)) return { text: 'This server is no longer available to the plugin.', isError: true };
            const s = sessionFor(key);
            if (!s.manager.owner) s.start();
            const call = s.call(name, args);
            if (server !== undefined) startingWatches.set(call, server);
            try {
                const answer = await call;
                return { text: answer.text, isError: answer.isError === true };
            } finally {
                startingWatches.delete(call);
            }
        }
        case 'spoke': {
            const key = typeof params.session === 'string' ? params.session : '';
            // Only a session this helper already serves: the person writing elsewhere starts nothing.
            const s = key ? sessions.get(key) : undefined;
            if (s) s.spoke();
            return { known: !!s };
        }
        case 'suspend': {
            const names = params.servers;
            if (!Array.isArray(names) || !names.every((s) => typeof s === 'string')) throw new RpcError(-32602, 'suspend needs server names');
            for (const name of names) withdrawn.add(name);
            // Include watches still opening a relay or being restored from disk in the cleanup.
            await restoring;
            await Promise.allSettled([...startingWatches].filter(([, server]) => withdrawn.has(server)).map(([call]) => call));
            await Promise.all([...sessions.values()].flatMap((session) => names.map((server) => session.manager.suspend(server))));
            return {};
        }
        case 'shutdown':
            setImmediate(() => void stop());
            return {};
        default:
            throw new RpcError(-32601, `no method ${method}`);
    }
}

bridge = new Bridge(handle, process.stdin, process.stdout, log);
bridge.onClose = () => void stop();

// Orphaned: whoever started this is gone, and stdin may not say so.
const parent = process.ppid;
const tick = setInterval(() => {
    if (process.ppid !== parent) void stop();
}, 5000);
tick.unref();

let stopping = false;
async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearInterval(tick);
    setTimeout(() => process.exit(0), 8000).unref();
    await Promise.all([...sessions.values()].map((s) => s.stop().catch(() => {})));
    await Promise.all([...connections.values()].map((c) => c.close().catch(() => {})));
    log('stopped');
    process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGHUP', () => void stop());
process.on('SIGINT', () => void stop());
