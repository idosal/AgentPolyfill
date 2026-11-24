// Client (host) side of the MCP Skills extension (`io.modelcontextprotocol/skills`),
// as SEP-2640 (Final) defines it:
// https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md
//
// This file is the whole of the extension's logic and nothing else: which
// servers may be asked, what a valid entry is, what is verified and when, what
// a loaded skill may read, and what is kept. It talks to a server only through
// the `Wire` interface (wire.ts), uses nothing of Node (hashing is WebCrypto),
// and knows nothing of any host: the Claude Code and Codex adapters
// (../claude-code, ../codex) both use it. Each adapter's docs/conformance.md maps
// each client rule of the specification to the code here and the test that checks it.
//
// Section names in comments ("Capability Negotiation", "Verification on Read")
// are the specification's own headings.

import { parse as parseYaml } from 'yaml';
import type { Wire } from './wire.ts';
import { describeError, errorCode, LocalError, UNSAFE_TEXT } from './untrusted.ts';

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';
/** "Limits": what every conforming host accepts. This one accepts exactly that, and declines more. */
export const LIMITS = { resources: 512, bytes: 16 * 1024 * 1024 } as const;
export const DIRECTORY_MIME = 'inode/directory';

type Json = Record<string, unknown>;
export type SkillResource = { uri: string; digest: string; size: number };
export type SkillEntry = {
    uri: string;
    frontmatter: { name: string; description: string; [key: string]: unknown };
    resources: SkillResource[] | 'dynamic';
};

