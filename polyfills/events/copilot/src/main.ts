// mcp-events for Copilot: the extension.
//
// Copilot CLI starts it (plugin/extensions/mcp-events/extension.mjs) as a child process for the
// session in the foreground, and it joins that session with joinSession(): it adds the six tools,
// gives the session its instructions when it starts, and listens to the session's messages. The
// Events client (polyfills/events/core) connects to the MCP servers Copilot uses, runs the watches
// and stores every event; then `session.send` hands the session a message saying what is new,
// which wakes it if it is idle. One process serves one session; Copilot stops it (SIGTERM) when
// the session ends or is replaced.
//
// The watches, their delivery and the wake gate are the Codex form's ThreadSession, unchanged:
// only the wake (session.send instead of `codex queue`) and what counts as the person writing (a
// `user.message` with no automation source, instead of a tool call's turn metadata) differ.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventsConnection, preStandardPolicy } from '../../core/src/events-client.ts';
import { oneLine } from '../../core/src/format.ts';
import { configureHost } from '../../core/src/host.ts';
import { readRelaySettings } from '../../core/src/relay.ts';
import { pruneSessions } from '../../core/src/store.ts';
import type { Unavailable } from '../../core/src/tools.ts';
import { describeError, secrets } from '../../core/src/untrusted.ts';
import { isHttp } from '../../core/src/upstream.ts';
import { ThreadSession } from '../../codex/src/threads.ts';
import { THREAD_ID } from '../../codex/src/waker.ts';
import { copilotHome, readCopilotServers, type Configured } from './copilot-config.ts';
import { VERSION } from './version.ts';
import { isThePersons, sendWake, type Sender } from './waker.ts';
import { COPILOT, INSTRUCTIONS, TOOLS } from './words.ts';

type Json = Record<string, unknown>;

/** The part of the SDK's `joinSession` (`@github/copilot-sdk/extension`) this uses. */
export type JoinedSession = Sender & {
    sessionId: string;
    on(type: string, handler: (event: { type: string; data?: Json; agentId?: unknown }) => void): () => void;
    rpc?: { mcp?: { listConfigured?: () => Promise<{ servers: Configured[] }> } };
};
export type ToolResult = string | { textResultForLlm: string; resultType: 'success' | 'failure' };
// The forms every Copilot release with extensions takes: a `tools` array and the hooks by name.
// Newer SDKs migrate both to their grouped forms (`tools.definitions`, `hooks.handlers`); an
// older one knows only these.
export type JoinSession = (config: {
    tools?: { name: string; description: string; parameters: Json; skipPermission?: boolean; handler: (args: Json) => Promise<ToolResult> }[];
    hooks?: { onSessionStart?: (input: Json) => Promise<{ additionalContext?: string } | void> };
}) => Promise<JoinedSession>;

