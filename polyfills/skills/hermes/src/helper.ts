#!/usr/bin/env node
// mcp-skills for Hermes: the helper the plugin starts.
//
// The plugin (plugin/__init__.py, inside the Hermes gateway) starts this once and talks to it
// over standard input and output (tools/hermes/shared/bridge.ts). `initialize` gives it the
// MCP servers this plugin may use, as Hermes's configuration describes them. It connects to
// each, keeps those that declare the Skills extension, lists their skills, and writes a stub
// for each (stubs.ts), which the plugin registers with Hermes. The client rules of SEP-2640
// are the Codex form's (../codex/src/app.ts, over ../core), shared as they are.
//
// Asking the user is Hermes's own approval. Before load_skill runs, the plugin's pre_tool_call
// hook asks this helper what is about to be loaded (`prepare_load`): the skill's manifest
// digest goes into the approval's rule key, so an approval kept with "always" covers that
// version of the skill and nothing else (rule X14), and the load that follows must find the
// same version (else nothing is loaded). The helper also says which servers' skills a session
// has loaded (`held`), so the hook can ask before a read of another server's resource (X8).

import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { declarationOf, manifestHash, rootOf, type Listed } from '../../core/src/skills.ts';
import { describeError, LocalError, oneLine, secrets } from '../../core/src/untrusted.ts';
import { fingerprintOf } from '../../core/src/wire.ts';
import type { ServerTable } from '../../core/src/upstream.ts';
import { App, type Asked } from '../../codex/src/app.ts';
import { previewText, questionText, statusText } from '../../codex/src/format.ts';
import { Store } from '../../codex/src/store.ts';
import { Bridge, RpcError } from '../../../../tools/hermes/shared/bridge.ts';
import { MAX_STUBS, stubNames, syncStubs, type Stub } from './stubs.ts';
import { VERSION } from './version.ts';
import { CLIENT, PLUGIN, SIGN_IN, TOOLS } from './words.ts';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const env = process.env;

let store: Store | undefined;
let app: App | undefined;
let stubRoot = '';
let log: (s: string) => void = () => {};
let stubs: Stub[] = [];

/** What each session was shown in its approval, per server and URI: the version it may load. */
const prepared = new Map<string, Map<string, { hash?: string; dynamic?: boolean }>>();
/** The servers whose skills each session loaded, and the skills (server and URI). */
const held = new Map<string, Set<string>>();
const loaded = new Map<string, { label: string; uri: string }[]>();
const MAX_SESSIONS = 256;
const keyOf = (server: string, uri: string) => `${server}\n${uri}`;
function remember<T>(m: Map<string, T>, session: string, make: () => T): T {
    let v = m.get(session);
    if (v === undefined) {
        v = make();
        m.set(session, v);
        while (m.size > MAX_SESSIONS) m.delete(m.keys().next().value!);
    }
    return v;
}

