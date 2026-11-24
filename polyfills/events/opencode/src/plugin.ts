// mcp-events for OpenCode: a V2 server plugin.
//
// OpenCode loads it into its server, once per location (project folder). It
// adds six tools (`ctx.tool.transform`); a call says, in its executor's
// `sessionID`, which session it is from, and a watch belongs to that session.
// Starting or stopping a watch is put to OpenCode's permission rules first
// (`ctx.permission.assert`). The Events client (polyfills/events/core) connects
// to the MCP servers in OpenCode's configuration, runs the watches, and stores
// every event; then `ctx.session.synthetic` hands the session a message saying
// what is new, which wakes it if it is idle.
//
// OpenCode's own MCP client takes events by push too, for its automations (an
// MCP event as a trigger), but only for event types whose schemas it can turn
// into a checker: it skips others, valid SEP-3415 schemas among them. It doesn't
// poll or take webhooks, and an automation isn't a watch of a session. So this
// plugin watches any event type it is asked to, by whichever mode the SEP's
// order picks, and points the model at automations as the alternative for push.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EventsConnection, preStandardPolicy } from '../../core/src/events-client.ts';
import { oneLine } from '../../core/src/format.ts';
import { configureHost } from '../../core/src/host.ts';
import { readRelaySettings } from '../../core/src/relay.ts';
import { pruneSessions } from '../../core/src/store.ts';
import type { Unavailable } from '../../core/src/tools.ts';
import { describeError, NAME, secrets } from '../../core/src/untrusted.ts';
import { isHttp, type ServerTable } from '../../core/src/upstream.ts';
import { OpenCodeServers } from './config.ts';
import type { Context, Plugin, ToolCallContext } from './opencode.ts';
import { OpenCodeSession, type Wake } from './sessions.ts';
import { VERSION } from './version.ts';
import { ACTIONS, NAMESPACE, NAMESPACE_DESCRIPTION, NATIVE_PUSH, OPENCODE, TOOLS } from './words.ts';

/** The tool OpenCode's own MCP Events support adds (2.4.1): its presence means OpenCode watches push events itself. */
export const NATIVE_EVENTS_TOOL = 'opencode_list_mcp_events';
const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,120}$/;

/** A name as a permission request shows it: printable ASCII as it is, anything else as `\\u{…}`. */
export const visible = (name: string): string => name.replace(/[^\x20-\x7e]/gu, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);

/**
 * What a watch is asked about: the resource `<server>:<event type>`, shown as `visible` writes it, and
 * the rule "Allow always" saves. Only plain names save one: a name a server chose that holds `*` or
 * `?` (a wildcard in OpenCode's rules) or any other character would save a rule wider than what was
 * asked about, or one that reads as something else.
 */
export function watchPermission(server: string, event: string): { resource: string; save: string[] } {
    const resource = `${visible(server)}:${visible(event)}`;
    return { resource, save: NAME.test(server) && NAME.test(event) ? [resource] : [] };
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
    if (env.MCP_EVENTS_STATE) return env.MCP_EVENTS_STATE;
    const data = env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share');
    return join(data, 'opencode', 'mcp-events');
}

