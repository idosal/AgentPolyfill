// The helper's work, apart from the process around it (helper.ts): connect to the
// servers Claude Code itself uses, keep the ones that declared the Skills
// extension, list their skills, and serve the four tools.

import { isHttp, type ServerTable } from './config.ts';
import { directoryText, fileText, listingText, loadedText, statusText, type ServerNote } from './format.ts';
import { declarationOf, keyOf, manifestHash, rootOf, SkillsHost, type Listed } from './skills.ts';
import { describeError, LocalError, secrets } from './untrusted.ts';
import { Connection, fingerprintOf } from './wire.ts';

export type Verdict = { ok: boolean; reason?: string };
export type ToolAnswer = {
    text: string;
    isError?: boolean;
    /** Set when a skill was loaded: the hooks module records that the session is acting on it. */
    acting?: { server: string; uri: string; name: string; root: string; hash?: string; fingerprint: string };
};

/** What the user is told about a skill before deciding whether it may be loaded. Nothing of its content. */
export type EntryFacts = { server: string; uri: string; name: string; files: number; bytes: number; isDynamic: boolean; hash?: string; fingerprint: string; declined?: string };

const REFUSALS: Record<string, string> = {
    unlisted: 'Claude Code does not list a server by that name in this session',
    unapproved: 'it is not approved in Claude Code yet',
    disabled: 'it is switched off in Claude Code',
    policy: "your organisation's MCP policy does not allow it",
    auth: 'Claude Code says it needs a sign-in, and a mod cannot use the sign-in Claude Code holds (see "Servers behind a sign-in" in the README)',
    unanswered: 'Claude Code did not say whether it uses this server'
};

export type AppOptions = {
    table: ServerTable;
    /** Claude Code's own verdict on a server this would connect to. */
    verdict: (name: string) => Promise<Verdict>;
    log?: (line: string) => void;
    connectTimeoutMs?: number;
    /** Called when what the listing holds has changed after the first look. */
    onChange?: () => void;
    now?: () => number;
    /** What earlier sessions learned of each server: whether it declared the Skills extension. */
    known?: Record<string, Known>;
    /** Called when a server has been looked at, with what was learned. */
    onKnown?: (name: string, known: Known) => void;
    /** Called each time one server's first look is over, while others may still be under way. */
    onLooked?: (name: string) => void;
};

/** One server as an earlier session found it: told from another of the same name by where it is. */
export type Known = { fingerprint: string; declares: boolean; at: number };
/** A skill a person named in a command: by its identity, whether they disabled it, and whether its server lists it. */
export type Named = { server: string; uri: string; name: string; isDisabled: boolean; isListed: boolean };
/** The most disabled skills the hooks module is taken at its word about: twice what it keeps. */
const MAX_DISABLED = 4000;
/** A server found not to serve skills is not connected to again for this long: a day. */
export const RECHECK_MS = 24 * 60 * 60 * 1000;

