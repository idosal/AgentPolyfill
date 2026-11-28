import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Delivery } from '../../core/src/delivery.ts';
import type { HostWords } from '../../core/src/host.ts';
import { sessionDir, Spool } from '../../core/src/store.ts';
import type { ServerTable } from '../../core/src/upstream.ts';
import { unshowable, visible } from '../../pi/src/words.ts';
import { findMuse, museManaged, readMuseSettings, serverEnabled, selectedServers } from './muse-config.ts';
import { withSessionLock } from './session-lock.ts';
import { VERSION } from './version.ts';

type Json = Record<string, unknown>;
const isTable = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);


/** A Muse session id, as MUSE_SESSION_ID and a hook's `session_id` give it: a UUID. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The session this process serves, or undefined when Muse did not say. */
export function museSession(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const id = env.MUSE_SESSION_ID?.trim();
    return id && SESSION_ID.test(id) ? id.toLowerCase() : undefined;
}

/** Where the plugin keeps its state in Muse: the data folder Muse gives the plugin (removed with `muse plugins remove --delete-data`). */
export function museStateDir(env: NodeJS.ProcessEnv = process.env): string {
    if (env.MCP_EVENTS_STATE) return resolve(env.MCP_EVENTS_STATE);
    if (env.MUSE_PLUGIN_DATA_DIR && isAbsolute(env.MUSE_PLUGIN_DATA_DIR)) return env.MUSE_PLUGIN_DATA_DIR;
    return join(dataHome(env), 'muse', 'plugins', 'data', 'mcp-events');
}

const home = (env: NodeJS.ProcessEnv) => env.HOME || homedir();
const dataHome = (env: NodeJS.ProcessEnv) => (env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home(env), '.local', 'share'));

export { findMuse, museManaged, serverEnabled, unshowable };

/** The plugin's own settings file in Muse: {"MCP_EVENTS_…": "value"}, in place of the environment Muse does not pass. */
export const pluginSettingsPath = (base: string): string => join(base, 'settings.json');

/**
 * The environment with the plugin's settings file applied: each MCP_EVENTS_* key with a string value
 * is set, unless the environment already has it. Anything else in the file is ignored. Returns what
 * was set, by name, for the log.
 */
export function applyPluginSettings(env: NodeJS.ProcessEnv, base: string): { applied: string[]; error?: string } {
    const file = pluginSettingsPath(base);
    if (!existsSync(file)) return { applied: [] };
    let j: unknown;
    try {
        j = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return { applied: [], error: `${file} is not JSON; it was ignored` };
    }
    if (!isTable(j)) return { applied: [], error: `${file} is not a JSON object; it was ignored` };
    const applied: string[] = [];
    for (const [k, v] of Object.entries(j)) {
        if (!/^MCP_EVENTS_[A-Z0-9_]+$/.test(k) || typeof v !== 'string' || env[k] !== undefined) continue;
        // Where the state lives is decided before this file is found, so it cannot move it.
        if (k === 'MCP_EVENTS_STATE') continue;
        env[k] = v;
        applied.push(k);
    }
    return { applied };
}

/** This plugin's own helper, if someone added it to Muse's settings by hand: connecting to it would loop. */
function isSelf(arg: string): boolean {
    return (
        arg.endsWith('/dist/inbox.mjs') ||
        /mcp-events[^\\/]*(?:[\\/][^\\/]+){0,4}[\\/]dist[\\/]helper\.js$/.test(arg) ||
        /[\\/]events[\\/]codex[\\/](?:plugin[\\/](?:muse[\\/])?dist[\\/]helper\.js|src[\\/]helper\.ts)$/.test(arg) ||
        /[\\/]events[\\/]muse[\\/]src[\\/]helper\.ts$/.test(arg)
    );
}

/** Open only user-selected, supported Muse connections. */
export function readMuseServers(env: NodeJS.ProcessEnv = process.env, log: (s: string) => void = () => {}, managed?: string): ServerTable & { file: string } {
    const list = (v: string | undefined) => v?.split(',').map((s) => s.trim()).filter(Boolean);
    return readMuseSettings(env, { only: selectedServers(env), skip: list(env.MCP_EVENTS_SKIP), isSelf, log, managed });
}

/** Show the source, event, filters and delivery timing before subscribing. */
export function museWatchQuestion(p: { server: string; event: string; arguments?: unknown; note?: string; maxAgeMs?: number }): string {
    const args = p.arguments && typeof p.arguments === 'object' && Object.keys(p.arguments).length ? ` with the filters ${visible(JSON.stringify(p.arguments))}` : '';
    return [
        'mcp-events: start a watch?',
        `Muse wants to watch ${visible(JSON.stringify(p.event))} on the MCP server ${visible(JSON.stringify(p.server))}${args}.`,
        ...(p.note ? [`When it fires: ${visible(JSON.stringify(p.note))}`] : []),
        ...(p.maxAgeMs ? [`When it resumes after a break, it asks for events at most ${p.maxAgeMs} ms old.`] : []),
        '',
        'Notices arrive with your next message in this session. Ask Muse to stop the watch at any time.'
    ].join('\n');
}

