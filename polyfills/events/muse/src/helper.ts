#!/usr/bin/env node
// mcp-events for Muse Code: the plugin's MCP server.
//
// Muse starts this (the plugin's .muse-plugin/plugin.json) once per session, over stdio, with the
// session's id in MUSE_SESSION_ID. It serves the same six tools as the Codex form, and reuses that
// form's code unchanged (../../codex/src: the tools, the per-session watches, the MCP server loop)
// with the Events client every form shares (../../core). What differs in Muse is here and in
// muse.ts: Muse's settings and server list, a watch's yes typed by the person (muse-confirm.ts), and
// delivery at the person's next message through the plugin's UserPromptSubmit hook
// (muse-prompt-hook.ts), or, as an experimental opt-in, a turn started through `muse attach`.
//
// It ends when Muse closes its standard input.

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
import { serve } from '../../codex/src/mcp-server.ts';
import { ThreadSession, type ThreadOptions } from '../../codex/src/threads.ts';
import { THREAD_ID, type Wake } from '../../codex/src/waker.ts';
import { SERVER_NAME, TOOLS } from '../../codex/src/words.ts';
import { askTyped } from './muse-confirm.ts';
import { applyPluginSettings, attachTurn, findMuseFor, MUSE, MUSE_INSTRUCTIONS, museManaged, museSession, museStateDir, museUnwatchQuestion, museWatchQuestion, putInbox, readMuseServers, spokeAt, unshowable, unwatchPendingText, wakeMode, watchPendingText } from './muse.ts';
import { VERSION } from './version.ts';

configureHost(MUSE);
const env = process.env;
const base = museStateDir(env);
mkdirSync(base, { recursive: true, mode: 0o700 });
// Muse passes a plugin's server no variables of the person's: the settings come from a file.
const fromFile = applyPluginSettings(env, base);
const off = env.MCP_EVENTS_OFF === '1';

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
log(`mcp-events ${VERSION} for Muse started${off ? ' (MCP_EVENTS_OFF=1: doing nothing)' : ''}`);
if (fromFile.applied.length) log(`settings from ${join(base, 'settings.json')}: ${fromFile.applied.join(', ')}`);
if ('error' in fromFile && fromFile.error) log(fromFile.error);

// ---- Which servers ----

// An organisation's Muse policy (muse config status) means no server is reached, as a managed Codex policy does.
const museCommand = findMuseFor(env);
const managed = off ? undefined : museManaged(museCommand, env);
const table = off ? { servers: {}, skipped: {} } : readMuseServers(env, log, managed);
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

// ---- The session, and how a batch reaches it ----

const museSessionId = museSession(env);
const museMode = wakeMode(env);
const museBin = museMode === 'attach' ? museCommand : undefined;
log(`Muse session ${museSessionId?.slice(0, 8) ?? '(none: MUSE_SESSION_ID is not set)'}; new events ${museMode === 'attach' ? (museBin ? `start a turn through ${museBin} attach (experimental), or wait for the next message` : 'wait for the next message (MCP_EVENTS_MUSE_WAKE=attach, but no muse command was found)') : 'wait for the next message'}`);
let attachRestUntil = 0;
const wake: Wake = async (session, text) => {
    if (museBin && Date.now() >= attachRestUntil) {
        const r = await attachTurn(museBin, session, text, { env });
        if (r.ok || r.maybe) return r;
        // Not tried again for a while: a session that can't be attached to stays so until Muse restarts.
        attachRestUntil = Date.now() + 5 * 60000;
        log(`[${session.slice(0, 8)}] waking through muse attach failed (${r.why}); the events wait for the next message`);
    }
    try {
        putInbox(base, session, text);
        return { ok: true, resumed: true };
    } catch (e) {
        return { ok: false, why: `the session's inbox could not be written (${describeError(e)})` };
    }
};
// By default the events are stored here and handed over by the plugin's UserPromptSubmit hook,
// which reads the store past the last hand-over: this process hands nothing over itself.
const deliver = museMode === 'attach';

/** The Codex form's session, which in inbox mode stores events and never hands them over. */
class MuseSession extends ThreadSession {
    override announce(afterMs?: number): void {
        if (deliver) super.announce(afterMs);
    }
}

const sessions = new Map<string, ThreadSession>();
const sessionFor = (id: string): ThreadSession => {
    let s = sessions.get(id);
    if (!s) {
        const o: ThreadOptions = { base, connections, unavailable: () => unavailable, wake, log, env, connectTimeoutMs: timeout };
        s = new MuseSession(id, o);
        sessions.set(id, s);
        s.start();
    }
    return s;
};

