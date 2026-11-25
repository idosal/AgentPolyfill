// mcp-events for Pi: the extension.
//
// Pi loads this file into its own process. It registers the six tools, and
// when a session starts it finds the MCP servers that offer events, over a
// connection of its own to each, built from Pi's MCP configuration
// (pi-config.ts). Watches run in this process for as long as the session is
// open; their events wake the session through `pi.sendMessage` (session.ts).

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { EventsConnection, preStandardPolicy } from '../../core/src/events-client.ts';
import { oneLine } from '../../core/src/format.ts';
import { configureHost } from '../../core/src/host.ts';
import { readRelaySettings } from '../../core/src/relay.ts';
import { pruneSessions } from '../../core/src/store.ts';
import type { Unavailable } from '../../core/src/tools.ts';
import { describeError, secrets } from '../../core/src/untrusted.ts';
import { isHttp, type ServerTable } from '../../core/src/upstream.ts';
import { agentDir, mayUseOAuth, piRunsMcp, readPiServers } from './pi-config.ts';
import { PiSession } from './session.ts';
import { CUSTOM_TYPE, inPisWords, PI, TOOLS, unshowable, VERSION, watchQuestion } from './words.ts';

const SECTION = 'mcp_events';
/** How long the first prompt of a session waits for the servers to be looked at. */
const FIRST_PROMPT_WAIT_MS = 10_000;
/** A server found not to offer events is not connected to again by this extension for a day. */
const PROBE_TTL_MS = 24 * 60 * 60 * 1000;

type Running = {
    session: PiSession;
    connections: Map<string, EventsConnection>;
    unavailable: Unavailable[];
    discovery: Promise<void>;
    abort: AbortController;
    tick: NodeJS.Timeout;
};

