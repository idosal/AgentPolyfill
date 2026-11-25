// What the extension keeps on disk, in its own folder (`<Pi's agent dir>/mcp-skills` by default),
// private to the user:
//
//   approvals.json  each yes the user gave to load a skill: the server's name, a
//                   fingerprint of where the server is (its URL or command, no
//                   credentials), the skill's URI, and a hash over every file's URI and
//                   digest. A later load of the same skill, from the same place, with the
//                   same files, is not asked about again. At most 2,000 are kept.
//   servers.json    which configured servers declared the Skills extension when last
//                   looked at, so the others are not connected to at every start.
//   settings.json   the user's own settings for this extension (written by hand, never by
//                   the extension): {"servers": [...]} to look only at those, {"skip": [...]}
//                   to never look at those, {"off": true} to do nothing.
//   mcp-skills.log  what the extension did, with known secrets taken out.
//   served/         the SKILL.md stubs Pi lists the served skills by (stubs.ts).
//
// No skill content and no tokens.

import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Approval = { server: string; fingerprint: string; uri: string; hash: string };
export type Known = { fingerprint: string; declares: boolean; at: number };
export type Settings = { servers?: string[]; skip?: string[]; off?: boolean };

const MAX_APPROVALS = 2000;
const names = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 500) : undefined);

function readJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
        return undefined;
    }
}

export class Store {
    readonly dir: string;
    readonly #now: () => number;

    constructor(dir: string, now: () => number = Date.now) {
        this.dir = dir;
        this.#now = now;
        try {
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            chmodSync(dir, 0o700);
        } catch {
            // the store is best effort: without it every load is asked about
        }
    }

    #write(name: string, value: unknown): boolean {
        const path = join(this.dir, name);
        // A name nobody can guess, created only if nothing is there: a link planted in advance is never written through.
        const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
        try {
            writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
            renameSync(tmp, path);
            return true;
        } catch {
            return false;
        }
    }

    #approvals(): (Approval & { at: number })[] {
        const raw = readJson(join(this.dir, 'approvals.json'));
        const list = Array.isArray((raw as { approvals?: unknown })?.approvals) ? (raw as { approvals: unknown[] }).approvals : [];
        return list.filter((a): a is Approval & { at: number } => {
            const x = a as Record<string, unknown>;
            return typeof x === 'object' && x !== null && ['server', 'fingerprint', 'uri', 'hash'].every((k) => typeof x[k] === 'string') && typeof x.at === 'number';
        });
    }

    /** Whether the user approved this skill, from this place, with exactly these files. Read afresh each time. */
    isApproved(a: Approval): boolean {
        return this.#approvals().some((x) => x.server === a.server && x.fingerprint === a.fingerprint && x.uri === a.uri && x.hash === a.hash);
    }

    /** Whether the user approved this skill before, as it was then: it has changed (or moved) since. */
    wasApproved(server: string, uri: string): boolean {
        return this.#approvals().some((x) => x.server === server && x.uri === uri);
    }

    /** Keeps a yes. Says whether it could be kept; the load it was given for goes ahead either way. */
    approve(a: Approval): boolean {
        const rest = this.#approvals().filter((x) => !(x.server === a.server && x.uri === a.uri));
        const next = [...rest, { ...a, at: this.#now() }].slice(-MAX_APPROVALS);
        return this.#write('approvals.json', { version: 1, approvals: next });
    }

    /** Drops every kept yes, or those for one server. */
    forget(server?: string): void {
        this.#write('approvals.json', { version: 1, approvals: server === undefined ? [] : this.#approvals().filter((x) => x.server !== server) });
    }

    known(): Record<string, Known> {
        const raw = readJson(join(this.dir, 'servers.json'));
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
        return Object.fromEntries(Object.entries(raw).filter((e): e is [string, Known] => typeof e[1]?.fingerprint === 'string' && typeof e[1]?.declares === 'boolean' && typeof e[1]?.at === 'number'));
    }

    learn(name: string, k: Known): void {
        this.#write('servers.json', { ...this.known(), [name]: k });
    }

    settings(): Settings {
        const raw = readJson(join(this.dir, 'settings.json')) as Record<string, unknown> | undefined;
        if (typeof raw !== 'object' || raw === null) return {};
        return { servers: names(raw.servers), skip: names(raw.skip), off: raw.off === true };
    }
}
