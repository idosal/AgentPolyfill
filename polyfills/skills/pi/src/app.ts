// The extension's work, apart from Pi's API around it (index.ts): reach the MCP
// servers Pi connects, keep the ones that declared the Skills extension, list
// their skills, write the SKILL.md stubs Pi lists them by (stubs.ts), and serve
// the four tools. Loading a skill is put to the person first, unless they
// approved it before as it is now.
//
// A server is reached over Pi's own connection where Pi lends it (lent.ts, a
// proposed Pi change: with Pi's sign-in, and no second process), and otherwise
// over a connection of this extension's own, built from Pi's MCP configuration.

import { createHash } from 'node:crypto';
import { declarationOf, manifestHash, rootOf, SkillsHost, type Listed } from '../../core/src/skills.ts';
import { describeError, LocalError, secrets } from '../../core/src/untrusted.ts';
import { isHttp, type ServerTable, type UpstreamConfig } from '../../core/src/upstream.ts';
import { Connection, fingerprintOf, type Wire } from '../../core/src/wire.ts';
import { directoryText, fileText, loadedText, previewText, questionText, statusText, type ServerNote } from './format.ts';
import type { SessionLender } from './lent.ts';
import { wireOf } from './lent.ts';
import type { Known, Store } from './store.ts';
import { MAX_STUBS, stubNames, syncStubs } from './stubs.ts';
import { VERSION } from './version.ts';

export type Decision = 'load' | 'show' | 'no';
/** What the person answered, or why nobody could be asked. */
export type Asked = { decision: Decision } | { unavailable: string };
/** Puts a question to the person (a Pi dialog). */
export type Ask = (message: string, choices: Decision[]) => Promise<Asked>;
export type CallContext = { ask: Ask };
export type ToolAnswer = { text: string; isError?: boolean };

/** A server's raw entry in Pi's configuration: how Pi reaches it, before any value is resolved. */
export type RawEntry = Record<string, unknown>;

export type AppOptions = {
    /** The servers as this extension's own connection would reach them (pi-config.ts). */
    table: ServerTable;
    /** Every server Pi connects, by name, as its configuration has it. */
    entries: Map<string, RawEntry>;
    /** Pi's own connections, where this Pi lends them. */
    lend?: SessionLender;
    store: Store;
    /** Where the stubs go, or nothing to write none. */
    stubRoot?: string;
    log?: (line: string) => void;
    connectTimeoutMs?: number;
    now?: () => number;
    signal?: AbortSignal;
};

/** A server found not to serve skills is not connected to again for this long: a day. */
export const RECHECK_MS = 24 * 60 * 60 * 1000;
const SIGN_IN = "it needs a sign-in, which Pi holds for its own connection (/mcp), and this Pi does not lend that connection to extensions: give the server an Authorization header in mcp.json (a ${VARIABLE} or a !command value works), or see \"Servers that need sign-in\" in the README";
const CLIENT = { name: 'mcp-skills-pi', version: VERSION };

type Conn = Wire & { readonly connected: boolean; close(): Promise<void>; readonly viaHost: boolean };

/** Where a server is, without credentials: what an approval is tied to. */
function placeOf(cfg: UpstreamConfig | undefined, raw: RawEntry | undefined): string {
    if (cfg) return fingerprintOf(cfg);
    const id = typeof raw?.url === 'string' ? { url: raw.url } : { command: String(raw?.command ?? ''), args: Array.isArray(raw?.args) ? raw.args.map(String) : [], cwd: null };
    return createHash('sha256').update(JSON.stringify(id)).digest('hex').slice(0, 24);
}