export default function mcpEvents(pi: ExtensionAPI): void {
    configureHost(PI);
    const env = process.env;
    // There is no sound way yet to tell that Pi supports Events itself, so this is how to stand it down.
    if (env.MCP_EVENTS_OFF === '1') return;

    const base = env.MCP_EVENTS_STATE || join(agentDir(env), 'mcp-events');
    const logFile = join(base, 'mcp-events.log');
    const log = (s: string) => {
        try {
            if (existsSync(logFile) && statSync(logFile).size > 2 * 1024 * 1024) renameSync(logFile, logFile + '.1');
            appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${oneLine(secrets.scrub(s), 600)}\n`, { mode: 0o600 });
        } catch {
            // logging is best effort
        }
    };
    let running: Running | undefined;
    // Pi's own MCP support is off in this session (--no-mcp, the settings, or an extension that
    // replaces it): Pi reads no mcp.json and connects no server, and neither does this extension.
    let mcpOff = false;
    const MCP_OFF = "Pi's MCP support is off in this session (--no-mcp, `-builtin:mcp` in the settings, or an extension that replaces it), so mcp-events reaches no MCP server, as Pi reaches none.";

    const waitForServers = async (ms: number) => {
        if (!running) return;
        await Promise.race([running.discovery, new Promise((r) => setTimeout(r, ms).unref())]);
    };

    for (const spec of TOOLS) {
        pi.registerTool({
            name: spec.name,
            label: spec.label,
            description: spec.description,
            parameters: spec.parameters as never,
            annotations: spec.annotations,
            async execute(_id, params, signal, _onUpdate, ctx) {
                const text = (t: string, isError?: boolean) => ({ content: [{ type: 'text' as const, text: t }], details: {}, ...(isError ? { isError: true } : {}) });
                if (mcpOff) return text(MCP_OFF, true);
                if (!running) return text('mcp-events has not started in this session yet.', true);
                await waitForServers(FIRST_PROMPT_WAIT_MS + 5000);
                const { session } = running;
                if (!session.manager.owner) session.start();
                const p = (params ?? {}) as Record<string, unknown>;
                if (spec.name === 'watch_event') {
                    // A watch lets a server's events start turns while nobody is there: the person says yes to each one.
                    if (!ctx.hasUI) return text('A watch needs the user to confirm it, and Pi has no one to ask in this mode (print or JSON). Start the watch in an interactive or RPC session.', true);
                    const asked = { server: String(p.server ?? ''), event: String(p.event ?? ''), arguments: p.arguments, note: typeof p.note === 'string' ? p.note : undefined };
                    const why = unshowable(asked);
                    if (why) return text(`The watch is not started: ${why}.`, true);
                    const q = watchQuestion(asked, session.limits);
                    // The question shows what is sent, or there is no watch: one whose filters or note hold
                    // a secret of the configuration can't be shown as it is.
                    if (secrets.scrub(q.message) !== q.message || secrets.scrub(q.title) !== q.title) return text('The watch is not started: its filters or note hold a value your MCP configuration keeps secret, which the question to the user would have to hide.', true);
                    const ok = await ctx.ui.confirm(q.title, q.message, { signal });
                    // A call Pi cancelled while the user was asked starts nothing, whatever the answer.
                    if (signal?.aborted) return text('The call was cancelled, so nothing is watched.', true);
                    if (!ok) {
                        log(`watch of ${oneLine(p.server, 40)}/${oneLine(p.event, 80)} declined by the user`);
                        return text('The user did not confirm the watch, so nothing is watched. Ask them before trying again.', true);
                    }
                }
                const answer = await session.call(spec.name, p);
                const extra = spec.name === 'list_watches' && session.lastWakeError ? `\n\nHanding events to this session failed the last time it was tried; it is tried again.` : '';
                return text(inPisWords(answer.text) + extra, answer.isError);
            }
        });
    }

    pi.on('session_start', (_event, ctx) => {
        if (running || mcpOff) return;
        if (!piRunsMcp(pi.getCommands())) {
            mcpOff = true;
            log('Pi\'s MCP support is off in this session: standing down');
            return;
        }
        mkdirSync(base, { recursive: true, mode: 0o700 });
        try {
            chmodSync(base, 0o700);
        } catch {
            // best effort
        }
        running = start(ctx);
    });

    // The catalog of event types goes into the system prompt, as a section of the extension's own.
    pi.on('before_agent_start', async (event) => {
        if (!running) return;
        await waitForServers(FIRST_PROMPT_WAIT_MS);
        event.systemPromptOptions.sections[SECTION] = running.session.instructions();
    });

    // The person wrote: past the hour's wakes, waking starts again.
    pi.on('input', (event) => {
        if (running && event.source !== 'extension') running.session.spoke();
    });

    pi.on('session_shutdown', async () => {
        const r = running;
        running = undefined;
        if (!r) return;
        clearInterval(r.tick);
        r.abort.abort();
        await r.session.stop().catch(() => {});
        await Promise.all([...r.connections.values()].map((c) => c.close().catch(() => {})));
        log('session closed');
    });

    function start(ctx: ExtensionContext): Running {
        const id = ctx.sessionManager.getSessionId();
        log(`mcp-events ${VERSION} for Pi started in session ${id.slice(0, 8)}`);
        const trusted = ctx.isProjectTrusted();
        const registered = pi.getMcpServers().map((s) => ({ name: s.name, config: s.config as unknown }));
        const table: ServerTable = readPiServers({ env, cwd: ctx.cwd, trusted, registered });
        secrets.add(env.MCP_EVENTS_RELAY_ACCESS_KEY, readRelaySettings(env)?.accessKey);
        for (const cfg of Object.values(table.servers)) {
            if (isHttp(cfg)) {
                secrets.add(...Object.values(cfg.headers ?? {}));
                try {
                    const u = new URL(cfg.url);
                    secrets.add(u.password, u.username, ...u.searchParams.values());
                } catch {
                    // not an address: it fails to connect
                }
            } else secrets.add(...Object.values(cfg.env ?? {}));
        }
        const connections = new Map<string, EventsConnection>();
        const unavailable: Unavailable[] = [];
        const abort = new AbortController();
        const session = new PiSession(id, {
            base,
            connections,
            unavailable: () => unavailable,
            log,
            env,
            // A wake starts a turn (now if idle, else after the current one); the notice is added to the
            // conversation without one, where the user sees it at once and the model with the next turn.
            send: (text, o) => pi.sendMessage({ customType: CUSTOM_TYPE, content: text, display: true }, o.wake ? { triggerTurn: true, deliverAs: 'followUp' } : {})
        });
        const discovery = discover({ table, connections, unavailable, signal: abort.signal, log }).then(() => {
            if (!abort.signal.aborted) session.start();
        });
        try {
            const gone = pruneSessions(base, id);
            if (gone) log(`removed the stored events of ${gone} session(s) not heard from in two weeks`);
        } catch {
            // best effort
        }
        // A second Pi process with this session open leaves the watches to the first; if the first goes, this one takes them.
        const tick = setInterval(() => {
            if (!session.manager.owner && session.start()) log('the process that ran this session\'s watches has gone; this one runs them now');
        }, 5000);
        tick.unref();
        return { session, connections, unavailable, discovery, abort, tick };
    }

    async function discover(o: { table: ServerTable; connections: Map<string, EventsConnection>; unavailable: Unavailable[]; signal: AbortSignal; log: (s: string) => void }): Promise<void> {
        const timeout = Number(env.MCP_EVENTS_CONNECT_TIMEOUT_MS ?? 10000);
        const preStandard = preStandardPolicy(env.MCP_EVENTS_PRE_STANDARD);
        const probeFile = join(base, 'servers-without-events.json');
        let without: Record<string, number> = {};
        try {
            without = JSON.parse(readFileSync(probeFile, 'utf8')) as Record<string, number>;
        } catch {
            // none known
        }
        const remember = (fingerprint: string, has: boolean) => {
            if (has) delete without[fingerprint];
            else without[fingerprint] = Date.now();
            try {
                writeFileSync(probeFile, JSON.stringify(without), { mode: 0o600 });
            } catch {
                // asked again next time
            }
        };
        for (const [name, why] of Object.entries(o.table.skipped)) o.unavailable.push({ name, why });
        await Promise.all(
            Object.entries(o.table.servers).map(async ([name, cfg]) => {
                if (o.signal.aborted) return;
                const c = new EventsConnection(name, cfg, { preStandard: preStandard(name) });
                c.log = o.log;
                if (typeof without[c.fingerprint] === 'number' && Date.now() - without[c.fingerprint]! < PROBE_TTL_MS) return;
                try {
                    await c.connect(timeout);
                } catch {
                    // A server Pi signs in to with OAuth (no Authorization header) is out of reach of a connection of this extension's own.
                    const why = c.needsSignIn && mayUseOAuth(cfg) ? PI.signIn! : (c.error ?? 'it could not be connected to');
                    o.unavailable.push({ name, why });
                    o.log(`${name}: not connected: ${why}`);
                    return;
                }
                if (o.signal.aborted) return void (await c.close());
                if (c.declaration) {
                    try {
                        await c.list();
                    } catch (e) {
                        o.unavailable.push({ name, why: `events/list failed: ${describeError(e)}` });
                        return void (await c.close());
                    }
                    o.connections.set(name, c);
                    remember(c.fingerprint, true);
                    return o.log(`${name}: ${c.eventTypes.length} event type(s) (protocol revision ${c.revision})`);
                }
                const why = c.outsideTheSpec;
                if (why) o.unavailable.push({ name, why });
                else remember(c.fingerprint, false);
                await c.close();
            })
        );
    }
}