export async function start(joinSession: JoinSession, env: NodeJS.ProcessEnv = process.env): Promise<{ stop: () => Promise<void> }> {
    configureHost(COPILOT);
    const off = env.MCP_EVENTS_OFF === '1';
    const base = env.MCP_EVENTS_STATE || join(copilotHome(env), 'mcp-events');
    mkdirSync(base, { recursive: true, mode: 0o700 });

    // The log is for the user: private to them, kept to a few megabytes, and with known secrets taken out.
    // Never stdout: that is the extension's channel to Copilot.
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
    // An error nobody caught leaves the process in a state nobody planned for (its channel to Copilot
    // may be gone): it is logged, the watches are stopped within a bound, and the process ends.
    // Events are on disk before they are acknowledged, and pick up from their cursors next time.
    process.on('uncaughtException', (e) => {
        log(`unexpected error (${describeError(e)}); stopping`);
        process.exitCode = 1;
        void stop().finally(() => process.exit(1));
    });
    // Standard output is the extension's JSON-RPC channel to Copilot: a stray line there (Node's
    // console.log, info and debug write to it, and a bundled library may call them) would corrupt
    // it. They go to the log instead.
    for (const k of ['log', 'info', 'debug', 'trace'] as const) console[k] = (...a: unknown[]) => log(`console.${k}: ${a.map((x) => (typeof x === 'string' ? x : describeError(x))).join(' ')}`);
    log(`mcp-events ${VERSION} for Copilot started${off ? ' (MCP_EVENTS_OFF=1: doing nothing)' : ''}`);

    // Stand-down (contract rule 4): Copilot gives an extension no way to see what its own MCP client
    // declares, so native Events cannot be detected yet. MCP_EVENTS_OFF=1 joins with nothing.
    if (off) {
        await joinSession({}).catch(() => process.exit(0));
        return { stop: async () => {} };
    }

    let ready: () => void = () => {};
    const joined = new Promise<void>((r) => (ready = r));
    let s: ThreadSession | undefined;
    let session: JoinedSession | undefined;
    const names = new Set(TOOLS.map((t) => t.name));

    const connections = new Map<string, EventsConnection>();
    const unavailable: Unavailable[] = [];
    const preStandard = preStandardPolicy(env.MCP_EVENTS_PRE_STANDARD);
    const timeout = Number(env.MCP_EVENTS_CONNECT_TIMEOUT_MS ?? 10000);

    // A server that turned out not to offer events is not connected to again in every session (for a
    // local server that means starting it a second time): the answer is kept for a day, by how the
    // server is reached. A server a saved watch of this session names is always asked.
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
    const savedWatches = (id: string): { server?: unknown }[] => {
        try {
            return (JSON.parse(readFileSync(join(base, 'threads', id, 'watches.json'), 'utf8')) as { watches?: { server?: unknown }[] }).watches ?? [];
        } catch {
            return [];
        }
    };

    let discovery: Promise<void> | undefined;
    let discovered = false;
    /** Connects to each server Copilot uses once, and keeps those that offer events. */
    const discover = (id: string): Promise<void> =>
        (discovery ??= (async () => {
            let configured: Configured[] | undefined;
            try {
                configured = (await session?.rpc?.mcp?.listConfigured?.())?.servers;
            } catch (e) {
                log(`Copilot did not list its MCP servers (${describeError(e)}); reading its files instead`);
            }
            const table = readCopilotServers(env, log, { cwd: process.cwd(), configured });
            for (const [name, why] of Object.entries(table.skipped)) unavailable.push({ name, why });
            secrets.add(env.MCP_EVENTS_RELAY_ACCESS_KEY, readRelaySettings(env)?.accessKey, ...table.expanded);
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
            const watched = new Set(savedWatches(id).map((w) => w.server).filter((n): n is string => typeof n === 'string'));
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
            discovered = true;
            // What Copilot allows may have changed while the servers were being looked at (a server
            // switched off meanwhile): checked afresh before any saved watch starts.
            await revoke();
            // Watches loaded before their server's connection was there (a session resumed while the
            // servers were still being looked at) start now.
            for (const name of connections.keys()) s?.manager.resume(name);
        })());

    /**
     * Copilot is the judge of which servers this session may use. A server it stops using while the
     * session runs (`/mcp disable`, or gone after `/mcp reload`) is let go here too: its watches stop
     * and wait, saved, and its connection is closed. Checked when Copilot says a server's state
     * changed, every half minute, and before each tool call. A server Copilot takes back up is used
     * again from the next session.
     */
    // Lets go of every server Copilot no longer lists as enabled: its watches stop (their webhook
    // subscriptions ended, over the connection, which is kept until then), and only then is the
    // connection removed and closed.
    const revoke = async (): Promise<void> => {
        if (env.MCP_EVENTS_CONFIG || !connections.size) return;
        let listed: Configured[] | undefined;
        try {
            listed = (await session?.rpc?.mcp?.listConfigured?.())?.servers;
        } catch {
            return; // Copilot could not say: nothing is changed on a guess
        }
        if (!listed) return;
        const enabled = new Set(listed.filter((c) => c.enabled).map((c) => c.name));
        for (const [name, c] of [...connections]) {
            if (enabled.has(name)) continue;
            log(`${name}: Copilot no longer uses it in this session; its watches stop and wait until a session has it again`);
            await s?.manager.suspend(name).catch(() => {});
            connections.delete(name);
            await c.close().catch(() => {});
            unavailable.push({ name, why: 'Copilot stopped using it in this session (switched off or removed); its watches wait, saved, until a session has it again' });
        }
    };
    let reconciling: Promise<void> | undefined;
    // After discovery only: during discovery, discovery itself checks afresh before any watch starts.
    const reconcile = (): Promise<void> => (discovered ? (reconciling ??= revoke().finally(() => (reconciling = undefined))) : Promise.resolve());

    const sessionFor = (id: string): ThreadSession => {
        if (!s) {
            s = new ThreadSession(id, {
                base,
                connections,
                unavailable: () => unavailable,
                wake: async (_thread, text) => (session ? sendWake(session, text, Number(env.MCP_EVENTS_SEND_TIMEOUT_MS ?? 60000)) : { ok: false, why: 'not joined to the session yet' }),
                log,
                env,
                connectTimeoutMs: timeout,
                label: 'copilot session',
                wakeName: 'session.send'
            });
            s.start();
        }
        return s;
    };

    const toResult = (a: { text: string; isError?: true }): ToolResult => (a.isError ? { textResultForLlm: a.text, resultType: 'failure' } : a.text);

    // Copilot may refuse the join (VS Code's harness pre-warms sessions and discards some before
    // they are used: seen live, error -32603). Then there is no session to serve: said once, and
    // this process ends without fuss.
    const joinOrEnd = (config: Parameters<JoinSession>[0]) =>
        joinSession(config).catch((e: unknown) => {
            log(`Copilot did not let this extension join the session (${describeError(e)}); nothing to do`);
            process.exit(0);
        });
    session = await joinOrEnd({
        tools: TOOLS.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
                ...(t.reads ? { skipPermission: true } : {}),
                handler: async (args: Json) => {
                    await joined;
                    const id = sessionId();
                    if (!names.has(t.name) || !id) return toResult({ text: 'mcp-events could not tell which Copilot session this is.', isError: true });
                    log(`${t.name} from session ${id.slice(0, 8)}`);
                    // A tool called while the servers are still being looked at waits for them: each
                    // connection has its own time limit, so this ends. The session's watches start
                    // only once every connection there will be is there.
                    await discover(id);
                    await reconcile();
                    const ts = sessionFor(id);
                    if (!ts.manager.owner) ts.start();
                    // The model's arguments: only a plain object is read; the tools check each field.
                    const input = typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {};
                    try {
                        return toResult(await ts.call(t.name, input));
                    } catch (e) {
                        log(`${t.name} failed (${describeError(e)})`);
                        return toResult({ text: `${t.name} failed (${describeError(e)}).`, isError: true });
                    }
                }
            })),
        hooks: {
            onSessionStart: async () => ({ additionalContext: INSTRUCTIONS })
        }
    });
    const sessionId = () => {
        const id = env.SESSION_ID || session?.sessionId;
        return id && THREAD_ID.test(id) ? id.toLowerCase() : undefined;
    };
    ready();
    log(`joined session ${sessionId()?.slice(0, 8) ?? '(no id)'}`);

    // The person writing to the session: if waking had stopped at its hourly limit, it starts again.
    session.on('user.message', (e) => {
        if (isThePersons(e.data, e.agentId)) s?.spoke();
    });
    session.on('session.mcp_server_status_changed', () => void reconcile().catch(() => {}));

    // A session resumed with saved watches picks them up at once, from their cursors.
    const id = sessionId();
    if (id && savedWatches(id).length) {
        void discover(id).then(() => {
            sessionFor(id);
            log(`resumed this session's ${savedWatches(id).length} watch(es)`);
        });
    }

    // Saved sessions that ended long ago have nobody left to read their events.
    try {
        const gone = pruneSessions(base, '');
        if (gone) log(`removed the stored events of ${gone} session(s) not heard from in two weeks`);
    } catch {
        // best effort
    }

    // A second process with the same session open (the session resumed in a second terminal) leaves
    // the watches to the first; if the first goes, this one takes them over.
    const parent = Number(env.COPILOT_EXTENSION_PARENT_PID) || process.ppid;
    let ticks = 0;
    const tick = setInterval(() => {
        try {
            // Orphaned: the Copilot that started this is gone, and nobody will send SIGTERM.
            if (!alive(parent)) return void stop().then(() => process.exit(0));
            if (s && !s.manager.owner && s.start()) log(`[${s.id.slice(0, 8)}] the process that ran this session's watches has gone; this one runs them now`);
            if (++ticks % 6 === 0) void reconcile().catch(() => {});
        } catch (e) {
            // A file the claim needs could not be read or written: tried again at the next tick.
            log(`the watches' claim could not be checked (${describeError(e)}); trying again`);
        }
    }, 5000);
    tick.unref();

    let stopping = false;
    async function stop(): Promise<void> {
        if (stopping) return;
        stopping = true;
        clearInterval(tick);
        // Whatever happens below, this process ends within Copilot's grace period.
        setTimeout(() => process.exit(0), 4000).unref();
        await s?.stop().catch(() => {});
        await Promise.all([...connections.values()].map((c) => c.close().catch(() => {})));
        log('stopped');
    }
    return { stop };
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}