/** What the person is asked before a watch stops, in Muse: the watch, its server and its event type, shown whole. */
export function museUnwatchQuestion(w: { id: string; server: string; event: string; note?: string }): string {
    return [
        'mcp-events: stop a watch?',
        `Muse wants to stop the watch ${visible(JSON.stringify(w.id))} of ${visible(JSON.stringify(w.event))} on the MCP server ${visible(JSON.stringify(w.server))}.`,
        ...(w.note ? [`Its note: ${visible(JSON.stringify(w.note))}`] : []),
        '',
        'Its events will stop coming into this session.'
    ].join('\n');
}

/** The answer to an unwatch_event that waits for the person's typed yes. */
export const unwatchPendingText = (question: string, phrase: string) =>
    [
        'The watch is not stopped yet. Muse gives this plugin no way to ask the person, so they answer by typing. Show them this question as it is:',
        '',
        question,
        '',
        `To stop it, they send a message that is exactly: ${phrase}`,
        'When they have, call unwatch_event again with the same watch. If they say no, or send anything else, leave it running.'
    ].join('\n');

/** The answer to a watch_event that waits for the person's typed yes. */
export const watchPendingText = (question: string, phrase: string) =>
    [
        'The watch is not started yet. Muse gives this plugin no way to ask the person, so they answer by typing. Show them this question as it is:',
        '',
        question,
        '',
        `To start it, they send a message that is exactly: ${phrase}`,
        'When they have, call watch_event again with the same arguments. If they say no, or send anything else, do not start it.'
    ].join('\n');

export const INBOX_MAX_CHARS = 8000;

/**
 * Takes what the session's store holds past the last hand-over, as the batch lines Codex would be
 * woken with, and records the hand-over. Only where the helper hands nothing over itself (the
 * default, inbox mode): there this is the one place the position moves. Undefined when nothing is new.
 */
export function takeStored(base: string, session: string, o: { values?: boolean; max?: number } = {}): string[] | undefined {
    // Only a session whose helper has stored something: a hook run for any other session leaves nothing behind.
    if (!existsSync(join(sessionDir(base, session), 'events.jsonl'))) return undefined;
    return withSessionLock(base, session, () => drainStored(base, session, o));
}

function drainStored(base: string, session: string, o: { values?: boolean; max?: number }): string[] | undefined {
    const delivery = new Delivery(new Spool(base, session), { values: o.values });
    const lines: string[] = [];
    let chars = 0;
    let cut = false;
    // A batch is at most a few megabytes of the store: take them until none is left.
    for (let i = 0; i < 100; i++) {
        const batch = delivery.take();
        if (!batch) break;
        for (const l of batch.lines) {
            if (cut) break;
            if (chars + l.length > (o.max ?? INBOX_MAX_CHARS)) {
                cut = true;
                break;
            }
            lines.push(l);
            chars += l.length + 1;
        }
        delivery.ack(batch.upto);
    }
    if (cut) lines.push('… (more new events than fit here: call recent_events)');
    return lines.length ? lines : undefined;
}

// ---- What the plugin says in Muse ----

const RELAY_SETUP = 'A relay of your own (a small Cloudflare Worker on your account) is set up from a clone of the AgentPolyfill repository: cd polyfills/events/claude-code/mod/relay && npm install && npx wrangler login && npm run setup. Muse, Codex and Claude Code share it.';

export const MUSE: Partial<HostWords> = {
    name: 'Muse',
    kind: 'plugin',
    client: { name: 'mcp-events-muse', version: VERSION },
    other: 'Muse process',
    scope: "this session's",
    signIn: "it needs a sign-in this plugin cannot do (it has no access to Muse's own sign-in, `muse mcp login`): give the server a literal header in Muse's settings",
    noPublicUrl:
        'This event type is delivered by webhook only, so the server needs a public https address to deliver to, and none is set up. There are three ways, for the user to choose between: ' +
        `(1) A relay of their own on their Cloudflare account; it also keeps events while Muse is closed, and nobody else sees them. ${RELAY_SETUP} ` +
        '(2) The public relay, with "MCP_EVENTS_RELAY": "public" in the plugin\'s settings.json (muse plugins inspect mcp-event-monitor shows its data folder): it is run by the author of this plugin, and event payloads pass through that server and are kept there for up to 24 hours until collected. ' +
        '(3) MCP_EVENTS_PUBLIC_URL in the same file, a forwarder of their own that sends /hooks/* to the port in MCP_EVENTS_RECEIVER_PORT. ' +
        'Then start a new Muse session.',
    relaySetup: RELAY_SETUP,
    resumeWaking: 'Waking starts again when the user next sends a message.',
    afterWatch: " New notices arrive with the person's next message in this session.",
    instructionsHead: ''
};

export const MUSE_INSTRUCTIONS = "For recurring events, list event types from the user's selected Muse servers. Ask the person to confirm the named watch. New notices accompany their next message in this session. Use recent_events to read the publisher's data. A watch runs while this session is open and resumes when it reopens.";
