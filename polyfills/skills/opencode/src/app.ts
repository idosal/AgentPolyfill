// The plugin's work, apart from OpenCode's API around it (plugin.ts): connect to
// the servers in OpenCode's MCP configuration, keep the ones that declared the
// Skills extension, list their skills, say what OpenCode lists each one as, and
// serve the four tools. Loading a skill is put to OpenCode's permission rules
// first, as `mcp_skills_load` on the skill as it is now (its server, its URI
// and its manifest's digest), so a saved approval covers that version only.
//
// This is the Codex form's App (polyfills/skills/codex/src/app.ts) with
// OpenCode's permission rules in place of an MCP elicitation, and OpenCode's
// skill registry in place of SKILL.md files on disk.

import { createHash } from 'node:crypto';
import { declarationOf, manifestHash, SkillsHost, type Listed } from '../../core/src/skills.ts';
import { describeError, LocalError, secrets } from '../../core/src/untrusted.ts';
import { isHttp, type ServerTable } from '../../core/src/upstream.ts';
import { Connection } from '../../core/src/wire.ts';
import { directoryText, fileText, loadedText, statusText, type ServerNote } from './format.ts';
import { VERSION } from './version.ts';
import { ACTIONS } from './words.ts';

/** Asks OpenCode's permission rules about one action on one resource; resolves when allowed, throws otherwise. */
export type Ask = (action: string, resource: string, o: { save: boolean; metadata: Record<string, unknown> }) => Promise<void>;
export type CallContext = { ask: Ask; session: string };
export type ToolAnswer = { text: string; isError?: boolean };

const SIGN_IN = "it needs a sign-in this plugin cannot use (OpenCode's own sign-in for a server is not available to plugins): give it a header in its OpenCode configuration, or leave it to OpenCode";
const CLIENT = { name: 'mcp-skills-opencode', version: VERSION };
/** Sessions a load is held for at once; the oldest is let go past this. */
const MAX_SESSIONS = 64;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** The id OpenCode lists a served skill by: `mcp-skills:<server>:<name>`, made unique where two share a name. */
export function skillIds(listed: Listed[]): Map<Listed, string> {
    const out = new Map<Listed, string>();
    const taken = new Set<string>();
    for (const l of listed) {
        let id = `mcp-skills:${l.label}:${l.entry.frontmatter.name}`;
        if (taken.has(id)) id = `${id}-${sha(l.entry.uri).slice(0, 6)}`;
        taken.add(id);
        out.set(l, id);
    }
    return out;
}