/** Why content was not used: it is not what the held entry described ("Integrity and Verification"). */
export type VerificationReason = 'size' | 'digest' | 'frontmatter' | 'unlisted';
export class VerificationError extends LocalError {
    readonly reason: VerificationReason;
    readonly uri: string;
    constructor(reason: VerificationReason, uri: string, message: string) {
        super(message);
        this.reason = reason;
        this.uri = uri;
    }
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---- Capability Negotiation -------------------------------------------------------

export type Declaration = { declared: true; directoryRead: boolean } | { declared: false; reason?: string };

/**
 * Whether the server declared the extension, as "Capability Negotiation" defines it: an object
 * under `capabilities.extensions["io.modelcontextprotocol/skills"]`, on a server that also
 * declares `resources`. `skills/list` and `skills/get` are sent only after this says so, and
 * `resources/directory/read` only where the declaration carries `directoryRead: true`.
 *
 * The declaration counts on whichever protocol revision the connection settled on. The
 * specification is written against 2026-07-28, where the capabilities arrive in `server/discover`;
 * servers in use also declare the same key in the `initialize` answer of an earlier revision,
 * and the official conformance suite's own SEP-2640 scenarios advertise it on both.
 *
 * `reason` is set where a server looks as if it meant to declare it and did so outside the
 * specification; such a server is left alone, and the user is told why.
 */
export function declarationOf(wire: Pick<Wire, 'capabilities' | 'revision'>): Declaration {
    const caps = wire.capabilities;
    const ext = isObject(caps?.extensions) ? caps.extensions[SKILLS_EXTENSION] : undefined;
    if (ext === undefined) return { declared: false };
    if (!isObject(ext)) return { declared: false, reason: 'its declaration of the Skills extension is not an object' };
    if (!isObject(caps?.resources)) return { declared: false, reason: 'it declares the Skills extension without the resources capability, which the extension requires' };
    return { declared: true, directoryRead: ext.directoryRead === true };
}

// ---- Resource Mapping: URIs --------------------------------------------------------

const SKILL_MD = '/SKILL.md';
/** Agent Skills naming rule: 1 to 64 lowercase letters, digits and single hyphens. */
const SKILL_NAME = /^[\da-z]+(?:-[\da-z]+)*$/;
const DIGEST = /^sha256:[\da-f]{64}$/;

/** The skill's root directory: its `SKILL.md` URI without `/SKILL.md`, no trailing slash. */
export function rootOf(skillUri: string): string | undefined {
    if (!skillUri.endsWith(SKILL_MD) || /[#?\s]/.test(skillUri) || UNSAFE_TEXT.test(skillUri)) return undefined;
    const root = skillUri.slice(0, -SKILL_MD.length);
    // A scheme, then a skill path of at least one segment.
    return /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+(\/[^/]+)*$/.test(root) ? root : undefined;
}

/** The final segment of the skill path, which must equal the skill's name. */
function lastSegment(root: string): string {
    return root.slice(root.lastIndexOf('/') + 1);
}

/**
 * One spelling for a URI that may be percent-encoded two ways: each path segment decoded where it
 * decodes. Used only to compare a requested file with the manifest; what is sent to the server is
 * always the manifest's own spelling.
 */
function canonical(uri: string): string {
    return uri
        .split('/')
        .map((segment) => {
            try {
                return decodeURIComponent(segment);
            } catch {
                return segment;
            }
        })
        .join('/');
}

/**
 * "Relative References": a reference resolves against the skill's root, as a filesystem path
 * would. `ref` is a path relative to the root (`references/GUIDE.md`, `./a/../b.md`), or a full URI
 * inside the skill. Nothing resolves to outside the skill's directory.
 */
export function resolveRef(skillUri: string, ref: string): string {
    const root = rootOf(skillUri);
    if (root === undefined) throw new LocalError('that is not the URI of a SKILL.md');
    let path = ref.trim();
    if (UNSAFE_TEXT.test(path)) throw new LocalError('a file reference cannot hold control, direction-changing or invisible characters');
    path = path.replace(/#.*$/, ''); // a fragment names a place in the file, not another file
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) {
        // A full URI: it has to be this skill's own SKILL.md, its directory, or lie inside that.
        if (path === skillUri || path === root) return path;
        if (!path.startsWith(`${root}/`)) throw new LocalError('that URI is outside the skill; a skill reads only its own files, from the server that serves it');
        path = path.slice(root.length + 1);
    }
    if (path.startsWith('/')) throw new LocalError('a file reference is relative to the skill, and cannot start with "/"');
    const out: string[] = [];
    for (const segment of path.split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') {
            if (!out.length) throw new LocalError('that reference leads outside the skill; a skill reads only its own files');
            out.pop();
        } else out.push(segment);
    }
    return out.length ? `${root}/${out.join('/')}` : root;
}

// ---- Skill Entries -------------------------------------------------------------------

export type Checked = { entry: SkillEntry; declined?: string } | { invalid: string; uri?: string };

/**
 * Checks one entry from `skills/list` or `skills/get` against "Skill Entries" and "Resource
 * Mapping". An invalid entry is never loaded. A valid one past the "Limits" is declined, with
 * the reason, before any of its files is retrieved.
 */
export function checkEntry(raw: unknown): Checked {
    if (!isObject(raw)) return { invalid: 'the entry is not an object' };
    const uri = typeof raw.uri === 'string' ? raw.uri : undefined;
    const bad = (invalid: string): Checked => ({ invalid, ...(uri !== undefined ? { uri } : {}) });
    if (uri === undefined) return bad('it has no uri');
    // Such a URI is never repeated, not even in the note that leaves it out: a terminal could act on it.
    if (UNSAFE_TEXT.test(uri)) return { invalid: 'its uri holds control, direction-changing or invisible characters' };
    if (uri.length > 2048) return bad('its uri is longer than 2048 characters');
    const root = rootOf(uri);
    if (root === undefined) return bad('its uri is not the URI of a SKILL.md inside a named directory');
    const fm = raw.frontmatter;
    if (!isObject(fm)) return bad('it has no frontmatter');
    const { name, description } = fm;
    if (typeof name !== 'string' || name.length > 64 || !SKILL_NAME.test(name)) return bad('its name is not 1 to 64 lowercase letters, digits and single hyphens');
    // "The final <skill-path> segment of the entry's uri MUST equal frontmatter.name."
    if (lastSegment(root) !== name) return bad('its name does not equal the last segment of its path');
    if (typeof description !== 'string' || !description.trim() || [...description].length > 1024) return bad('its description is not 1 to 1024 characters');
    const resources = raw.resources;
    // "An entry with no resources at all, or with any value other than an array or "dynamic", is
    // invalid, and hosts MUST NOT load it."
    if (resources === 'dynamic') return { entry: { uri, frontmatter: fm as SkillEntry['frontmatter'], resources: 'dynamic' } };
    if (!Array.isArray(resources)) return bad('its resources is neither a list of files nor "dynamic"');
    // The limit on the count is checked before the entries are walked.
    if (resources.length > 4 * LIMITS.resources) return bad(`it lists ${resources.length} files`);
    const seen = new Set<string>();
    const files: SkillResource[] = [];
    let hasSelf = false;
    let total = 0;
    for (const r of resources) {
        if (!isObject(r) || typeof r.uri !== 'string') return bad('one of its files has no uri');
        if (r.uri.length > 2048 || /[#?\s]/.test(r.uri)) return bad('one of its files has a uri that is too long or holds a query, fragment or space');
        if (UNSAFE_TEXT.test(r.uri)) return bad('one of its files has a uri that holds control, direction-changing or invisible characters');
        if (typeof r.digest !== 'string' || !DIGEST.test(r.digest)) return bad('one of its files has a digest that is not "sha256:" and 64 lowercase hexadecimal characters');
        if (typeof r.size !== 'number' || !Number.isSafeInteger(r.size) || r.size < 0) return bad('one of its files has no size');
        // "Each uri MUST be the skill's SKILL.md or a file within the skill's directory."
        if (r.uri === uri) hasSelf = true;
        else if (!r.uri.startsWith(`${root}/`) || resolveRefSafe(uri, r.uri) !== r.uri) return bad('one of its files is outside the skill\'s directory');
        // "It lists every file of the skill, each exactly once."
        const key = canonical(r.uri);
        if (seen.has(key)) return bad('one of its files is listed more than once');
        seen.add(key);
        total += r.size;
        files.push({ uri: r.uri, digest: r.digest, size: r.size });
    }
    // "...including an entry whose uri equals the skill's top-level uri."
    if (!hasSelf) return bad('its files do not include its own SKILL.md');
    const entry: SkillEntry = { uri, frontmatter: fm as SkillEntry['frontmatter'], resources: files };
    if (files.length > LIMITS.resources) return { entry, declined: `it has ${files.length} files, and this mod accepts up to ${LIMITS.resources} per skill (the limit the Skills extension sets)` };
    if (total > LIMITS.bytes) return { entry, declined: `its files add up to ${total} bytes, and this mod accepts up to ${LIMITS.bytes} per skill (the limit the Skills extension sets)` };
    return { entry };
}

function resolveRefSafe(skillUri: string, ref: string): string | undefined {
    try {
        return resolveRef(skillUri, ref);
    } catch {
        return undefined;
    }
}

/** Every `uri` and `digest` of an entry, in one string: what an approval would be bound to. */
export function manifestKey(entry: SkillEntry): string {
    if (entry.resources === 'dynamic') return 'dynamic';
    return entry.resources
        .map((r) => `${r.uri} ${r.digest}`)
        .sort()
        .join('\n');
}

// ---- Integrity and Verification ----------------------------------------------------

async function sha256(bytes: Uint8Array): Promise<string> {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
    let hex = '';
    for (const b of hash) hex += b.toString(16).padStart(2, '0');
    return `sha256:${hex}`;
}

/**
 * One value for an entry's whole `resources` set: what a stored approval is bound to
 * ("Content-bound approval"). It changes when any file is rotated, added or removed. A
 * `"dynamic"` skill has none: it cannot be content-bound.
 */
export async function manifestHash(entry: SkillEntry): Promise<string | undefined> {
    return entry.resources === 'dynamic' ? undefined : sha256(new TextEncoder().encode(manifestKey(entry)));
}

function fromBase64(text: string): Uint8Array | undefined {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return undefined;
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

export type FileContent = { uri: string; bytes: Uint8Array; mimeType?: string; isText: boolean };

/** The raw bytes of one file out of a `resources/read` result: the same bytes a digest covers. */
export function contentOf(result: Json, uri: string): FileContent {
    const contents = Array.isArray(result.contents) ? result.contents.filter(isObject) : [];
    const item = contents.find((c) => c.uri === uri) ?? (contents.length === 1 ? contents[0] : undefined);
    if (!item) throw new LocalError('the server answered the read with no content for that file');
    const mimeType = typeof item.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+/.test(item.mimeType) ? item.mimeType.slice(0, 100) : undefined;
    if (typeof item.text === 'string') return { uri, bytes: new TextEncoder().encode(item.text), mimeType, isText: true };
    if (typeof item.blob === 'string') {
        const bytes = fromBase64(item.blob);
        if (!bytes) throw new LocalError('the server answered the read with content that is not valid base64');
        return { uri, bytes, mimeType, isText: false };
    }
    throw new LocalError('the server answered the read with neither text nor binary content');
}

/** "Verification on Read": the content against the entry's `size`, then its `digest`. */
export async function verifyFile(resource: SkillResource, bytes: Uint8Array): Promise<void> {
    // A read whose byte length differs from the entry's size is a verification failure, whether or
    // not the digest is computed.
    if (bytes.length !== resource.size) throw new VerificationError('size', resource.uri, `${shown(resource.uri)} is ${bytes.length} bytes, and the skill's entry says ${resource.size}`);
    if ((await sha256(bytes)) !== resource.digest) throw new VerificationError('digest', resource.uri, `${shown(resource.uri)} does not match the SHA-256 digest in the skill's entry`);
}

const shown = (uri: string) => JSON.stringify(uri.length > 200 ? `${uri.slice(0, 199)}…` : uri);

/** A `SKILL.md` split into its YAML frontmatter and the markdown after it. */
export function splitSkillMd(bytes: Uint8Array): { frontmatter: Json; body: string } | undefined {
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return undefined;
    }
    text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    if (!text.startsWith('---\n')) return undefined;
    const end = text.indexOf('\n---', 3);
    if (end < 0) return undefined;
    const after = text.slice(end + 4);
    // The closing line is `---` alone (trailing spaces allowed).
    const rest = /^[ \t]*(\n|$)/.exec(after);
    if (!rest) return undefined;
    let frontmatter: unknown;
    try {
        frontmatter = parseYaml(text.slice(4, end + 1), { schema: 'core', maxAliasCount: 0, prettyErrors: false });
    } catch {
        return undefined;
    }
    if (!isObject(frontmatter)) return undefined;
    return { frontmatter, body: after.slice(rest[0].length) };
}

function same(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
    if (isObject(a)) {
        if (!isObject(b)) return false;
        const keys = Object.keys(a);
        return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
    }
    return false;
}

/**
 * "Frontmatter Verification": the frontmatter of the fetched `SKILL.md`, field by field against
 * the entry's. Any difference is a verification failure, and the skill is not loaded. Returns the
 * markdown after the frontmatter.
 */
export function verifyFrontmatter(entry: SkillEntry, bytes: Uint8Array): string {
    const split = splitSkillMd(bytes);
    if (!split) throw new VerificationError('frontmatter', entry.uri, 'its SKILL.md does not begin with YAML frontmatter that can be read');
    const differing = [...new Set([...Object.keys(entry.frontmatter), ...Object.keys(split.frontmatter)])].filter((k) => !same(entry.frontmatter[k], split.frontmatter[k]) || Object.hasOwn(entry.frontmatter, k) !== Object.hasOwn(split.frontmatter, k));
    if (differing.length) {
        // Field names are the server's text: only ones that look like names are repeated.
        const names = differing.filter((k) => /^[A-Za-z][\w-]{0,39}$/.test(k)).slice(0, 8);
        throw new VerificationError('frontmatter', entry.uri, `the frontmatter of its SKILL.md differs from the skill's entry${names.length ? ` (${names.join(', ')})` : ''}`);
    }
    return split.body;
}

// ---- The host ------------------------------------------------------------------------

/** The identity of an MCP-served skill ("Skill URIs"): the host's label for the server, and the uri. Never the uri alone. */
export const keyOf = (label: string, uri: string): string => `${label}\n${uri}`;

export type Listed = { label: string; entry: SkillEntry; declined?: string; fetchedAt: number; ttlMs: number };
export type Refused = { label: string; uri?: string; reason: string };
export type Held = { label: string; entry: SkillEntry; loadedAt: number; retrieved: number };
export type Loaded = { label: string; entry: SkillEntry; body: string; isVerified: boolean; directoryRead: boolean; /** The entry's manifest hash; nothing for a `"dynamic"` skill. */ hash?: string };
export type ReadFile = { label: string; skillUri: string; uri: string; mimeType?: string; text?: string; size: number; isVerified: boolean; isNestedSkill: boolean };
export type DirectoryChild = { uri: string; name: string; isDirectory: boolean; size?: number; mimeType?: string };

export type HostOptions = {
    now?: () => number;
    /** The most `skills/list` pages read from one server, and the most entries kept from it. */
    maxPages?: number;
    maxEntries?: number;
    /** Bytes of verified files kept in memory for the session. */
    cacheBytes?: number;
    requestTimeoutMs?: number;
};

/**
 * The skills of the user's MCP servers: the registry built from listings, the entries held while
 * a skill is in use, and the two operations that retrieve content (`load`, `readFile`).
 *
 * "Lazy Retrieval": nothing here retrieves a file ahead of need. Listing reads `skills/list`
 * alone. A `SKILL.md` is fetched when the skill is loaded, a supporting file when it is read.
 */
export class SkillsHost {
    readonly #wire: (label: string) => Wire | undefined;
    readonly #o: Required<HostOptions>;
    /** By identity (server label and uri), never by name or by uri alone. */
    readonly #registry = new Map<string, Listed>();
    readonly #refused = new Map<string, Refused[]>();
    readonly #held = new Map<string, Held>();
    /** Verified files, kept in this process's memory only, by server, uri and digest. */
    readonly #cache = new Map<string, FileContent>();
    #cached = 0;

    constructor(wire: (label: string) => Wire | undefined, options: HostOptions = {}) {
        this.#wire = wire;
        this.#o = { now: Date.now, maxPages: 64, maxEntries: 2000, cacheBytes: 64 * 1024 * 1024, requestTimeoutMs: 60_000, ...options };
    }

    #declared(label: string): { wire: Wire; directoryRead: boolean } {
        const wire = this.#wire(label);
        if (!wire) throw new LocalError(`no MCP server named ${JSON.stringify(label)} is connected for skills`);
        const d = declarationOf(wire);
        // "Clients issue skills/list and skills/get only after observing the server's declaration."
        if (!d.declared) throw new LocalError(`the MCP server ${JSON.stringify(label)} has not declared the Skills extension${d.reason ? ` (${d.reason})` : ''}, so nothing on it is loaded as a skill`);
        return { wire, directoryRead: d.directoryRead };
    }

    #request(wire: Wire, method: string, params: Json): Promise<Json> {
        return wire.request(method, params, { timeoutMs: this.#o.requestTimeoutMs });
    }

    /**
     * "Listing Skills": reads every page of the server's `skills/list` into the registry. Sent only
     * to a server that declared the extension; a server that did not is skipped without a request.
     * No file is fetched.
     */
    async list(label: string): Promise<{ skills: Listed[]; refused: Refused[] }> {
        const wire = this.#wire(label);
        if (!wire || !declarationOf(wire).declared) return { skills: [], refused: [] };
        const now = this.#o.now();
        const raw: unknown[] = [];
        let ttlMs = 0;
        let cursor: string | undefined;
        let more = false;
        for (let page = 0; page < this.#o.maxPages; page++) {
            const r = await this.#request(wire, 'skills/list', cursor === undefined ? {} : { cursor });
            // The standard result shape; anything else (a task, a request for input) is not a listing.
            if (r.resultType !== undefined && r.resultType !== 'complete') throw new LocalError('the server answered skills/list with something other than a complete result');
            if (!Array.isArray(r.skills)) throw new LocalError('the server answered skills/list without a list of skills');
            // An entry is atomic: it is never split across pages.
            raw.push(...r.skills);
            if (page === 0) ttlMs = typeof r.ttlMs === 'number' && r.ttlMs >= 0 ? r.ttlMs : 0;
            cursor = typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined;
            more = cursor !== undefined;
            if (!more || raw.length >= this.#o.maxEntries) break;
        }
        const refused: Refused[] = [];
        const checked = raw.slice(0, this.#o.maxEntries).map(checkEntry);
        const counts = new Map<string, number>();
        for (const c of checked) if ('entry' in c) counts.set(c.entry.uri, (counts.get(c.entry.uri) ?? 0) + 1);
        for (const key of [...this.#registry.keys()]) if (key.startsWith(`${label}\n`)) this.#registry.delete(key);
        for (const c of checked) {
            if ('invalid' in c) refused.push({ label, uri: c.uri, reason: c.invalid });
            // Two entries for one uri: neither is preferred, and neither is silently dropped.
            else if ((counts.get(c.entry.uri) ?? 0) > 1) refused.push({ label, uri: c.entry.uri, reason: 'the listing holds this uri more than once' });
            else this.#registry.set(keyOf(label, c.entry.uri), { label, entry: c.entry, declined: c.declined, fetchedAt: now, ttlMs });
        }
        if (more) refused.push({ label, reason: `the listing is longer than this mod reads (${this.#o.maxEntries} entries or ${this.#o.maxPages} pages); a skill beyond that can still be loaded by its URI` });
        this.#refused.set(label, refused);
        return { skills: this.listed(label), refused };
    }

    /** What the registry holds: every entry by identity. Names may repeat; nothing is merged by name. */
    listed(label?: string): Listed[] {
        return [...this.#registry.values()].filter((l) => label === undefined || l.label === label);
    }

    refused(label?: string): Refused[] {
        return [...this.#refused.entries()].filter(([l]) => label === undefined || l === label).flatMap(([, r]) => r);
    }

    /** Forgets a server: its registry entries, held entries and cached files. */
    forget(label: string): void {
        for (const map of [this.#registry, this.#held] as Map<string, unknown>[]) for (const key of [...map.keys()]) if (key.startsWith(`${label}\n`)) map.delete(key);
        for (const [key, kept] of [...this.#cache]) {
            if (!key.startsWith(`${label}\n`)) continue;
            this.#cache.delete(key);
            this.#cached -= kept.bytes.length;
        }
        this.#refused.delete(label);
    }

    /** "Getting a Skill": the current entry for one skill by the URI of its `SKILL.md`, listed or not. */
    async get(label: string, uri: string): Promise<Listed> {
        const { wire } = this.#declared(label);
        if (rootOf(uri) === undefined) throw new LocalError('that is not the URI of a SKILL.md');
        let r: Json;
        try {
            r = await this.#request(wire, 'skills/get', { uri });
        } catch (e) {
            if (errorCode(e) === -32602) throw new LocalError(`the MCP server ${JSON.stringify(label)} serves no skill at that URI`);
            throw new LocalError(`the skill's entry could not be read from ${JSON.stringify(label)}: ${describeError(e)}`);
        }
        if (r.resultType !== undefined && r.resultType !== 'complete') throw new LocalError('the server answered skills/get with something other than a complete result');
        const c = checkEntry(r.skill);
        if ('invalid' in c) throw new LocalError(`the server's entry for that skill is not valid (${c.invalid}), so it is not loaded`);
        if (c.entry.uri !== uri) throw new LocalError('the server answered skills/get with the entry of another skill');
        const listed: Listed = { label, entry: c.entry, declined: c.declined, fetchedAt: this.#o.now(), ttlMs: typeof r.ttlMs === 'number' && r.ttlMs >= 0 ? r.ttlMs : 0 };
        // A skill that never appeared in a listing enters the registry on the same terms as a listed one.
        this.#registry.set(keyOf(label, uri), listed);
        return listed;
    }

    async #read(wire: Wire, uri: string): Promise<FileContent> {
        let r: Json;
        try {
            r = await this.#request(wire, 'resources/read', { uri });
        } catch (e) {
            throw new LocalError(`${shown(uri)} could not be read from ${JSON.stringify(wire.label)}: ${describeError(e)}`);
        }
        return contentOf(r, uri);
    }

    /** One file of a skill, verified against its entry. A copy kept from an earlier read is used only for the same digest. */
    async #verified(wire: Wire, resource: SkillResource): Promise<FileContent> {
        const cacheKey = `${wire.label}\n${resource.uri}\n${resource.digest}`;
        const kept = this.#cache.get(cacheKey);
        if (kept) return kept;
        const content = await this.#read(wire, resource.uri);
        // Unverified content is not used: a failure here leaves nothing behind.
        await verifyFile(resource, content.bytes);
        if (content.bytes.length <= this.#o.cacheBytes) {
            while (this.#cached + content.bytes.length > this.#o.cacheBytes) {
                const oldest = this.#cache.entries().next().value;
                if (!oldest) break;
                this.#cache.delete(oldest[0]);
                this.#cached -= oldest[1].bytes.length;
            }
            this.#cache.set(cacheKey, content);
            this.#cached += content.bytes.length;
        }
        return content;
    }

    async #loadFrom(wire: Wire, listed: Listed): Promise<{ body: string; isVerified: boolean; retrieved: number }> {
        const { entry } = listed;
        // "Because resources is complete, both limits are checkable from the entry alone before the
        // host retrieves any file. A host that declines a skill on this basis SHOULD tell the user why."
        if (listed.declined) throw new LocalError(`this skill is not loaded: ${listed.declined}`);
        if (entry.resources === 'dynamic') {
            // No digest to check: the content is unverifiable. Its frontmatter is still compared.
            const content = await this.#read(wire, entry.uri);
            if (content.bytes.length > LIMITS.bytes) throw new LocalError(`this skill is not loaded: its SKILL.md alone is larger than the ${LIMITS.bytes} bytes a skill may hold`);
            return { body: verifyFrontmatter(entry, content.bytes), isVerified: false, retrieved: content.bytes.length };
        }
        const self = entry.resources.find((r) => r.uri === entry.uri)!;
        const content = await this.#verified(wire, self);
        return { body: verifyFrontmatter(entry, content.bytes), isVerified: true, retrieved: 0 };
    }

    /**
     * The skill-loading path: the one route by which a skill becomes active. Given the pair of
     * server and `SKILL.md` URI, it finds the entry (in the registry, or with `skills/get` for a
     * pair never listed), fetches `SKILL.md` from that server, verifies size, digest and
     * frontmatter, and from then on holds the entry: the host is acting on the skill.
     *
     * A failure against an entry that came from a listing may only mean the listing is stale, so
     * the entry is read once more with `skills/get` and the load tried again from the current one.
     * Loading a skill that is already loaded always starts from a fresh `skills/get`: that is how a
     * skill that changed on the server is picked up, under its new entry.
     */
    async load(label: string, uri: string, o: { expect?: string } = {}): Promise<Loaded> {
        const { wire, directoryRead } = this.#declared(label);
        if (rootOf(uri) === undefined) throw new LocalError('that is not the URI of a SKILL.md; a skill is loaded by the URI of its SKILL.md');
        const key = keyOf(label, uri);
        // The entry an approval was just given for is the entry to load, not a fresher one.
        const known = this.#held.has(key) && o.expect === undefined ? undefined : this.#registry.get(key);
        let listed = known ?? (await this.get(label, uri));
        const approved = async (l: Listed) => {
            // "Content-bound approval": what is loaded is the set the approval was given for, or nothing.
            if (o.expect !== undefined && (await manifestHash(l.entry)) !== o.expect) throw new LocalError('this skill changed on the server after it was put to the user for approval, so it is not loaded: load it again, and the user is asked about it as it is now');
        };
        await approved(listed);
        let loaded: { body: string; isVerified: boolean; retrieved: number };
        try {
            loaded = await this.#loadFrom(wire, listed);
        } catch (e) {
            if (!(e instanceof VerificationError) || listed !== known) throw e;
            // If the entry cannot be read again, the failure that stands is the verification failure.
            listed = await this.get(label, uri).catch(() => {
                throw e;
            });
            await approved(listed);
            loaded = await this.#loadFrom(wire, listed);
        }
        this.#held.set(key, { label, entry: listed.entry, loadedAt: this.#o.now(), retrieved: loaded.retrieved });
        return { label, entry: listed.entry, body: loaded.body, isVerified: loaded.isVerified, directoryRead, hash: await manifestHash(listed.entry) };
    }

    /**
     * The current entry for a skill, to put it to the user before it is loaded: from the registry
     * if it was listed, from `skills/get` if not. No file is fetched. A skill that is loaded is asked
     * about afresh, since loading it again takes the server's current entry.
     */
    async entry(label: string, uri: string): Promise<Listed> {
        this.#declared(label);
        if (rootOf(uri) === undefined) throw new LocalError('that is not the URI of a SKILL.md; a skill is loaded by the URI of its SKILL.md');
        const key = keyOf(label, uri);
        return (this.#held.has(key) ? undefined : this.#registry.get(key)) ?? (await this.get(label, uri));
    }

    /**
     * A skill's `SKILL.md`, verified, for the user to read before deciding about it ("Hosts SHOULD
     * let users inspect a skill's content before it is loaded"). This is not a load: nothing is
     * held, and nothing reaches the model.
     */
    async preview(label: string, uri: string): Promise<{ entry: SkillEntry; body: string; isVerified: boolean }> {
        const { wire } = this.#declared(label);
        const listed = await this.entry(label, uri);
        const { body, isVerified } = await this.#loadFrom(wire, listed);
        return { entry: listed.entry, body, isVerified };
    }

    /** The skills this session is acting on, each with the entry it was loaded from. */
    held(): Held[] {
        return [...this.#held.values()];
    }

    /** Ends the acting window of one skill, or of all. Nothing of a skill is readable after it. */
    release(label?: string, uri?: string): void {
        if (label !== undefined && uri !== undefined) this.#held.delete(keyOf(label, uri));
        else this.#held.clear();
    }

    #heldEntry(label: string, skillUri: string): Held {
        const held = this.#held.get(keyOf(label, skillUri));
        // A file is read only as part of a skill this session loaded, from the server it was loaded from.
        if (!held) throw new LocalError(`no skill at that URI on ${JSON.stringify(label)} is loaded in this session; load it first, and read its files from the server it was loaded from`);
        return held;
    }

    /**
     * Reads one file of a loaded skill. "The Acting Window and the Held Entry": the read resolves
     * only to a URI listed in the held entry, goes only to the skill's own server, and is verified
     * against the entry. A file the entry does not list is a verification failure, as a digest
     * mismatch is.
     */
    async readFile(label: string, skillUri: string, ref: string): Promise<ReadFile> {
        const held = this.#heldEntry(label, skillUri);
        const { wire } = this.#declared(label);
        const { entry } = held;
        const target = resolveRef(entry.uri, ref);
        if (target === rootOf(entry.uri)) throw new LocalError('that is the skill\'s directory, not a file');
        const isNestedSkill = target !== entry.uri && target.endsWith(SKILL_MD);
        if (entry.resources === 'dynamic') {
            // "A host that chooses to load such a skill applies the total-size limit to what it
            // actually retrieves and MAY stop loading the skill once that limit is reached."
            if (held.retrieved >= LIMITS.bytes) throw new LocalError(`no more of this skill is read: ${LIMITS.bytes} bytes of it have been retrieved, the most a skill may hold`);
            const content = await this.#read(wire, target);
            held.retrieved += content.bytes.length;
            if (held.retrieved > LIMITS.bytes) throw new LocalError(`this file is not used: with it, more than ${LIMITS.bytes} bytes of the skill would have been retrieved, the most a skill may hold`);
            return { label, skillUri, uri: target, mimeType: content.mimeType, text: textOf(content), size: content.bytes.length, isVerified: false, isNestedSkill };
        }
        const wanted = canonical(target);
        const matches = entry.resources.filter((r) => canonical(r.uri) === wanted);
        if (matches.length !== 1) {
            throw new VerificationError('unlisted', target, `${shown(target)} is not a file of this skill as it was loaded. If the skill refers to it, the skill has changed on the server since: load the skill again to use its current version`);
        }
        const content = await this.#verified(wire, matches[0]!);
        return { label, skillUri, uri: matches[0]!.uri, mimeType: content.mimeType, text: textOf(content), size: content.bytes.length, isVerified: true, isNestedSkill };
    }

    /**
     * What a directory of a loaded skill holds. For a skill with a manifest the held entry answers,
     * as "Directory Reads and the Held Entry" allows: no request is sent, and nothing the entry
     * does not list can be shown as a file of the skill. For a `"dynamic"` skill the server is asked
     * with `resources/directory/read`, and only if it declared `directoryRead: true`.
     */
    async listDirectory(label: string, skillUri: string, path = ''): Promise<{ uri: string; children: DirectoryChild[]; fromEntry: boolean }> {
        const held = this.#heldEntry(label, skillUri);
        const { entry } = held;
        const dir = resolveRef(entry.uri, path);
        if (entry.resources !== 'dynamic') {
            const prefix = `${canonical(dir)}/`;
            const children = new Map<string, DirectoryChild>();
            for (const r of entry.resources) {
                const c = canonical(r.uri);
                if (!c.startsWith(prefix)) continue;
                const rest = c.slice(prefix.length);
                const slash = rest.indexOf('/');
                const name = slash < 0 ? rest : rest.slice(0, slash);
                if (slash < 0) children.set(name, { uri: r.uri, name, isDirectory: false, size: r.size });
                else if (!children.has(name)) children.set(name, { uri: `${dir}/${name}`, name, isDirectory: true });
            }
            if (!children.size) throw new LocalError('this skill, as it was loaded, has no such directory');
            return { uri: dir, children: [...children.values()], fromEntry: true };
        }
        const { wire, directoryRead } = this.#declared(label);
        // "Clients MUST NOT call resources/directory/read against a server that has not declared directoryRead: true."
        if (!directoryRead) throw new LocalError(`the MCP server ${JSON.stringify(label)} has not declared that it lists directories, and this skill publishes no list of its files, so its directories cannot be listed`);
        const children: DirectoryChild[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < this.#o.maxPages; page++) {
            let r: Json;
            try {
                r = await this.#request(wire, 'resources/directory/read', cursor === undefined ? { uri: dir } : { uri: dir, cursor });
            } catch (e) {
                throw new LocalError(errorCode(e) === -32602 ? 'the server says that is not a directory it serves' : `the directory could not be read: ${describeError(e)}`);
            }
            if (!Array.isArray(r.resources)) throw new LocalError('the server answered the directory read without a list');
            for (const c of r.resources) {
                // A direct child of the directory asked about, and nothing else.
                if (!isObject(c) || typeof c.uri !== 'string' || !c.uri.startsWith(`${dir}/`) || c.uri.slice(dir.length + 1).includes('/') || c.uri.length > 2048 || UNSAFE_TEXT.test(c.uri)) continue;
                children.push({ uri: c.uri, name: c.uri.slice(dir.length + 1), isDirectory: c.mimeType === DIRECTORY_MIME, mimeType: typeof c.mimeType === 'string' ? c.mimeType.slice(0, 100) : undefined, size: typeof c.size === 'number' && c.size >= 0 ? c.size : undefined });
                if (children.length >= 2000) break;
            }
            cursor = typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined;
            if (cursor === undefined || children.length >= 2000) break;
        }
        return { uri: dir, children, fromEntry: false };
    }
}

/** A file's text, when the server sent text or the bytes are text; nothing for a binary file. */
function textOf(content: FileContent): string | undefined {
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(content.bytes);
        // eslint-disable-next-line no-control-regex
        return /[\u0000-\u0008\u000e-\u001a]/.test(text) ? undefined : text;
    } catch {
        return undefined;
    }
}