function startLog(dir: string): void {
    const file = join(dir, 'mcp-skills.log');
    try {
        if (existsSync(file) && statSync(file).size > 2 * 1024 * 1024) renameSync(file, `${file}.1`);
        if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 });
        chmodSync(file, 0o600);
    } catch {
        // best effort
    }
    log = (s) => {
        try {
            appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${oneLine(secrets.scrub(s), 600)}\n`);
        } catch {
            // no log
        }
    };
}
process.on('unhandledRejection', (e) => log(`unexpected failure (${describeError(e)})`));
process.on('uncaughtException', (e) => log(`unexpected failure (${describeError(e)})`));

/** The servers this plugin may use now (named in its settings, and readable as configured). */
let granted = new Set<string>();

function writeStubs(): Stub[] {
    if (!app) return stubs;
    // A server that may be used but isn't reachable now keeps its stubs, as in the Codex form. One left
    // out (switched off, not named, signing in through Hermes, taking ${VAR} from .env) loses them: its
    // descriptions are no longer in Hermes's skill list or the system prompt.
    const keep = new Set(app.unavailable.filter((u) => granted.has(u.name)).map((u) => u.name).concat(app.skipped));
    try {
        const r = syncStubs(stubRoot, app.offered, keep);
        stubs = r.stubs;
        if (r.written || r.removed) log(`stubs: ${r.written} written, ${r.removed} removed${r.omitted ? `, ${r.omitted} past the limit` : ''}`);
    } catch (e) {
        log(`stubs could not be written (${describeError(e)}); the tools still work`);
    }
    return stubs;
}

/** The approval for one load: what Hermes shows the user, and the rule key that names this version of the skill. */
async function prepareLoad(session: string, server: string, uri: string): Promise<Json> {
    if (!app || !store) throw new RpcError(-32002, 'not initialized');
    await Promise.race([app.settled, new Promise((r) => setTimeout(r, 20_000).unref())]);
    const conn = app.conns.get(server);
    if (!conn) throw new LocalError(`no MCP server named ${JSON.stringify(server)} serves skills here`);
    const listed = await app.catalog.entry(server, uri);
    if (listed.declined) throw new LocalError(`this skill is not loaded: ${listed.declined}`);
    const { entry } = listed;
    const hash = await manifestHash(entry);
    const files = entry.resources === 'dynamic' ? [] : entry.resources;
    const root = rootOf(entry.uri);
    const outer = root ? app.catalog.listed(server).find((l) => l.entry.uri !== entry.uri && root.startsWith(`${rootOf(l.entry.uri)}/`)) : undefined;
    // The Codex form's question, in Hermes's words.
    const message = questionText({ server, entry, files: files.length, bytes: files.reduce((n, r) => n + r.size, 0), changed: store.wasApproved(server, entry.uri), nestedIn: outer?.entry.frontmatter.name }).replace('your usual Codex approvals', 'your usual Hermes approvals');
    // How to read the skill first (rule X13b): Hermes's approval has fixed answers, so the person denies
    // and asks for it with the plugin's command, whose answer goes to them and not to the model.
    const look = `To read its SKILL.md before deciding, deny this and type: /${PLUGIN} show ${server} ${entry.uri}`;
    remember(prepared, session, () => new Map()).set(keyOf(server, uri), hash ? { hash } : { dynamic: true });
    // The key is a digest of the whole identity: where the server is, the skill's URI, and its
    // manifest hash, so a kept approval ("always") covers this version of this skill only. A
    // "dynamic" skill has no digest to bind an approval to: its key holds a fresh nonce, so it is
    // asked every time. Nothing is cut, whatever the URI's length.
    const identity = JSON.stringify({ server, at: fingerprintOf(conn.cfg), uri: entry.uri, version: hash ?? `dynamic:${randomBytes(16).toString('hex')}` });
    const label = server.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
    // The entry's own URI too: the plugin checks skills.disabled against the skill that loads, however it was spelled.
    return { message: `${message}\n\n${look}`, rule_key: `${PLUGIN}:load:${label}:${createHash('sha256').update(identity).digest('hex')}`, name: entry.frontmatter.name, uri: entry.uri };
}

/** A skill's SKILL.md for the person to read before a load (`/mcp-skills show`): checked against its digest, never seen by the model. */
async function preview(server: string, uri: string): Promise<string> {
    if (!app) throw new RpcError(-32002, 'not initialized');
    await Promise.race([app.settled, new Promise((r) => setTimeout(r, 20_000).unref())]);
    if (!app.conns.get(server)) throw new LocalError(`no MCP server named ${JSON.stringify(server)} serves skills here`);
    const listed = await app.catalog.entry(server, uri);
    if (listed.declined) throw new LocalError(`this skill can't be loaded: ${listed.declined}`);
    const read = await app.catalog.preview(server, uri);
    const text = previewText({ server, entry: read.entry, body: read.body, isVerified: read.isVerified });
    const ask = read.isVerified
        ? 'To load it, ask for it in the conversation: Hermes asks you first, and loads only this version.'
        : 'To load it, ask for it in the conversation: Hermes asks you first. A generated skill is generated again for the load, so what loads may differ from this.';
    return text.replace(/\n\nLoad [^\n]*\?$/, `\n\n${ask}`);
}

async function call(name: string, args: Json, session: string): Promise<{ text: string; isError?: boolean }> {
    if (!app) return { text: 'mcp-skills is not ready.', isError: true };
    if (name === 'load_skill') {
        const server = typeof args.server === 'string' ? args.server : '';
        const uri = typeof args.uri === 'string' ? args.uri : '';
        const shown = prepared.get(session)?.get(keyOf(server, uri));
        prepared.get(session)?.delete(keyOf(server, uri));
        if (!shown) return { text: 'This skill was not put to the user through Hermes, so it is not loaded. Call load_skill again; Hermes asks the user first.', isError: true };
        // What is loaded is the version the user was asked about, or nothing.
        try {
            const now = await app.catalog.entry(server, uri);
            const hash = await manifestHash(now.entry);
            if (shown.dynamic ? hash !== undefined : hash !== shown.hash) return { text: 'This skill changed on the server after the user was asked about it, so it is not loaded: call load_skill again, and the user is asked about it as it is now.', isError: true };
        } catch (e) {
            return { text: `That could not be done: ${describeError(e)}.`, isError: true };
        }
        // Hermes asked before this call ran. The load itself refuses any other version than the one shown.
        const ask = async (): Promise<Asked> => ({ decision: 'load' });
        const r = await app.call(name, args, { ask, thread: session, expect: shown });
        if (!r.isError) {
            remember(held, session, () => new Set()).add(server);
            remember(loaded, session, () => []).push({ label: server, uri });
        }
        return r;
    }
    if (name === 'list_skills') {
        // The Codex form reads the listings again where their freshness hint has run out; the text is Hermes's.
        const r = await app.call(name, args, { ask: async () => ({ unavailable: 'no question is asked here' }), thread: session });
        if (r.isError) return r;
        return { text: statusFor(session, typeof args.server === 'string' && args.server ? args.server : undefined) };
    }
    return app.call(name, args, { ask: async () => ({ unavailable: 'no question is asked here' }), thread: session });
}

/** What list_skills says: the Codex form's text, with the names Hermes lists the skills by. */
function statusFor(session: string, only?: string): string {
    if (!app) return '';
    const offered = app.offered.filter((l) => only === undefined || l.label === only);
    const shown = app.offered.filter((l) => !l.declined && rootOf(l.entry.uri) !== undefined).slice(0, MAX_STUBS);
    const names = new Map<Listed, string>([...stubNames(shown)].map(([l, n]) => [l, `${PLUGIN}:${n}`]));
    const text = statusText({
        skills: offered,
        refused: app.catalog.refused(only),
        loaded: loaded.get(session) ?? [],
        servers: [...app.conns.entries()]
            .filter(([n]) => only === undefined || n === only)
            .map(([n, c]) => {
                const d = declarationOf(c);
                return { name: n, skills: offered.filter((l) => l.label === n).length, disabled: 0, directoryRead: d.declared && d.directoryRead };
            }),
        unavailable: only === undefined ? app.unavailable : app.unavailable.filter((u) => u.name === only),
        without: only === undefined ? app.without : [],
        skipped: only === undefined ? app.skipped : [],
        names,
        omitted: only === undefined ? Math.max(0, app.offered.filter((l) => !l.declined).length - MAX_STUBS) : 0
    });
    return text.replaceAll("Codex's skill list", "Hermes's skill list");
}

const names = new Set<string>(TOOLS.map((t) => t.name));

async function handle(method: string, params: Json): Promise<unknown> {
    const session = typeof params.session === 'string' ? params.session : '';
    switch (method) {
        case 'initialize': {
            if (app) throw new RpcError(-32600, 'already initialized');
            if (typeof params.state !== 'string' || !params.state) throw new RpcError(-32602, 'initialize needs `state`, a folder');
            mkdirSync(params.state, { recursive: true, mode: 0o700 });
            startLog(params.state);
            store = new Store(params.state);
            stubRoot = join(params.state, 'stubs');
            const table: ServerTable = { servers: {}, skipped: {} };
            if (isObject(params.servers)) for (const [n, c] of Object.entries(params.servers)) if (isObject(c)) table.servers[n] = c as never;
            if (isObject(params.skipped)) for (const [n, why] of Object.entries(params.skipped)) if (typeof why === 'string') table.skipped[n] = why;
            granted = new Set(Object.keys(table.servers));
            app = new App({ table, store, skillRules: () => [], log, client: CLIENT, signInNote: SIGN_IN, connectTimeoutMs: Number(env.MCP_SKILLS_CONNECT_TIMEOUT_MS ?? 10_000) });
            log(`mcp-skills ${VERSION} for Hermes: ${Object.keys(table.servers).length} server(s) to look at, ${Object.keys(table.skipped).length} left alone`);
            const started = app.start().then(() => writeStubs());
            void started.catch((e) => log(`start failed: ${describeError(e)}`));
            return { version: VERSION };
        }
        case 'stubs': {
            if (!app) throw new RpcError(-32002, 'not initialized');
            await Promise.race([app.settled, new Promise((r) => setTimeout(r, Number(params.waitMs ?? 30_000)).unref())]);
            return { stubs: writeStubs() };
        }
        case 'prepare_load': {
            try {
                return await prepareLoad(session, String(params.server ?? ''), String(params.uri ?? ''));
            } catch (e) {
                return { refuse: e instanceof LocalError ? e.message : `it could not be looked up (${describeError(e)})` };
            }
        }
        case 'held':
            return { servers: [...(held.get(session) ?? [])] };
        case 'preview': {
            try {
                return { text: await preview(String(params.server ?? ''), String(params.uri ?? '')) };
            } catch (e) {
                return { refuse: e instanceof LocalError ? e.message : `it could not be shown (${describeError(e)})` };
            }
        }
        case 'call': {
            const name = typeof params.name === 'string' ? params.name : '';
            if (!names.has(name)) return { text: 'mcp-skills has no tool by that name.', isError: true };
            const r = await call(name, isObject(params.arguments) ? params.arguments : {}, session);
            if (name === 'list_skills') writeStubs();
            return { text: r.text, isError: r.isError === true, stubs: name === 'list_skills' ? stubs : undefined };
        }
        case 'shutdown':
            setImmediate(() => void stop());
            return {};
        default:
            throw new RpcError(-32601, `no method ${method}`);
    }
}

const bridge = new Bridge(handle, process.stdin, process.stdout, (s) => log(s));
bridge.onClose = () => void stop();
const parent = process.ppid;
setInterval(() => {
    if (process.ppid !== parent) void stop();
}, 5000).unref();

let stopping = false;
async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), 8000).unref();
    await app?.stop().catch(() => {});
    process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
