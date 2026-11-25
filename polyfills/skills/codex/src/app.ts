// The helper's work, apart from the MCP server around it (mcp.ts): connect to
// the servers in the user's Codex config, keep the ones that declared the Skills
// extension, list their skills, write the SKILL.md stubs Codex lists them by
// (stubs.ts), and serve the four tools. Loading a skill is put to the person
// first, unless they approved it before as it is now.

import { isHttp, type ServerTable } from '../../core/src/upstream.ts';
import { declarationOf, manifestHash, rootOf, SkillsHost, type Listed } from '../../core/src/skills.ts';
import { describeError, LocalError, secrets } from '../../core/src/untrusted.ts';
import { Connection, fingerprintOf } from '../../core/src/wire.ts';
import type { SkillRule } from './config.ts';
import { directoryText, fileText, loadedText, previewText, questionText, statusText, type ServerNote } from './format.ts';
import type { Known, Store } from './store.ts';
import { MAX_STUBS, stubNames, stubPath, syncStubs } from './stubs.ts';
import { PLUGIN, VERSION } from './version.ts';

export type Decision = 'load' | 'show' | 'no';
/**
 * What the person answered, or why nobody could be asked, or (Muse, where the person answers by
 * typing a message of their own) what to tell them: the question waits for that answer.
 */
export type Asked = { decision: Decision } | { unavailable: string } | { pending: string };
/** Puts a question to the person (an MCP elicitation, through Codex). */
export type Ask = (message: string, choices: Decision[]) => Promise<Asked>;
export type CallContext = { ask: Ask; /** Codex's thread, from the call's `_meta`: what a load is held for. */ thread?: string };
export type ToolAnswer = { text: string; isError?: boolean };

export type AppOptions = {
    table: ServerTable;
    store: Store;
    /** Where the stubs go (`~/.agents/skills/mcp-skills-served`), or nothing to write none. */
    stubRoot?: string;
    /** Codex's `[[skills.config]]` rules, read afresh at each call. */
    skillRules: () => SkillRule[];
    /** How the stubs are written (Muse: muse.ts syncFlatStubs, one folder each in Muse's skill folder). */
    syncStubs?: typeof syncStubs;
    log?: (line: string) => void;
    connectTimeoutMs?: number;
    now?: () => number;
};

/** A server found not to serve skills is not connected to again for this long: a day. */
export const RECHECK_MS = 24 * 60 * 60 * 1000;
const SIGN_IN = 'it needs a sign-in this plugin cannot use (a server you signed in to with codex mcp login is not supported): give it the header in http_headers in config.toml, or leave it to Codex';
const CLIENT = { name: 'mcp-skills-codex', version: VERSION };
/** Threads a load is held for at once; the oldest is let go past this. */
const MAX_THREADS = 32;