export class App {
    readonly conns = new Map<string, Connection>();
    readonly unavailable: ServerNote[] = [];
    readonly without: string[] = [];
    /** The listings, read at the start and again when they run out. */
    readonly catalog: SkillsHost;
    /** Per OpenCode session, what it loaded and the entry it was loaded from ("the held entry"). */
    readonly #sessions = new Map<string, SkillsHost>();
    readonly #log: (line: string) => void;
    readonly #timeout: number;
    readonly #listedAt = new Map<string, { at: number; ttlMs: number }>();
    #settled!: () => void;
    readonly settled = new Promise<void>((r) => (this.#settled = r));
    /** Called when the listed skills changed, so OpenCode's skill list is rebuilt. */
    onListed?: () => void;

    constructor(o: { log?: (line: string) => void; connectTimeoutMs?: number } = {}) {
        this.#log = o.log ?? (() => {});
        this.#timeout = o.connectTimeoutMs ?? 10_000;
        this.catalog = this.#host();
    }

    #host(): SkillsHost {
        return new SkillsHost((label) => {
            const c = this.conns.get(label);
            return c?.connected ? c : undefined;
        });
    }

    #session(id: string): SkillsHost {
        let h = this.#sessions.get(id);
        if (h) {
            this.#sessions.delete(id);
            this.#sessions.set(id, h);
            return h;
        }
        h = this.#host();
        this.#sessions.set(id, h);
        while (this.#sessions.size > MAX_SESSIONS) this.#sessions.delete(this.#sessions.keys().next().value!);
        return h;
    }

    /** The servers whose skills a session has loaded (for X8). */
    loadedFrom(session: string): string[] {
        return [...new Set(this.#sessions.get(session)?.held().map((h) => h.label) ?? [])];
    }

    /** Looks at every server in the table once. Resolves when all have been looked at. */
    async start(table: ServerTable): Promise<void> {
        for (const [name, why] of Object.entries(table.skipped)) this.unavailable.push({ name, why });
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
        await Promise.all(Object.entries(table.servers).map(([name, cfg]) => this.#look(name, cfg)));
        this.#settled();
        this.onListed?.();
    }

    async #look(name: string, cfg: ServerTable['servers'][string]): Promise<void> {
        const c = new Connection(name, cfg, { client: CLIENT, signInNote: SIGN_IN });
        try {
            await c.connect(this.#timeout);
        } catch {
            this.unavailable.push({ name, why: c.error ?? 'it could not be connected to' });
            return this.#log(`${name}: not connected: ${c.error}`);
        }
        const d = declarationOf(c);
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
        this.#listedAt.set(name, { at: Date.now(), ttlMs: result.skills[0]?.ttlMs ?? 0 });
        return result;
    }

    /** A connection that was lost (a local server that restarted) is made again when it is next needed. */
    async #ensure(label: string): Promise<void> {
        const c = this.conns.get(label);
        if (!c) throw new LocalError(`no MCP server named ${JSON.stringify(label)} serves skills in this OpenCode`);
        if (c.connected) return;
        const again = new Connection(label, c.cfg, c.options);
        try {
            await again.connect(this.#timeout);
        } catch {
            throw new LocalError(`the MCP server ${JSON.stringify(label)} is not reachable now (${again.error ?? 'no connection'})`);
        }
        if (!declarationOf(again).declared) {
            await again.close();
            this.conns.delete(label);
            this.catalog.forget(label);
            this.onListed?.();
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
            if (last && Date.now() - last.at < Math.max(last.ttlMs, 10_000)) continue;
            const before = this.#signature(name);
            try {
                await this.#ensure(name);
                await this.#list(name);
            } catch (e) {
                this.#log(`${name}: skills/list failed (${describeError(e)})`);
                this.#listedAt.set(name, { at: Date.now(), ttlMs: 0 });
            }
            if (this.#signature(name) !== before) changed = true;
        }
        if (changed) this.onListed?.();
    }

    #signature(name: string): string {
        return this.catalog
            .listed(name)
            .map((l) => `${l.entry.uri} ${JSON.stringify(l.entry.frontmatter)}`)
            .join('\n');
    }

    /** The skills OpenCode lists, with the id each goes by. */
    get offered(): { listed: Listed; id: string }[] {
        const usable = this.catalog.listed().filter((l) => !l.declined);
        const ids = skillIds(usable);
        return usable.map((l) => ({ listed: l, id: ids.get(l)! }));
    }

    status(session: string, only?: string): string {
        const offered = this.offered;
        const skills = this.catalog.listed().filter((l) => only === undefined || l.label === only);
        const held = (this.#sessions.get(session)?.held() ?? []).map((x) => ({ label: x.label, uri: x.entry.uri }));
        return statusText({
            skills,
            refused: this.catalog.refused(only),
            loaded: held,
            servers: [...this.conns.entries()]
                .filter(([name]) => only === undefined || name === only)
                .map(([name, c]) => {
                    const d = declarationOf(c);
                    return { name, skills: this.catalog.listed(name).length, directoryRead: d.declared && d.directoryRead };
                }),
            unavailable: only === undefined ? this.unavailable : this.unavailable.filter((u) => u.name === only),
            without: only === undefined ? this.without : [],
            ids: new Map(offered.map((o) => [o.listed, o.id]))
        });
    }

    /** Serves one tool. Whatever goes wrong is said in this plugin's own words, never a server's; OpenCode's own refusals pass through. */
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
            await Promise.race([this.settled, new Promise((r) => setTimeout(r, 20_000).unref?.())]);
            switch (name) {
                case 'list_skills': {
                    const only = typeof p.server === 'string' && p.server ? p.server : undefined;
                    await this.#refresh(only);
                    return { text: this.status(ctx.session, only) };
                }
                case 'load_skill':
                    return await this.#load(text('server'), text('uri'), ctx);
                case 'read_skill_file': {
                    const [server, skill, path] = [text('server'), text('skill'), text('path')];
                    await this.#ensure(server);
                    const host = this.#session(ctx.session);
                    const file = await host.readFile(server, skill, path);
                    return { text: fileText(file, this.#nameOf(host, server, skill)) };
                }
                case 'list_skill_directory': {
                    const [server, skill] = [text('server'), text('skill')];
                    await this.#ensure(server);
                    const host = this.#session(ctx.session);
                    const dir = await host.listDirectory(server, skill, typeof p.path === 'string' ? p.path : '');
                    return { text: directoryText(server, this.#nameOf(host, server, skill), dir, skill) };
                }
                default:
                    return { text: `There is no tool named ${JSON.stringify(name)}.`, isError: true };
            }
        } catch (e) {
            // OpenCode's refusal (a deny rule, or the user's reject) goes back as OpenCode made it.
            if (e instanceof Refusal) throw e.original;
            this.#log(`${name} failed: ${describeError(e)}`);
            return { text: e instanceof LocalError ? capital(e.message) : `That could not be done: ${describeError(e)}.`, isError: true };
        }
    }

    /**
     * Loads one skill for one session, once OpenCode's rules allow `mcp_skills_load` on it as it is
     * now. What is loaded is the entry that was asked about, or nothing.
     */
    async #load(server: string, uri: string, ctx: CallContext): Promise<ToolAnswer> {
        await this.#ensure(server);
        const host = this.#session(ctx.session);
        if (!host.listed(server).length && this.catalog.listed(server).length) await host.list(server).catch(() => undefined);
        const listed = await host.entry(server, uri);
        const { entry } = listed;
        if (listed.declined) throw new LocalError(`this skill is not loaded: ${listed.declined}`);
        const hash = await manifestHash(entry);
        const files = entry.resources === 'dynamic' ? [] : entry.resources;
        await ask(ctx, ACTIONS.load, `${server}:${entry.uri}@${hash ?? 'dynamic'}`, {
            // A "dynamic" skill has no digest an approval could be bound to: it is asked about every time.
            save: hash !== undefined,
            metadata: {
                server,
                skill: entry.frontmatter.name,
                uri: entry.uri,
                ...(hash ? { sha256: hash, files: files.length, bytes: files.reduce((n, r) => n + r.size, 0) } : { dynamic: true }),
                note: `Not a local skill: its text is the MCP server ${JSON.stringify(server)}'s content.`
            }
        });
        const loaded = await host.load(server, uri, { expect: hash });
        this.#log(`${server}: loaded ${uri}${loaded.isVerified ? '' : ' (dynamic, unverified)'}`);
        return { text: loadedText(loaded) };
    }

    #nameOf(host: SkillsHost, server: string, skillUri: string): string {
        return host.held().find((h) => h.label === server && h.entry.uri === skillUri)?.entry.frontmatter.name ?? 'skill';
    }

    async stop(): Promise<void> {
        await Promise.all([...this.conns.values()].map((c) => c.close().catch(() => {})));
    }
}

/** OpenCode said no: its own error, kept to be thrown again unchanged. */
class Refusal extends Error {
    readonly original: unknown;
    constructor(original: unknown) {
        super('refused by OpenCode');
        this.original = original;
    }
}

async function ask(ctx: CallContext, ...args: Parameters<Ask>): Promise<void> {
    try {
        await ctx.ask(...args);
    } catch (e) {
        throw new Refusal(e);
    }
}

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? '' : '.') : s);
