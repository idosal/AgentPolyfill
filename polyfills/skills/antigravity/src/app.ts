import { join } from 'node:path';
import { declarationOf, SkillsHost } from '../../core/src/skills.ts';
import { Connection, fingerprintOf } from '../../core/src/wire.ts';
import type { ServerTable } from '../../core/src/upstream.ts';
import { describeError, LocalError, secrets } from '../../core/src/untrusted.ts';
import { Store } from '../../codex/src/store.ts';
import { directoryText, fileText, loadedText } from '../../codex/src/format.ts';
import { plain } from '../../codex/src/stubs.ts';
import { redeemTicket, TICKET_ARG, writePrivate } from '../../../server-cards/antigravity/src/gate.ts';
import { CLIENT, preparedEntry, readDigest, textArg, versionOf } from './approval.ts';
import { isOff, readConfig, SIGN_IN } from './config.ts';
import { stubName, syncStubs, withStubLock } from './stubs.ts';

export type ToolAnswer = { text: string; isError?: boolean };
export type AppOptions = { env: NodeJS.ProcessEnv; store: Store; stubRoot: string; log?: (s: string) => void; now?: () => number };

export class App {
    readonly conns = new Map<string, Connection>();
    readonly catalog: SkillsHost;
    readonly unavailable: { name: string; why: string }[] = [];
    readonly without: string[] = [];
    readonly skipped: string[] = [];
    readonly store: Store;
    readonly #o: AppOptions;
    readonly #threads = new Map<string, SkillsHost>();
    readonly #listedAt = new Map<string, { at: number; ttl: number }>();
    #table: ServerTable = { servers: {}, skipped: {} };
    #off = false;
    #omitted = 0;
    #started?: Promise<void>;
    constructor(o: AppOptions) { this.#o = o; this.store = o.store; this.catalog = this.#host(); }
    #host() { return new SkillsHost(label => this.conns.get(label), { now: this.#o.now ?? Date.now }); }
    #now() { return this.#o.now?.() ?? Date.now(); }
    #thread(id: string) {
        let h = this.#threads.get(id);
        if (!h) { h = this.#host(); this.#threads.set(id, h); }
        return h;
    }
    get offered() { return this.catalog.listed(); }
    start() { return this.#started ??= this.#start(); }
    async #start() {
        if (isOff(this.#o.env, this.store)) { await this.standDown(); return; }
        this.#table = readConfig(this.#o.env, this.store);
        this.unavailable.push(...Object.entries(this.#table.skipped).map(([name, why]) => ({ name, why })));
        const known = this.store.known();
        await Promise.all(Object.entries(this.#table.servers).map(async ([name, cfg]) => {
            const fingerprint = fingerprintOf(cfg), k = known[name];
            if (k && !k.declares && k.fingerprint === fingerprint && this.#now() - k.at < 86400000) { this.skipped.push(name); return; }
            const c = new Connection(name, cfg, { client: CLIENT, signInNote: SIGN_IN });
            try {
                await c.connect(8000);
                const d = declarationOf(c);
                this.store.learn(name, { fingerprint, declares: d.declared, at: this.#now() });
                if (!d.declared) {
                    if (d.reason) this.unavailable.push({ name, why: d.reason }); else this.without.push(name);
                    await c.close(); return;
                }
                this.conns.set(name, c);
                await this.#list(name);
            } catch (e) {
                this.unavailable.push({ name, why: c.error ?? describeError(e) });
                if (!this.conns.has(name)) await c.close();
            }
        }));
        this.#sync();
    }
    async #list(name: string) {
        const r = await this.catalog.list(name);
        this.#listedAt.set(name, { at: this.#now(), ttl: r.skills[0]?.ttlMs ?? 0 });
    }
    #sync() {
        try {
            writePrivate(join(this.store.dir, 'catalog.json'), JSON.stringify(this.catalog.listed().map(({ label, entry }) => ({ label, entry }))));
            const keep = new Set(this.unavailable.filter(u => this.#table.servers[u.name]).map(u => u.name));
            this.#omitted = withStubLock(this.store.dir, () => syncStubs(this.#o.stubRoot, this.#off ? [] : this.offered, this.#off ? new Set() : keep)).omitted;
        } catch (e) { this.#o.log?.(`stubs: ${describeError(e)}`); }
    }
    async standDown() { this.#off = true; this.#threads.clear(); this.#sync(); await this.stop(); }
    async #ensure(server: string) {
        const table = readConfig(this.#o.env, this.store), cfg = table.servers[server];
        let c = this.conns.get(server);
        if (!cfg) throw new LocalError(table.skipped[server] ?? `no MCP server named ${JSON.stringify(server)} serves skills in this session`);
        // The hook uses current config too. Reconnect on a move so its question cannot
        // approve a new origin while this process still reads from the old one.
        if (c && JSON.stringify(cfg) !== JSON.stringify(c.cfg)) {
            await c.close(); this.conns.delete(server); this.catalog.forget(server);
            for (const host of this.#threads.values()) host.forget(server);
            c = undefined;
        }
        if (!c?.connected) {
            c = new Connection(server, cfg, { client: CLIENT, signInNote: SIGN_IN });
            await c.connect(8000);
            if (!declarationOf(c).declared) { await c.close(); throw new LocalError(`no MCP server named ${JSON.stringify(server)} serves skills in this session`); }
            this.conns.set(server, c);
        }
        return c;
    }
    async call(tool: string, args: Record<string, unknown>): Promise<ToolAnswer> {
        try {
            await this.start();
            if (this.#off || isOff(this.#o.env, this.store)) { await this.standDown(); throw new LocalError('mcp-skills is turned off'); }
            if (tool === 'list_skills') {
                for (const name of this.conns.keys()) {
                    if (typeof args.server === 'string' && args.server && args.server !== name) continue;
                    const last = this.#listedAt.get(name);
                    if (!last || this.#now() - last.at >= Math.max(last.ttl, 10000)) {
                        await this.#ensure(name); await this.#list(name);
                    }
                }
                this.#sync();
                return { text: this.status(typeof args.server === 'string' ? args.server : undefined) };
            }
            if (!['load_skill', 'read_skill_file', 'list_skill_directory'].includes(tool)) throw new LocalError('unknown tool');
            const server = textArg(args, 'server'), uri = textArg(args, tool === 'load_skill' ? 'uri' : 'skill');
            const c = await this.#ensure(server), fingerprint = fingerprintOf(c.cfg);
            if (tool === 'load_skill') {
                // Check for a ticket before even consulting fresh metadata, and never fetch text until redemption.
                if (typeof args[TICKET_ARG] !== 'string' || !/^[0-9a-f]{32}$/.test(args[TICKET_ARG] as string)) throw new LocalError('the skill is not loaded: Antigravity\'s approval ticket did not reach the plugin');
                const entry = preparedEntry(this.store.dir, server, uri, fingerprint);
                const v = await versionOf(server, entry, fingerprint);
                const ticket = redeemTicket(this.store.dir, args[TICKET_ARG], tool, v.digest);
                if (!ticket.ok) throw new LocalError(`the skill is not loaded: ${ticket.why}`);
                if (!ticket.conversationId) throw new LocalError('the ticket has no conversation');
                const host = this.#thread(ticket.conversationId);
                // Seed this conversation from the server's current entry (its listing, or skills/get for a
                // skill the listing doesn't hold, as the hook did); refuse if anything changed after the hook.
                await host.list(server);
                const current = host.listed(server).find(l => l.entry.uri === uri) ?? await host.get(server, uri);
                if ((await versionOf(server, current.entry, fingerprint)).digest !== v.digest) throw new LocalError('the skill changed on the server after it was put to the user, so it is not loaded');
                const asked = !v.approval || !this.store.isApproved(v.approval);
                const loaded = await host.load(server, uri, { expect: v.hash });
                if ((await versionOf(server, loaded.entry, fingerprint)).digest !== v.digest) { host.forget(server); throw new LocalError('the skill changed during loading'); }
                // Settings may have changed while the network was in flight.
                const still = readConfig(this.#o.env, this.store).servers[server];
                if (!still || fingerprintOf(still) !== fingerprint) { host.forget(server); throw new LocalError('the server configuration changed during loading'); }
                if (isOff(this.#o.env, this.store)) { await this.standDown(); throw new LocalError('mcp-skills is turned off'); }
                if (v.approval && !this.store.approve(v.approval)) this.#o.log?.('the approval could not be saved; next load asks again');
                return { text: loadedText(loaded, { asked }) };
            }
            const ticket = redeemTicket(this.store.dir, args[TICKET_ARG], tool, readDigest(tool, args, fingerprint));
            if (!ticket.ok) throw new LocalError(ticket.why);
            const host = this.#thread(ticket.conversationId);
            const name = host.held().find(h => h.label === server && h.entry.uri === uri)?.entry.frontmatter.name ?? 'skill';
            if (tool === 'read_skill_file') return { text: fileText(await host.readFile(server, uri, textArg(args, 'path')), name) };
            return { text: directoryText(server, name, await host.listDirectory(server, uri, typeof args.path === 'string' ? args.path : ''), uri) };
        } catch (e) {
            const text = describeError(e);
            this.#o.log?.(`${tool}: ${text}`);
            return { text: `The request was refused: ${text}`, isError: true };
        }
    }
    status(only?: string): string {
        const out: string[] = [];
        for (const name of this.conns.keys()) {
            if (only && name !== only) continue;
            const list = this.catalog.listed(name);
            const d = declarationOf(this.conns.get(name)!);
            out.push(`MCP server ${JSON.stringify(name)}: ${list.length} skills${d.declared && d.directoryRead ? ', lists directories' : ''}.`);
            for (const l of list) out.push(`- ${l.entry.frontmatter.name} (server ${JSON.stringify(name)}, uri ${l.entry.uri}): ${plain(secrets.scrub(String(l.entry.frontmatter.description ?? '')), 400)} [not a local skill; stub ${stubName(name, l.entry.uri)}${l.declined ? `; not loadable: ${l.declined}` : ''}${list.filter(x => x.entry.frontmatter.name === l.entry.frontmatter.name).length > 1 ? '; another skill of this server has the same name: use its URI' : ''}]`);
            for (const r of this.catalog.refused(name)) out.push(`- left out: ${r.reason}`);
        }
        for (const u of this.unavailable) if (!only || only === u.name) out.push(`Not used: ${JSON.stringify(u.name)}: ${u.why}.`);
        if (this.without.length) out.push(`No Skills extension: ${this.without.join(', ')}.`);
        if (this.skipped.length) out.push(`No Skills extension when checked within a day: ${this.skipped.join(', ')}.`);
        if (this.#omitted) out.push(`${this.#omitted} past the 100-stub limit; load them by server and URI.`);
        return out.join('\n') || 'None of your configured MCP servers serves skills.';
    }
    async stop() { await Promise.all([...this.conns.values()].map(c => c.close())); }
}