export class App {
    readonly conns = new Map<string, Connection>();
    readonly unavailable: ServerNote[] = [];
    readonly without: string[] = [];
    readonly skipped: string[] = [];
    /** The listings, read at the start and when they run out. */
    readonly catalog: SkillsHost;
    /** Per Codex thread, what that thread loaded and the entry it was loaded from ("the held entry"). */
    readonly #threads = new Map<string, SkillsHost>();
    readonly #o: AppOptions;
    readonly #log: (line: string) => void;
    readonly #now: () => number;
    readonly #listedAt = new Map<string, { at: number; ttlMs: number }>();
    readonly #known: Record<string, Known>;
    #omitted = 0;
    /** Servers whose first look is still under way. */
    readonly #pending = new Set<string>();
    #stubTimer?: NodeJS.Timeout;
    #standingDown = false;
    #settled!: () => void;
    readonly settled = new Promise<void>((r) => (this.#settled = r));

    constructor(o: AppOptions) {
        this.#o = o;
        this.#log = o.log ?? (() => {});
        this.#now = o.now ?? Date.now;
        this.#known = o.store.known();
        this.catalog = this.#host();
        for (const cfg of Object.values(o.table.servers)) {
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
        this.unavailable.push(...Object.entries(o.table.skipped).map(([name, why]) => ({ name, why })));
    }

    #host(): SkillsHost {
        return new SkillsHost((label) => {
            const c = this.conns.get(label);
            return c?.connected ? c : undefined;
        }, { now: this.#now });
    }

    /** The host that holds what one thread loaded. */
    #thread(thread = ''): SkillsHost {
        let h = this.#threads.get(thread);
        if (h) {
            this.#threads.delete(thread);
            this.#threads.set(thread, h);
            return h;
        }
        h = this.#host();
        this.#threads.set(thread, h);
        while (this.#threads.size > MAX_THREADS) this.#threads.delete(this.#threads.keys().next().value!);
        return h;
    }

    /** Looks at every configured server once, and writes the stubs. Resolves when all have been looked at. */
    async start(): Promise<void> {
        for (const name of Object.keys(this.#o.table.servers)) this.#pending.add(name);
        await Promise.all(
            Object.keys(this.#o.table.servers).map(async (name) => {
                await this.#look(name);
                this.#pending.delete(name);
                this.#scheduleStubs();
            })
        );
        this.#writeStubs();
        this.#settled();
    }

    /** Codex itself serves MCP skills: nothing is offered, and the stubs go. */
    standDown(why: string): void {
        if (this.#standingDown) return;
        this.#standingDown = true;
        this.#settled();
        this.#log(`standing down: ${why}`);
        if (this.#o.stubRoot) {
            try {
                (this.#o.syncStubs ?? syncStubs)(this.#o.stubRoot, { listed: new Map(), keep: new Set() });
            } catch (e) {
                this.#log(`stubs could not be removed (${describeError(e)})`);
            }
        }
    }

    async #look(name: string): Promise<void> {
        const cfg = this.#o.table.servers[name]!;
        const fingerprint = fingerprintOf(cfg);
        const known = this.#known[name];
        if (known && !known.declares && known.fingerprint === fingerprint && this.#now() - known.at < RECHECK_MS) {
            this.skipped.push(name);
            return;
        }
        const c = new Connection(name, cfg, { client: CLIENT, signInNote: SIGN_IN });
        try {
            await c.connect(this.#o.connectTimeoutMs ?? 10_000);
        } catch {
            this.unavailable.push({ name, why: c.error ?? 'it could not be connected to' });
            return this.#log(`${name}: not connected: ${c.error}`);
        }
        const d = declarationOf(c);
        this.#o.store.learn(name, { fingerprint, declares: d.declared, at: this.#now() });
        if (!d.declared) {
            if (d.reason) this.unavailable.push({ name, why: d.reason });
            else this.without.push(name);
            this.#log(`${name}: no Skills extension${d.reason ? ` (${d.reason})` : ''}`);
            return c.close();
        }
        this.conns.set(name, c);
        try {
            const { skills, refused } = await this.#list(name);
            this.#log(`${name}: ${skills.length} skill(s), ${refused.length} left out (protocol revision ${c.revision}${d.directoryRead ? ', lists directories' : ''})`);
        } catch (e) {
            this.#log(`${name}: skills/list failed (${describeError(e)}); its skills can still be loaded by URI`);
        }
    }

    async #list(name: string) {
        const result = await this.catalog.list(name);
        this.#listedAt.set(name, { at: this.#now(), ttlMs: result.skills[0]?.ttlMs ?? 0 });
        return result;
    }

    /** A connection that was lost (a local server that restarted) is made again when it is next needed. */
    async #ensure(label: string): Promise<void> {
        const c = this.conns.get(label);
        if (!c) throw new LocalError(`no MCP server named ${JSON.stringify(label)} serves skills in this session`);
        if (c.connected) return;
        const again = new Connection(label, c.cfg, c.options);
        try {
            await again.connect(this.#o.connectTimeoutMs ?? 10_000);
        } catch {
            throw new LocalError(`the MCP server ${JSON.stringify(label)} is not reachable now (${again.error ?? 'no connection'})`);
        }
        if (!declarationOf(again).declared) {
            await again.close();
            this.conns.delete(label);
            this.catalog.forget(label);
            throw new LocalError(`the MCP server ${JSON.stringify(label)} no longer declares the Skills extension`);
        }
        this.conns.set(label, again);
    }

    /** Reads a server's listing again once its own freshness hint (`ttlMs`) has run out, and not more than every ten seconds. */
    async #refresh(only?: string): Promise<void> {
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
        if (changed) this.#writeStubs();
    }

    #signature(name: string): string {
        return this.catalog
            .listed(name)
            .map((l) => `${l.entry.uri} ${JSON.stringify(l.entry.frontmatter)}`)
            .join('\n');
    }

    /** The listed skills the user has not turned off in Codex. */
    get offered(): Listed[] {
        const rules = this.#o.skillRules();
        const names = stubNames(this.catalog.listed());
        return this.catalog.listed().filter((l) => !this.#isDisabled(l.label, l.entry.uri, rules, names.get(l)));
    }

    /**
     * Whether Codex's own per-skill setting turns this skill off: a `[[skills.config]]` rule for the
     * path of its stub, or for its name. Rules apply in order; the last one that matches decides.
     */
    #isDisabled(server: string, uri: string, rules = this.#o.skillRules(), name?: string): boolean {
        if (!rules.length) return false;
        const path = this.#o.stubRoot ? stubPath(this.#o.stubRoot, server, uri) : undefined;
        const tail = (rootOf(uri) ?? uri).split('/').at(-1);
        // The name Codex lists it by (mcp-skills:<server>:<name>), and the same without the plugin's prefix.
        const full = name ?? `${PLUGIN}:${server}:${tail}`;
        const names = new Set([full, full.slice(PLUGIN.length + 1)]);
        let disabled = false;
        for (const r of rules) if ((r.path !== undefined && r.path === path) || (r.name !== undefined && names.has(r.name))) disabled = !r.enabled;
        return disabled;
    }

    #refuseDisabled(server: string, uri: string): void {
        if (this.#isDisabled(server, uri)) throw new LocalError(`the user turned off the skill ${uri} of the MCP server ${JSON.stringify(server)} in Codex, so it is not loaded and none of its files is read. Only the user can turn it on again`);
    }

    #scheduleStubs(): void {
        if (this.#stubTimer || !this.#o.stubRoot) return;
        this.#stubTimer = setTimeout(() => {
            this.#stubTimer = undefined;
            this.#writeStubs();
        }, 200);
        this.#stubTimer.unref?.();
    }

    /** Brings the stubs in line with the listings: those of servers not reachable now stay as they were. */
    #writeStubs(): void {
        if (!this.#o.stubRoot || this.#standingDown) return;
        clearTimeout(this.#stubTimer);
        this.#stubTimer = undefined;
        const offered = this.offered;
        const listed = new Map<string, Listed[]>([...this.conns.keys()].map((name) => [name, offered.filter((l) => l.label === name)]));
        // A server still being looked at keeps the stubs it had, as one not reachable now does.
        const keep = new Set(this.unavailable.filter((u) => this.#o.table.servers[u.name] !== undefined).map((u) => u.name).concat(this.skipped, [...this.#pending]));
        try {
            const r = (this.#o.syncStubs ?? syncStubs)(this.#o.stubRoot, { listed, keep });
            this.#omitted = r.omitted;
            if (r.written || r.removed) this.#log(`stubs: ${r.written} written, ${r.removed} removed${r.omitted ? `, ${r.omitted} past the ${MAX_STUBS} written` : ''}`);
        } catch (e) {
            this.#log(`stubs could not be written (${describeError(e)}); the tools still work`);
        }
    }

    status(only?: string): string {
        const offered = this.offered.filter((l) => only === undefined || l.label === only);
        const names = stubNames(this.offered.filter((l) => !l.declined).slice(0, MAX_STUBS));
        const held = [...this.#threads.values()].flatMap((h) => h.held().map((x) => ({ label: x.label, uri: x.entry.uri })));
        return statusText({
            skills: offered,
            refused: this.catalog.refused(only),
            loaded: held,
            servers: [...this.conns.entries()]
                .filter(([name]) => only === undefined || name === only)
                .map(([name, c]) => {
                    const d = declarationOf(c);
                    const listed = this.catalog.listed(name);
                    const shown = offered.filter((l) => l.label === name).length;
                    return { name, skills: shown, disabled: only === undefined || only === name ? listed.length - this.offered.filter((l) => l.label === name).length : 0, directoryRead: d.declared && d.directoryRead };
                }),
            unavailable: only === undefined ? this.unavailable : this.unavailable.filter((u) => u.name === only),
            without: only === undefined ? this.without : [],
            skipped: only === undefined ? this.skipped : [],
            names,
            omitted: only === undefined ? this.#omitted : 0
        });
    }

    /** Serves one tool. Whatever goes wrong is said in this plugin's own words, never a server's. */
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
            // A call that arrives while the servers are still being looked at waits for them, within reason.
            await Promise.race([this.settled, new Promise((r) => setTimeout(r, 20_000).unref())]);
            if (this.#standingDown) throw new LocalError('Codex serves MCP skills itself now, so this plugin does nothing: use Codex\'s own way of loading them');
            if (name === 'load_skill' || name === 'read_skill_file' || name === 'list_skill_directory') this.#refuseDisabled(text('server'), text(name === 'load_skill' ? 'uri' : 'skill'));
            switch (name) {
                case 'list_skills': {
                    const only = typeof p.server === 'string' && p.server ? p.server : undefined;
                    await this.#refresh(only);
                    return { text: this.status(only) };
                }
                case 'load_skill':
                    return await this.#load(text('server'), text('uri'), ctx);
                case 'read_skill_file': {
                    const [server, skill, path] = [text('server'), text('skill'), text('path')];
                    await this.#ensure(server);
                    const host = this.#thread(ctx.thread);
                    const file = await host.readFile(server, skill, path);
                    return { text: fileText(file, this.#nameOf(host, server, skill)) };
                }
                case 'list_skill_directory': {
                    const [server, skill] = [text('server'), text('skill')];
                    await this.#ensure(server);
                    const host = this.#thread(ctx.thread);
                    const dir = await host.listDirectory(server, skill, typeof p.path === 'string' ? p.path : '');
                    return { text: directoryText(server, this.#nameOf(host, server, skill), dir, skill) };
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
     * Loads one skill for one thread. The person is asked first, by name, server and URI, unless
     * they approved this skill before from the same place with the same files. What is loaded is
     * the entry they were asked about, or nothing.
     */
    async #load(server: string, uri: string, ctx: CallContext): Promise<ToolAnswer> {
        await this.#ensure(server);
        const host = this.#thread(ctx.thread);
        // A thread starts from the server's current listing, as the session did; a skill the
        // listing does not hold is looked up by its URI (skills/get).
        if (!host.listed(server).length && this.catalog.listed(server).length) await host.list(server).catch(() => undefined);
        const listed = await host.entry(server, uri);
        const { entry } = listed;
        if (listed.declined) throw new LocalError(`this skill is not loaded: ${listed.declined}`);
        const hash = await manifestHash(entry);
        const fingerprint = fingerprintOf(this.conns.get(server)!.cfg);
        const approval = hash === undefined ? undefined : { server, fingerprint, uri: entry.uri, hash };
        let asked = false;
        if (!approval || !this.#o.store.isApproved(approval)) {
            asked = true;
            const files = entry.resources === 'dynamic' ? [] : entry.resources;
            const root = rootOf(entry.uri)!;
            const outer = this.catalog.listed(server).find((l) => l.entry.uri !== entry.uri && root.startsWith(`${rootOf(l.entry.uri)}/`));
            let answer = await ctx.ask(questionText({ server, entry, files: files.length, bytes: files.reduce((n, r) => n + r.size, 0), changed: this.#o.store.wasApproved(server, entry.uri), nestedIn: outer?.entry.frontmatter.name }), ['no', 'show', 'load']);
            if ('decision' in answer && answer.decision === 'show') {
                const shown = await host.preview(server, uri);
                if ((await manifestHash(shown.entry)) !== hash) throw new LocalError('this skill changed on the server while it was being shown, so it is not loaded: load it again, and the user is asked about it as it is now');
                answer = await ctx.ask(previewText({ server, entry: shown.entry, body: shown.body, isVerified: shown.isVerified }), ['no', 'load']);
            }
            if ('pending' in answer) throw new LocalError(answer.pending);
            if ('unavailable' in answer) throw new LocalError(`the skill is not loaded: the user could not be asked (${answer.unavailable}). A skill the user approves once in an interactive Codex session loads without the question afterwards, while it is unchanged`);
            if (answer.decision !== 'load') {
                this.#log(`${server}: ${uri} not approved`);
                throw new LocalError(`the user did not approve loading the skill ${JSON.stringify(entry.frontmatter.name)} from the MCP server ${JSON.stringify(server)}, so it is not loaded and nothing of it is used (in codex exec, and with the approval policy "never", Codex declines every such question: a skill approved once in an interactive session loads without asking afterwards)`);
            }
        }
        this.#refuseDisabled(server, entry.uri);
        const loaded = await host.load(server, uri, { expect: hash });
        if (approval && asked && !this.#o.store.approve(approval)) this.#log(`${server}: the approval of ${uri} could not be kept`);
        this.#log(`${server}: loaded ${uri}${loaded.isVerified ? '' : ' (dynamic, unverified)'}${asked ? '' : ' (approved earlier)'}`);
        return { text: loadedText(loaded, { asked }) };
    }

    #nameOf(host: SkillsHost, server: string, skillUri: string): string {
        return host.held().find((h) => h.label === server && h.entry.uri === skillUri)?.entry.frontmatter.name ?? 'skill';
    }

    async stop(): Promise<void> {
        clearTimeout(this.#stubTimer);
        await Promise.all([...this.conns.values()].map((c) => c.close().catch(() => {})));
    }
}

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? '' : '.') : s);