export class App {
    readonly conns = new Map<string, Conn>();
    readonly unavailable: ServerNote[] = [];
    readonly without: string[] = [];
    readonly skipped: string[] = [];
    /** The listings, and what this session loaded ("the held entry"). */
    readonly host: SkillsHost;
    readonly #o: AppOptions;
    readonly #log: (line: string) => void;
    readonly #now: () => number;
    readonly #listedAt = new Map<string, { at: number; ttlMs: number }>();
    readonly #known: Record<string, Known>;
    #omitted = 0;
    #settled!: () => void;
    readonly settled = new Promise<void>((r) => (this.#settled = r));
    /** Says when the stubs changed, so the person can be told a /reload lists them. */
    onStubsChanged?: () => void;

    constructor(o: AppOptions) {
        this.#o = o;
        this.#log = o.log ?? (() => {});
        this.#now = o.now ?? Date.now;
        this.#known = o.store.known();
        this.host = new SkillsHost((label) => {
            const c = this.conns.get(label);
            return c?.connected ? c : undefined;
        }, { now: this.#now });
        for (const cfg of Object.values(o.table.servers)) {
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
    }

    /** Looks at every server once, and writes the stubs. Resolves when all have been looked at. */
    async start(): Promise<void> {
        const settings = this.#o.store.settings();
        const names = [...this.#o.entries.keys()].filter((n) => (!settings.servers || settings.servers.includes(n)) && !(settings.skip ?? []).includes(n));
        await Promise.all(names.map((name) => this.#look(name)));
        this.#writeStubs();
        this.#settled();
    }

    async #lent(name: string): Promise<Conn | { why: string } | undefined> {
        if (!this.#o.lend) return undefined;
        try {
            const timeout = this.#o.connectTimeoutMs ?? 10_000;
            const s = await Promise.race([this.#o.lend(name, { signal: this.#o.signal }), new Promise<undefined>((r) => setTimeout(() => r(undefined), timeout).unref())]);
            return s ? wireOf(s) : undefined;
        } catch (e) {
            return { why: describeError(e) };
        }
    }

    async #own(name: string): Promise<Connection | { why: string } | undefined> {
        const cfg = this.#o.table.servers[name];
        if (!cfg) return this.#o.table.skipped[name] ? { why: this.#o.table.skipped[name]! } : undefined;
        const c = new Connection(name, cfg, { client: CLIENT, signInNote: SIGN_IN });
        try {
            await c.connect(this.#o.connectTimeoutMs ?? 10_000);
        } catch {
            return { why: c.error ?? 'it could not be connected to' };
        }
        return c;
    }

    async #look(name: string): Promise<void> {
        const place = placeOf(this.#o.table.servers[name], this.#o.entries.get(name));
        const known = this.#known[name];
        if (known && !known.declares && known.fingerprint === place && this.#now() - known.at < RECHECK_MS) {
            this.skipped.push(name);
            return;
        }
        // Pi's own connection first, where it is lent; a server Pi has not connected (or that does not
        // declare Skills on it) is tried over a connection of this extension's own.
        let c: Conn | undefined;
        let why: string | undefined;
        const lent = await this.#lent(name);
        if (lent && 'why' in lent) why = lent.why;
        else if (lent) {
            const d = declarationOf(lent);
            if (d.declared) c = lent;
            else why = d.reason;
        }
        if (!c) {
            const own = await this.#own(name);
            if (own && 'why' in own) {
                if (!lent || 'why' in lent) this.unavailable.push({ name, why: why && why !== own.why ? `${why}; and over a connection of this extension's own, ${own.why}` : own.why });
                else if (why) this.unavailable.push({ name, why });
                else this.without.push(name);
                return this.#log(`${name}: not used: ${own.why}`);
            }
            if (!own) {
                if (lent && !('why' in lent)) this.without.push(name);
                return;
            }
            c = Object.assign(own, { viaHost: false });
        }
        const d = declarationOf(c);
        this.#o.store.learn(name, { fingerprint: place, declares: d.declared, at: this.#now() });
        if (!d.declared) {
            if (d.reason) this.unavailable.push({ name, why: d.reason });
            else this.without.push(name);
            this.#log(`${name}: no Skills extension${d.reason ? ` (${d.reason})` : ''}`);
            return c.close();
        }
        this.conns.set(name, c);
        try {
            const { skills, refused } = await this.#list(name);
            this.#log(`${name}: ${skills.length} skill(s), ${refused.length} left out, over ${c.viaHost ? "Pi's connection" : "this extension's own connection"} (protocol revision ${c.revision}${d.directoryRead ? ', lists directories' : ''})`);
        } catch (e) {
            this.#log(`${name}: skills/list failed (${describeError(e)}); its skills can still be loaded by URI`);
        }
    }

    async #list(name: string) {
        const result = await this.host.list(name);
        this.#listedAt.set(name, { at: this.#now(), ttlMs: result.skills[0]?.ttlMs ?? 0 });
        return result;
    }

    /** A connection of this extension's own that was lost (a local server that restarted) is made again when it is next needed. */
    async #ensure(label: string): Promise<void> {
        const c = this.conns.get(label);
        if (!c) throw new LocalError(`no MCP server named ${JSON.stringify(label)} serves skills in this session`);
        if (c.connected) return;
        if (c.viaHost) throw new LocalError(`Pi's connection to the MCP server ${JSON.stringify(label)} is not open now`);
        const own = await this.#own(label);
        if (!own || 'why' in own) throw new LocalError(`the MCP server ${JSON.stringify(label)} is not reachable now (${own?.why ?? 'no connection'})`);
        if (!declarationOf(own).declared) {
            await own.close();
            this.conns.delete(label);
            this.host.forget(label);
            throw new LocalError(`the MCP server ${JSON.stringify(label)} no longer declares the Skills extension`);
        }
        this.conns.set(label, Object.assign(own, { viaHost: false }));
    }

    /** Reads a server's listing again once its own freshness hint (`ttlMs`) has run out, and not more than every ten seconds. */
    async refresh(only?: string): Promise<boolean> {
        let changed = false;
        for (const name of this.conns.keys()) {
            if (only !== undefined && name !== only) continue;
            const last = this.#listedAt.get(name);
            if (last && this.#now() - last.at < Math.max(last.ttlMs, 10_000)) continue;
            const before = this.#signature(name);
            try {
                await this.#ensure(name);
                await this.#list(name);
            } catch (e) {
                this.#log(`${name}: skills/list failed (${describeError(e)})`);
                this.#listedAt.set(name, { at: this.#now(), ttlMs: 0 });
            }
            if (this.#signature(name) !== before) changed = true;
        }
        if (changed && this.#writeStubs()) this.onStubsChanged?.();
        return changed;
    }

    #signature(name: string): string {
        return this.host
            .listed(name)
            .map((l) => `${l.entry.uri} ${JSON.stringify(l.entry.frontmatter)}`)
            .join('\n');
    }

    /** Brings the stubs in line with the listings: those of servers not reachable now stay as they were. Says whether any changed. */
    #writeStubs(): boolean {
        if (!this.#o.stubRoot) return false;
        const offered = this.host.listed();
        const listed = new Map<string, Listed[]>([...this.conns.keys()].map((name) => [name, offered.filter((l) => l.label === name)]));
        const keep = new Set(this.unavailable.map((u) => u.name).concat(this.skipped));
        try {
            const r = syncStubs(this.#o.stubRoot, { listed, keep });
            this.#omitted = r.omitted;
            if (r.written || r.removed) this.#log(`stubs: ${r.written} written, ${r.removed} removed${r.omitted ? `, ${r.omitted} past the ${MAX_STUBS} written` : ''}`);
            return r.written + r.removed > 0;
        } catch (e) {
            this.#log(`stubs could not be written (${describeError(e)}); the tools still work`);
            return false;
        }
    }

    status(only?: string): string {
        const offered = this.host.listed().filter((l) => only === undefined || l.label === only);
        const names = stubNames(this.host.listed().filter((l) => !l.declined).slice(0, MAX_STUBS));
        return statusText({
            skills: offered,
            refused: this.host.refused(only),
            loaded: this.host.held().map((x) => ({ label: x.label, uri: x.entry.uri })),
            servers: [...this.conns.entries()]
                .filter(([name]) => only === undefined || name === only)
                .map(([name, c]) => {
                    const d = declarationOf(c);
                    return { name, skills: offered.filter((l) => l.label === name).length, disabled: 0, directoryRead: d.declared && d.directoryRead };
                }),
            unavailable: only === undefined ? this.unavailable : this.unavailable.filter((u) => u.name === only),
            without: only === undefined ? this.without : [],
            skipped: only === undefined ? this.skipped : [],
            names,
            omitted: only === undefined ? this.#omitted : 0
        });
    }

    /** Serves one tool. Whatever goes wrong is said in this extension's own words, never a server's. */
    async call(name: string, input: unknown, ctx: CallContext): Promise<ToolAnswer> {
        const p = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
        const text = (key: string): string => {
            const v = p[key];
            if (typeof v !== 'string' || !v.trim()) throw new LocalError(`"${key}" is required`);
            if (v.length > 4096) throw new LocalError(`"${key}" is too long`);
            // A skill's identity is taken exactly as given: a padded server or URI names no skill.
            if (['server', 'uri', 'skill'].includes(key) && v !== v.trim()) throw new LocalError(`"${key}" has spaces or line breaks around it, so it names no skill`);
            return v.trim();
        };
        try {
            await Promise.race([this.settled, new Promise((r) => setTimeout(r, 20_000).unref())]);
            switch (name) {
                case 'list_skills': {
                    const only = typeof p.server === 'string' && p.server ? p.server : undefined;
                    await this.refresh(only);
                    return { text: this.status(only) };
                }
                case 'load_skill':
                    return await this.#load(text('server'), text('uri'), ctx);
                case 'read_skill_file': {
                    const [server, skill, path] = [text('server'), text('skill'), text('path')];
                    await this.#ensure(server);
                    const file = await this.host.readFile(server, skill, path);
                    return { text: fileText(file, this.#nameOf(server, skill)) };
                }
                case 'list_skill_directory': {
                    const [server, skill] = [text('server'), text('skill')];
                    await this.#ensure(server);
                    const dir = await this.host.listDirectory(server, skill, typeof p.path === 'string' ? p.path : '');
                    return { text: directoryText(server, this.#nameOf(server, skill), dir, skill) };
                }
                default:
                    return { text: `There is no tool named ${JSON.stringify(name)}.`, isError: true };
            }
        } catch (e) {
            this.#log(`${name} failed: ${describeError(e)}`);
            return { text: e instanceof LocalError ? capital(e.message) : `That could not be done: ${describeError(e)}.`, isError: true };
        }
    }

    /**
     * Loads one skill. The person is asked first, by name, server and URI, unless they approved
     * this skill before from the same place with the same files. What is loaded is the entry they
     * were asked about, or nothing.
     */
    async #load(server: string, uri: string, ctx: CallContext): Promise<ToolAnswer> {
        await this.#ensure(server);
        // The person is asked about the server's entry as it is now (skills/get), not as an earlier
        // listing had it: what they approve is what is loaded.
        const listed = await this.host.get(server, uri);
        const { entry } = listed;
        if (listed.declined) throw new LocalError(`this skill is not loaded: ${listed.declined}`);
        const hash = await manifestHash(entry);
        const fingerprint = placeOf(this.#o.table.servers[server], this.#o.entries.get(server));
        const approval = hash === undefined ? undefined : { server, fingerprint, uri: entry.uri, hash };
        let asked = false;
        if (!approval || !this.#o.store.isApproved(approval)) {
            asked = true;
            const files = entry.resources === 'dynamic' ? [] : entry.resources;
            const root = rootOf(entry.uri)!;
            const outer = this.host.listed(server).find((l) => l.entry.uri !== entry.uri && root.startsWith(`${rootOf(l.entry.uri)}/`));
            let answer = await ctx.ask(questionText({ server, entry, files: files.length, bytes: files.reduce((n, r) => n + r.size, 0), changed: this.#o.store.wasApproved(server, entry.uri), nestedIn: outer?.entry.frontmatter.name }), ['no', 'show', 'load']);
            if ('decision' in answer && answer.decision === 'show') {
                const shown = await this.host.preview(server, uri);
                if ((await manifestHash(shown.entry)) !== hash) throw new LocalError('this skill changed on the server while it was being shown, so it is not loaded: load it again, and the user is asked about it as it is now');
                answer = await ctx.ask(previewText({ server, entry: shown.entry, body: shown.body, isVerified: shown.isVerified }), ['no', 'load']);
            }
            if ('unavailable' in answer) throw new LocalError(`the skill is not loaded: the user could not be asked (${answer.unavailable}). A skill the user approves once in an interactive Pi session loads without the question afterwards, while it is unchanged`);
            if (answer.decision !== 'load') {
                this.#log(`${server}: ${uri} not approved`);
                throw new LocalError(`the user did not approve loading the skill ${JSON.stringify(entry.frontmatter.name)} from the MCP server ${JSON.stringify(server)}, so it is not loaded and nothing of it is used. Go on without it, and do not ask again unless the user brings it up`);
            }
        }
        const loaded = await this.host.load(server, uri, { expect: hash });
        if (approval && asked && !this.#o.store.approve(approval)) this.#log(`${server}: the approval of ${uri} could not be kept`);
        this.#log(`${server}: loaded ${uri}${loaded.isVerified ? '' : ' (dynamic, unverified)'}${asked ? '' : ' (approved earlier)'}`);
        return { text: loadedText(loaded, { asked }) };
    }

    #nameOf(server: string, skillUri: string): string {
        return this.host.held().find((h) => h.label === server && h.entry.uri === skillUri)?.entry.frontmatter.name ?? 'skill';
    }

    async stop(): Promise<void> {
        await Promise.all([...this.conns.values()].map((c) => c.close().catch(() => {})));
    }
}

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? '' : '.') : s);