function makeLog(base: string) {
    const file = join(base, 'mcp-events.log');
    try {
        if (existsSync(file) && statSync(file).size > 2 * 1024 * 1024) renameSync(file, file + '.1');
        if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 });
        chmodSync(file, 0o600);
    } catch {
        // logging is best effort
    }
    return (s: string) => {
        try {
            appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${oneLine(secrets.scrub(s), 600)}\n`);
        } catch {
            // the folder went away
        }
    };
}

/** The saved sessions of one location that have watches. */
function savedSessions(base: string, directory: string): string[] {
    const root = join(base, 'threads');
    const out: string[] = [];
    let names: string[] = [];
    try {
        names = readdirSync(root);
    } catch {
        return out;
    }
    for (const id of names) {
        if (!SESSION_ID.test(id)) continue;
        try {
            const where = JSON.parse(readFileSync(join(root, id, 'location.json'), 'utf8')) as { directory?: unknown };
            if (where.directory !== directory) continue;
            const watches = (JSON.parse(readFileSync(join(root, id, 'watches.json'), 'utf8')) as { watches?: unknown[] }).watches ?? [];
            if (watches.length) out.push(id);
        } catch {
            // nothing saved there
        }
    }
    return out;
}

export async function setup(ctx: Context, env: NodeJS.ProcessEnv = process.env): Promise<() => Promise<void>> {
    configureHost(OPENCODE);
    const off = env.MCP_EVENTS_OFF === '1' || ctx.options?.off === true;
    const base = stateDir(env);
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const log = makeLog(base);
    const directory = ctx.location.directory;
    log(`mcp-events ${VERSION} for OpenCode ${ctx.app?.version ?? '?'} started in ${directory}${off ? ' (turned off: doing nothing)' : ''}`);
    if (off) return async () => {};

    let native = false;
    try {
        native = (await ctx.tool.list()).some((t) => t.id === NATIVE_EVENTS_TOOL);
    } catch {
        // not known: treated as no native support
    }
    if (native) log("OpenCode's automations take push events too; this plugin's watches are separate from them");

    secrets.add(env.MCP_EVENTS_RELAY_ACCESS_KEY, readRelaySettings(env)?.accessKey);
    const servers = new OpenCodeServers(ctx);
    const unavailable: Unavailable[] = [];
    const connections = new Map<string, EventsConnection>();
    const preStandard = preStandardPolicy(env.MCP_EVENTS_PRE_STANDARD);
    const timeout = Number(env.MCP_EVENTS_CONNECT_TIMEOUT_MS ?? 10000);

    let discovery: Promise<void> | undefined;
    const discover = (): Promise<void> =>
        (discovery ??= (async () => {
            let table: ServerTable;
            try {
                table = await servers.table();
            } catch (e) {
                log(`OpenCode's MCP configuration could not be read (${describeError(e)})`);
                return;
            }
            if (!Object.keys(table.servers).length && !Object.keys(table.skipped).length) {
                // Nothing listed yet (OpenCode may not have applied its configuration): looked at again next time.
                discovery = undefined;
                return;
            }
            log(`OpenCode's MCP configuration: ${Object.keys(table.servers).length} server(s) to look at${Object.keys(table.skipped).length ? `, ${Object.keys(table.skipped).length} left alone` : ''}`);
            for (const [name, why] of Object.entries(table.skipped)) unavailable.push({ name, why });
            for (const cfg of Object.values(table.servers)) {
                if (isHttp(cfg)) {
                    secrets.add(...Object.values(cfg.headers ?? {}));
                    try {
                        const u = new URL(cfg.url);
                        secrets.add(u.password, u.username, ...u.searchParams.values());
                    } catch {
                        // not an address: it will fail to connect
                    }
                } else secrets.add(...Object.values(cfg.env ?? {}));
            }
            await Promise.all(
                Object.entries(table.servers).map(async ([name, cfg]) => {
                    const c = new EventsConnection(name, cfg, { preStandard: preStandard(name) });
                    c.log = log;
                    try {
                        await c.connect(timeout);
                    } catch {
                        if (c.needsSignIn) unavailable.push({ name, why: c.error ?? 'needs sign-in' });
                        log(`${name}: not connected: ${c.error}`);
                        return;
                    }
                    if (!c.declaration) {
                        if (c.outsideTheSpec) unavailable.push({ name, why: c.outsideTheSpec });
                        await c.close();
                        return;
                    }
                    try {
                        await c.list();
                        connections.set(name, c);
                        log(`${name}: ${c.eventTypes.length} event type(s) (protocol revision ${c.revision})`);
                    } catch (e) {
                        unavailable.push({ name, why: `events/list failed: ${describeError(e)}` });
                        await c.close();
                    }
                })
            );
        })());

    const wake: Wake = async (sessionID, text) => {
        try {
            await ctx.session.synthetic({ sessionID, text, description: 'mcp-events: new events', metadata: { source: 'mcp-events' }, delivery: 'queue', resume: true });
            return { ok: true };
        } catch (e) {
            const why = describeError(e);
            if (/not ?found/i.test(why)) return { ok: false, why: 'OpenCode no longer has this session', unreachable: true };
            return { ok: false, why: `OpenCode did not take the message (${why})` };
        }
    };

    const sessions = new Map<string, OpenCodeSession>();
    const sessionFor = (id: string): OpenCodeSession => {
        let s = sessions.get(id);
        if (!s) {
            s = new OpenCodeSession(id, { base, directory, connections, unavailable: () => unavailable, wake, log, env, connectTimeoutMs: timeout });
            sessions.set(id, s);
            s.start();
        }
        return s;
    };

    /** Asks OpenCode's permission rules about a watch (watchPermission); resolves when allowed, and otherwise throws OpenCode's own error. */
    const ask = (call: ToolCallContext, action: string, server: string, event: string, metadata: Record<string, unknown>) => {
        const { resource, save } = watchPermission(server, event);
        return ctx.permission.assert({ sessionID: call.sessionID, agent: call.agent, source: { type: 'tool', messageID: call.messageID, id: call.id }, action, resources: [resource], save, metadata: { ...metadata, server: visible(server), event: visible(event) } });
    };

    const execute = async (name: string, input: unknown, call: ToolCallContext): Promise<string> => {
        if (!SESSION_ID.test(call.sessionID)) return 'mcp-events needs to know which OpenCode session this call is from, and this call did not say.';
        await Promise.race([discover(), new Promise((r) => setTimeout(r, timeout + 5000).unref?.())]);
        const s = sessionFor(call.sessionID);
        if (!s.manager.owner) s.start();
        const p = (typeof input === 'object' && input !== null && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
        if (name === 'watch_event' && typeof p.server === 'string' && typeof p.event === 'string') {
            const type = connections.get(p.server)?.eventTypes.find((t) => t.name === p.event);
            if (type) await ask(call, ACTIONS.watch, p.server, p.event, { arguments: p.arguments ?? {}, note: p.note ?? '' });
        }
        if (name === 'unwatch_event' && typeof p.watch === 'string') {
            const w = s.manager.watches.find((x) => x.id === p.watch);
            if (w) await ask(call, ACTIONS.unwatch, w.server, w.event, { watch: w.id });
        }
        const answer = await s.call(name, p);
        if (answer.isError) return `Error: ${answer.text}`;
        if (native && name === 'list_event_types') return `${answer.text}\n\n${NATIVE_PUSH}`;
        if (native && name === 'watch_event' && /, by push,/.test(answer.text)) return `${answer.text} ${NATIVE_PUSH}`;
        return answer.text;
    };

    await ctx.tool.transform((editor) => {
        editor.namespace({ name: NAMESPACE, description: NAMESPACE_DESCRIPTION });
        for (const t of TOOLS)
            editor.add({
                name: t.name,
                description: t.description,
                input: t.input,
                options: { namespace: NAMESPACE, codemode: false },
                execute: async (input, call) => ({ content: await execute(t.name, input, call) })
            });
    });

    // The person wrote: a session paused at its hourly limit wakes again. Synthetic messages don't run this hook.
    await ctx.session.hook('prompt', (event) => {
        sessions.get(event.sessionID)?.spoke();
    });

    // Sessions of this location that had watches when OpenCode last stopped resume from their cursors.
    const saved = savedSessions(base, directory);
    if (saved.length)
        void servers.applied().then(discover).then(async () => {
            for (const id of saved) {
                try {
                    await ctx.session.get({ sessionID: id });
                } catch {
                    log(`[${id.slice(-8)}] OpenCode no longer has this session; its watches are left as they were`);
                    continue;
                }
                const s = sessionFor(id);
                log(`[${id.slice(-8)}] resumed ${s.manager.watches.length} watch(es)${s.manager.owner ? '' : ' (another OpenCode server runs them)'}`);
            }
        });

    try {
        const gone = pruneSessions(base, '');
        if (gone) log(`removed the stored events of ${gone} session(s) not heard from in two weeks`);
    } catch {
        // best effort
    }

    // A second OpenCode server with the same session open leaves the watches to the first; if the first goes, this one takes them over.
    const tick = setInterval(() => {
        for (const s of sessions.values()) if (!s.manager.owner && s.start()) log(`[${s.id.slice(-8)}] the process that ran this session's watches has gone; this one runs them now`);
    }, 5000);
    tick.unref?.();

    return async () => {
        clearInterval(tick);
        await Promise.all([...sessions.values()].map((s) => s.stop().catch(() => {})));
        await Promise.all([...connections.values()].map((c) => c.close().catch(() => {})));
        log('stopped');
    };
}

const plugin: Plugin = { id: 'mcp-events', setup: (ctx) => setup(ctx) };
export default plugin;