export class App {
    readonly conns = new Map<string, Connection>();
    /** Servers left alone, each with the reason in this mod's own words. */
    readonly unavailable: ServerNote[] = [];
    /** Connected servers that do not serve skills over the extension. */
    readonly without: string[] = [];
    /** Servers not connected to this time: an earlier session found they do not serve skills. */
    readonly #skipped: string[] = [];
    readonly host: SkillsHost;
    readonly #o: AppOptions;
    readonly #listedAt = new Map<string, { at: number; ttlMs: number }>();
    /**
     * The skills the user disabled, by identity (server and URI). The hooks module keeps the list
     * and sends it (setDisabled); here a disabled skill is not offered to the model, not loaded and
     * not read, as if its server did not serve it.
     */
    #disabled = new Set<string>();
    readonly #log: (line: string) => void;
    readonly #now: () => number;
    #settled!: () => void;
    readonly settled = new Promise<void>((r) => (this.#settled = r));

    constructor(o: AppOptions) {
        this.#o = o;
        this.#log = o.log ?? (() => {});
        this.#now = o.now ?? Date.now;
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
                    // not an address: it will fail to connect
                }
            } else secrets.add(...Object.values(cfg.env ?? {}));
        }
        this.unavailable.push(...Object.entries(o.table.skipped).map(([name, why]) => ({ name, why })));
    }

    /**
     * Looks at every configured server once. Resolves when all have been looked at. A server an
     * earlier session found not to serve skills is not connected to again for a day: the mod's
     * connection is a second one, and a local server would be started a second time for nothing.
     */
    async start(): Promise<void> {
        await Promise.all(
            Object.keys(this.#o.table.servers).map(async (name) => {
                await this.#look(name, false);
                this.#o.onLooked?.(name);
            })
        );
        this.#settled();
    }

    /**
     * The configured servers worth waiting a moment for at the start of a session: those an earlier
     * session found serving skills, and those no session has looked at yet (a first session, a
     * server just added). A server known not to serve skills is not waited for.
     */
    get expected(): string[] {
        return Object.entries(this.#o.table.servers)
            .filter(([name, cfg]) => {
                const known = this.#o.known?.[name];
                return !known || known.fingerprint !== fingerprintOf(cfg) || known.declares || this.#now() - known.at >= RECHECK_MS;
            })
            .map(([name]) => name);
    }

    /** Looks at every server again, whatever is remembered of it. */
    async refresh(): Promise<void> {
        const before = this.catalog().text;
        await Promise.all(Object.keys(this.#o.table.servers).map((name) => (this.conns.has(name) ? this.#relist(name) : this.#look(name, true))));
        if (this.catalog().text !== before) this.#o.onChange?.();
    }

    async #relist(name: string): Promise<void> {
        try {
            await this.#ensure(name);
            await this.#list(name);
        } catch (e) {
            this.#log(`${name}: skills/list failed (${describeError(e)})`);
        }
    }

    async #look(name: string, force: boolean): Promise<void> {
        const cfg = this.#o.table.servers[name]!;
        const timeout = this.#o.connectTimeoutMs ?? 10_000;
        const fingerprint = fingerprintOf(cfg);
        const forget = (list: ServerNote[] | string[]) => {
            const at = list.findIndex((x) => (typeof x === 'string' ? x : x.name) === name);
            if (at >= 0) list.splice(at, 1);
        };
        forget(this.unavailable);
        forget(this.without);
        forget(this.#skipped);
        const known = this.#o.known?.[name];
        if (!force && known && !known.declares && known.fingerprint === fingerprint && this.#now() - known.at < RECHECK_MS) {
            this.#skipped.push(name);
            return;
        }
        const verdict = await this.#o.verdict(name).catch(() => ({ ok: false, reason: 'unanswered' }));
        if (!verdict.ok) {
            // Claude Code itself would not use this server (now): neither does this.
            const why = REFUSALS[verdict.reason ?? ''] ?? 'Claude Code does not use it in this session';
            this.unavailable.push({ name, why });
            return this.#log(`${name}: left alone: ${why}`);
        }
        const c = new Connection(name, cfg);
        try {
            await c.connect(timeout);
        } catch {
            this.unavailable.push({ name, why: c.error ?? 'it could not be connected to' });
            return this.#log(`${name}: not connected: ${c.error}`);
        }
        const d = declarationOf(c);
        this.#o.onKnown?.(name, { fingerprint, declares: d.declared, at: this.#now() });
        if (!d.declared) {
            // No skills as the extension defines them: nothing more is sent, and no second connection is kept open.
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
        const result = await this.host.list(name);
        const ttlMs = result.skills[0]?.ttlMs ?? 0;
        this.#listedAt.set(name, { at: this.#now(), ttlMs });
        return result;
    }

    /** A connection that was lost (a local server that restarted) is made again when it is next needed. */
    async #ensure(label: string): Promise<void> {
        const c = this.conns.get(label);
        if (!c || c.connected) return;
        const again = new Connection(label, c.cfg);
        try {
            await again.connect(this.#o.connectTimeoutMs ?? 10_000);
        } catch {
            throw new LocalError(`the MCP server ${JSON.stringify(label)} is not reachable now (${again.error ?? 'no connection'})`);
        }
        if (!declarationOf(again).declared) {
            await again.close();
            this.conns.delete(label);
            this.host.forget(label);
            throw new LocalError(`the MCP server ${JSON.stringify(label)} no longer declares the Skills extension`);
        }
        this.conns.set(label, again);
    }

    /** Reads a server's listing again once the server's own freshness hint (`ttlMs`) has run out, and not more than every ten seconds. */
    async #refresh(only?: string): Promise<boolean> {
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
        return changed;
    }

    #signature(name: string): string {
        return this.host
            .listed(name)
            .map((l) => `${l.entry.uri} ${l.entry.frontmatter.description}`)
            .join('\n');
    }

    /** Every server the user's MCP configuration names, used or not. */
    get configured(): string[] {
        return [...new Set([...Object.keys(this.#o.table.servers), ...Object.keys(this.#o.table.skipped)])];
    }

    /** Every skill listed, the disabled ones included. */
    get skills(): Listed[] {
        return this.host.listed();
    }

    /** The listed skills the user has not disabled: all that is offered to the model. */
    get offered(): Listed[] {
        return this.host.listed().filter((l) => !this.isDisabled(l.label, l.entry.uri));
    }

    isDisabled(server: string, uri: string): boolean {
        return this.#disabled.has(keyOf(server, uri));
    }

    /**
     * Takes the hooks module's list of disabled skills, as pairs of server and URI; anything else in
     * it is left out. Says whether the set changed.
     */
    setDisabled(skills: unknown): boolean {
        const next = new Set<string>();
        for (const s of Array.isArray(skills) ? skills.slice(0, MAX_DISABLED) : []) {
            const { server, uri } = (typeof s === 'object' && s !== null ? s : {}) as { server?: unknown; uri?: unknown };
            if (typeof server === 'string' && typeof uri === 'string' && server.length <= 4096 && uri.length <= 4096) next.add(keyOf(server, uri));
        }
        const changed = next.size !== this.#disabled.size || [...next].some((k) => !this.#disabled.has(k));
        this.#disabled = next;
        return changed;
    }

    /** What the session's skill listing gains. */
    catalog(): { text: string; skills: number; servers: number } {
        const usable = this.offered.filter((l) => !l.declined);
        return { text: listingText(this.offered), skills: usable.length, servers: this.conns.size };
    }

    status(only?: string, isCompact = false, columns?: number): string {
        return statusText({
            isCompact,
            columns,
            skills: this.offered.filter((l) => only === undefined || l.label === only),
            all: this.offered,
            refused: this.host.refused(only),
            loaded: this.host.held().map((h) => ({ label: h.label, uri: h.entry.uri })),
            servers: [...this.conns.entries()]
                .filter(([name]) => only === undefined || name === only)
                .map(([name, c]) => {
                    const d = declarationOf(c);
                    const listed = this.host.listed(name);
                    const disabled = listed.filter((l) => this.isDisabled(name, l.entry.uri)).length;
                    return { name, skills: listed.length - disabled, disabled, directoryRead: d.declared && d.directoryRead, revision: c.revision };
                }),
            unavailable: only === undefined ? this.unavailable : this.unavailable.filter((u) => u.name === only),
            without: only === undefined ? this.without : [],
            skipped: only === undefined ? this.#skipped : []
        });
    }

    /** Serves one tool. Whatever goes wrong is said in this mod's own words, never a server's. */
    async call(name: string, input: unknown): Promise<ToolAnswer> {
        const p = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
        const text = (key: string): string => {
            const v = p[key];
            if (typeof v !== 'string' || !v.trim()) throw new LocalError(`"${key}" is required`);
            if (v.length > 4096) throw new LocalError(`"${key}" is too long`);
            // A skill's identity is taken exactly as given: the permission check looked it up that
            // way, so a padded server or URI must not reach a skill the check never saw.
            if (['server', 'uri', 'skill'].includes(key) && v !== v.trim()) throw new LocalError(`"${key}" has spaces or line breaks around it, so it names no skill`);
            return v.trim();
        };
        try {
            if (name === 'load_skill' || name === 'read_skill_file' || name === 'list_skill_directory') {
                const [server, uri] = [text('server'), text(name === 'load_skill' ? 'uri' : 'skill')];
                this.#refuseDisabled(server, uri);
            }
            switch (name) {
                case 'list_skills': {
                    const only = typeof p.server === 'string' && p.server ? p.server : undefined;
                    if (await this.#refresh(only)) this.#o.onChange?.();
                    return { text: this.status(only) };
                }
                case 'load_skill': {
                    const [server, uri] = [text('server'), text('uri')];
                    await this.#ensure(server);
                    const loaded = await this.host.load(server, uri, { expect: typeof p.expect === 'string' ? p.expect : undefined });
                    this.#log(`${server}: loaded ${uri}${loaded.isVerified ? '' : ' (dynamic, unverified)'}`);
                    return { text: loadedText(loaded), acting: { server, uri: loaded.entry.uri, name: loaded.entry.frontmatter.name, root: rootOf(loaded.entry.uri)!, hash: loaded.hash, fingerprint: this.#fingerprint(server) } };
                }
                case 'read_skill_file': {
                    const [server, skill, path] = [text('server'), text('skill'), text('path')];
                    await this.#ensure(server);
                    const file = await this.host.readFile(server, skill, path);
                    return { text: fileText(file, this.#nameOf(server, skill)) };
                }
                case 'list_skill_directory': {
                    const [server, skill] = [text('server'), text('skill')];
                    const path = typeof p.path === 'string' ? p.path : '';
                    await this.#ensure(server);
                    const dir = await this.host.listDirectory(server, skill, path);
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

    #fingerprint(server: string): string {
        const c = this.conns.get(server);
        return c ? fingerprintOf(c.cfg) : '';
    }

    /** A skill the user disabled is not loaded, read or asked about: nothing of it is requested from its server. */
    #refuseDisabled(server: string, uri: string): void {
        if (this.isDisabled(server, uri)) throw new LocalError(`the user disabled the skill ${uri} of the MCP server ${JSON.stringify(server)}, so it is not loaded and none of its files is read. Only the user can enable it again, with /mcp-skills enable`);
    }

    /** The facts of a skill's current entry, for the approval question. No file is fetched. */
    async entry(server: string, uri: string): Promise<EntryFacts> {
        this.#refuseDisabled(server, uri);
        await this.#ensure(server);
        const { entry, declined } = await this.host.entry(server, uri);
        const files = entry.resources === 'dynamic' ? [] : entry.resources;
        return { server, uri: entry.uri, name: entry.frontmatter.name, files: files.length, bytes: files.reduce((n, r) => n + r.size, 0), isDynamic: entry.resources === 'dynamic', hash: await manifestHash(entry), fingerprint: this.#fingerprint(server), declined };
    }

    /** A skill by the name or URI a person typed: the one it names, or the ones it could mean. */
    find(what: string): Listed[] {
        const all = this.skills.filter((l) => !l.declined);
        const exact = all.filter((l) => l.entry.uri === what);
        if (exact.length) return exact;
        const [server, name] = what.includes(':') && !what.includes('://') ? [what.slice(0, what.indexOf(':')), what.slice(what.indexOf(':') + 1)] : [undefined, what];
        return all.filter((l) => l.entry.frontmatter.name === name && (server === undefined || l.label === server));
    }

    /**
     * A skill by what a person typed, for a command: a name, server:name or a URI among the listed
     * skills (the disabled ones too, marked), or server:URI, which also names a skill the server
     * does not list, as load_skill takes one.
     */
    named(what: string): Named[] {
        const as = (server: string, uri: string, isListed: boolean): Named => ({ server, uri, name: lastSegmentOf(uri), isDisabled: this.isDisabled(server, uri), isListed });
        const pair = /^([^:/\s]+):([A-Za-z][A-Za-z0-9+.-]*:\/\/\S+)$/.exec(what);
        if (pair) {
            const [, server, uri] = pair as unknown as [string, string, string];
            if (!this.conns.has(server) || rootOf(uri) === undefined) return [];
            return [as(server, uri, this.host.listed(server).some((l) => l.entry.uri === uri))];
        }
        return this.find(what).map((l) => as(l.label, l.entry.uri, true));
    }

    #nameOf(server: string, skillUri: string): string {
        return this.host.held().find((h) => h.label === server && h.entry.uri === skillUri)?.entry.frontmatter.name ?? 'skill';
    }

    /**
     * The session's conversation was cleared: nothing of a loaded skill is in context any more. Or,
     * given one skill, the hooks module did not hand its load to Claude (it was disabled meanwhile).
     */
    release(server?: string, uri?: string): void {
        this.host.release(server, uri);
    }

    async stop(): Promise<void> {
        await Promise.all([...this.conns.values()].map((c) => c.close().catch(() => {})));
    }
}

/** A skill's name as its URI gives it: the last segment of its directory. */
const lastSegmentOf = (uri: string): string => {
    const root = rootOf(uri) ?? uri;
    return root.slice(root.lastIndexOf('/') + 1);
};
const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? '' : '.') : s);