const names = new Set(TOOLS.map((t) => t.name));
// The Codex form's tools, named for Muse.
const tools = TOOLS.map((t) => ({ ...t, description: t.description.replaceAll('Codex', 'Muse') }));
const server = serve({
    name: SERVER_NAME,
    title: 'MCP Events',
    version: VERSION,
    instructions: off ? 'mcp-events is installed but turned off (MCP_EVENTS_OFF=1 in its settings.json).' : MUSE_INSTRUCTIONS,
    tools: () => (off ? [] : tools),
    log,
    onClose: () => void stop(),
    async call(name, args) {
        if (off || !names.has(name)) return { text: 'mcp-events has no tool by that name.', isError: true };
        const thread = museSessionId;
        log(`${name} from session ${thread?.slice(0, 8) ?? '(none)'}`);
        if (!thread) return { text: 'mcp-events needs Muse to say which session this is (MUSE_SESSION_ID in its environment), and it did not. Muse 1.4.25 or newer says so.', isError: true };
        // A tool called while the servers are still being looked at waits for them, within reason.
        await Promise.race([discover(), new Promise((r) => setTimeout(r, timeout + 5000).unref())]);
        const s = sessionFor(thread);
        if (!s.manager.owner) s.start();
        // A watch waits for the person's typed yes (muse-confirm.ts): Muse's own approval may be a model's.
        // A server or event type that isn't there is refused here, with nobody asked: nothing unasked reaches add().
        if (name === 'watch_event') {
            const conn = connections.get(String(args.server ?? ''));
            if (!conn) return { text: `The watch is not started: no MCP server by that name offers events. Known: ${[...connections.keys()].join(', ') || 'none'}`, isError: true };
            if (!conn.eventTypes.some((t) => t.name === args.event)) return { text: `The watch is not started: server "${conn.name}" has no event type by that name. It has: ${conn.eventTypes.map((t) => t.name).join(', ')}`, isError: true };
            const asked = { server: String(args.server), event: String(args.event), arguments: args.arguments, note: typeof args.note === 'string' ? args.note : undefined, maxAgeMs: typeof args.maxAgeMs === 'number' ? args.maxAgeMs : undefined };
            const why = unshowable(asked);
            if (why) return { text: `The watch is not started: ${why}.`, isError: true };
            const question = museWatchQuestion(asked, museMode === 'attach' ? s.budget : undefined);
            // The question shows what is sent, or there is no watch.
            if (secrets.scrub(question) !== question) return { text: 'The watch is not started: its filters or note hold a value your MCP configuration keeps secret, which the question to the user would have to hide.', isError: true };
            const typed = askTyped(base, thread, 'watch', question, Date.now(), [asked.server, asked.event]);
            if ('unavailable' in typed) return { text: `The watch is not started: ${typed.unavailable}.`, isError: true };
            if ('pending' in typed) return { text: watchPendingText(question, typed.pending), isError: true };
            log(`[${thread.slice(0, 8)}] the user typed the yes to this watch`);
        }
        // Stopping one waits for a typed yes too, as the OpenCode form asks before a stop; a watch
        // that isn't there is refused by the call itself, with nobody asked.
        const stopping = name === 'unwatch_event' ? s.manager.watches.find((w) => w.id === args.watch) : undefined;
        if (stopping) {
            const question = museUnwatchQuestion({ id: stopping.id, server: stopping.server, event: stopping.event, note: stopping.note });
            const typed = askTyped(base, thread, 'unwatch', question, Date.now(), [stopping.server, stopping.event]);
            if ('unavailable' in typed) return { text: `The watch is not stopped: ${typed.unavailable}.`, isError: true };
            if ('pending' in typed) return { text: unwatchPendingText(question, typed.pending), isError: true };
            log(`[${thread.slice(0, 8)}] the user typed the yes to stopping ${stopping.id}`);
        }
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

// Muse says which session this process serves, so a resumed session's watches start again at once.
if (!off && museSessionId) {
    try {
        const saved = JSON.parse(readFileSync(join(base, 'threads', museSessionId, 'watches.json'), 'utf8')) as { watches?: unknown[] };
        if ((saved.watches ?? []).length) void discover().then(() => void sessionFor(museSessionId));
    } catch {
        // nothing saved for this session
    }
}

// A second process with the same session open leaves the watches to the first; if the first
// goes, this one takes them over.
const parent = process.ppid;
// The hook stamps each message the person sends; that is how waking starts again after a pause.
let lastSpoke = museSessionId ? spokeAt(base, museSessionId) : 0;
const tick = setInterval(() => {
    // Orphaned: whoever started this is gone, and stdin may not say so.
    if (process.ppid !== parent) return void stop();
    for (const s of sessions.values()) {
        if (!s.manager.owner && s.start()) log(`[${s.id.slice(0, 8)}] the process that ran this session's watches has gone; this one runs them now`);
    }
    if (museSessionId) {
        const at = spokeAt(base, museSessionId);
        if (at > lastSpoke) {
            lastSpoke = at;
            sessions.get(museSessionId)?.spoke();
        }
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
