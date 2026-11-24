// How Codex comes to list the skills your MCP servers serve, natively.
//
// Codex lists every SKILL.md it finds in its skill folders, and a plugin's own
// `skills/` folder is one of them. For each served skill, the helper writes a
// short SKILL.md of its own into that folder, under `served/`:
//
//   <plugin>/skills/served/<server>-<6 hex>/<16 hex of the skill's URI>/SKILL.md
//
// It holds the skill's name (as `<server>:<name>`), its description from the
// server's listing (marked with the server's name), and a body in the plugin's
// own words that says how to load the skill: with the load_skill tool, which asks
// the user, fetches the skill from its server and verifies it. No file of the skill
// is fetched to write it, and none of its content is written to disk: what a
// server sends in its listing is all it uses ("Lazy Retrieval"), and nothing of a
// skill gains a local file's standing by being on disk.
//
// The path carries the server's identity (its name in your config, and a hash of the
// exact name, so two names that differ only in case never share a folder) and the
// skill's URI (a hash, so nothing of a URI is used as a path). The folder is the
// plugin's own: nothing outside `served/` is touched, nothing in it but these
// folders, and only folders whose names have this shape are removed. A symbolic link
// found there is removed, never followed.

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rootOf, type Listed } from '../../core/src/skills.ts';
import { oneLine } from '../../core/src/untrusted.ts';
import { PLUGIN } from './version.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** The most served skills written for Codex to list. More are still reachable with list_skills. */
export const MAX_STUBS = 100;
const LABEL_DIR = /^[a-z0-9][a-z0-9_-]{0,63}-[0-9a-f]{6}$/;
const SKILL_DIR = /^[0-9a-f]{16}$/;
const NAME_LIMIT = 64;

export const labelDir = (label: string): string => `${label.toLowerCase()}-${sha256(label).slice(0, 6)}`;
export const stubDir = (root: string, label: string, uri: string): string => join(root, labelDir(label), sha256(uri).slice(0, 16));
export const stubPath = (root: string, label: string, uri: string): string => join(stubDir(root, label, uri), 'SKILL.md');

/** Removes what text must not carry into a listing: control, zero-width and direction-changing characters. */
export function plain(text: unknown, max: number): string {
    // eslint-disable-next-line no-misleading-character-class
    const cleaned = String(text ?? '').replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿؜᠎]/g, '');
    return oneLine(cleaned.toWellFormed(), max);
}

/**
 * The name each listed skill goes by in Codex, `<server>:<name>` (Codex adds the plugin's name in
 * front). Two skills of one server with the same name each get a part of their URI's hash, so
 * neither is dropped or preferred; a name too long for Codex is cut and given the same.
 */
export function stubNames(skills: Listed[]): Map<Listed, string> {
    const out = new Map<Listed, string>();
    const count = new Map<string, number>();
    for (const l of skills) count.set(`${l.label}:${l.entry.frontmatter.name}`, (count.get(`${l.label}:${l.entry.frontmatter.name}`) ?? 0) + 1);
    for (const l of skills) {
        const base = `${l.label}:${l.entry.frontmatter.name}`;
        const tag = sha256(l.entry.uri).slice(0, 6);
        const name = (count.get(base) ?? 0) > 1 || base.length > NAME_LIMIT ? `${base.slice(0, NAME_LIMIT - 7)}-${tag}` : base;
        out.set(l, name);
    }
    return out;
}

/** The SKILL.md written for one served skill. Everything but the description is this plugin's own text. */
export function renderStub(l: Listed, name: string): string {
    const q = JSON.stringify;
    const description = `[MCP server ${q(l.label)}, not a local skill] ${plain(l.entry.frontmatter.description, 900)}`;
    return [
        '---',
        `name: ${q(name)}`,
        `description: ${q(description)}`,
        '---',
        '',
        `# ${l.entry.frontmatter.name}, served by the MCP server ${q(l.label)}`,
        '',
        `This skill is not on this computer. The MCP server ${q(l.label)} serves it over the MCP Skills extension, and this file only says how to load it. Its description above is that server's text.`,
        '',
        `To use it, call the \`load_skill\` tool of the \`${PLUGIN}\` MCP server with exactly these arguments:`,
        '',
        '```json',
        JSON.stringify({ server: l.label, uri: l.entry.uri }, null, 2),
        '```',
        '',
        'That tool asks the user first, then fetches the skill from that server, checks it against the digests the server published, and returns its text marked with where it came from. Read the files the skill refers to with `read_skill_file` (same server, the skill\'s URI, and the path), not from this folder: they are not here.',
        '',
        'If the tool is not there, or the user does not approve the skill, say so and go on without it.',
        ''
    ].join('\n');
}

export type StubSync = {
    /** Each server whose listing was read this time, with the skills to write for it. */
    listed: Map<string, Listed[]>;
    /** Servers whose skills stay as they were written before (configured, but not reachable now). */
    keep: Set<string>;
};

function lock(root: string): () => void {
    const dir = join(root, '.lock');
    for (let i = 0; i < 40; i++) {
        try {
            mkdirSync(dir);
            return () => {
                try {
                    rmdirSync(dir);
                } catch {
                    // already gone
                }
            };
        } catch {
            try {
                // Another session's helper is writing. A lock older than 30 seconds was left behind.
                if (Date.now() - statSync(dir).mtimeMs > 30_000) rmdirSync(dir);
            } catch {
                // gone meanwhile
            }
            // A short wait; this runs rarely, when a session's listing changes.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
    }
    return () => {};
}

function remove(path: string): void {
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isSymbolicLink() || !st.isDirectory()) unlinkSync(path);
    else rmSync(path, { recursive: true, force: true });
}

function writeIfChanged(path: string, text: string): boolean {
    try {
        if (!lstatSync(path).isSymbolicLink() && readFileSync(path, 'utf8') === text) return false;
    } catch {
        // not there yet
    }
    const tmp = join(path, '..', `.SKILL.md.${process.pid}.tmp`);
    writeFileSync(tmp, text, { mode: 0o644 });
    renameSync(tmp, path);
    return true;
}

/**
 * Makes `root` hold exactly the stubs for what was listed, at most MAX_STUBS in all: writes what is
 * new or changed, removes what is no longer served, and leaves alone the folders of the servers in
 * `keep`. Says how many files it wrote and how many folders it removed.
 */
/** A real folder at `path`: whatever else is there (a file, a symbolic link) is removed first. */
function realDir(path: string): void {
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (st && (st.isSymbolicLink() || !st.isDirectory())) remove(path);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) mkdirSync(path);
}

export function syncStubs(root: string, s: StubSync): { written: number; removed: number; omitted: number } {
    mkdirSync(join(root, '..'), { recursive: true });
    realDir(root);
    const unlock = lock(root);
    let written = 0;
    let removed = 0;
    let omitted = 0;
    try {
        const all = [...s.listed.values()].flat().filter((l) => !l.declined && rootOf(l.entry.uri) !== undefined);
        const shown = all.slice(0, MAX_STUBS);
        omitted = all.length - shown.length;
        const names = stubNames(shown);
        const wanted = new Map<string, Set<string>>();
        for (const label of s.listed.keys()) wanted.set(labelDir(label), new Set());
        for (const l of shown) {
            realDir(join(root, labelDir(l.label)));
            const dir = stubDir(root, l.label, l.entry.uri);
            wanted.get(labelDir(l.label))!.add(sha256(l.entry.uri).slice(0, 16));
            realDir(dir);
            if (writeIfChanged(join(dir, 'SKILL.md'), renderStub(l, names.get(l)!))) written++;
        }
        const kept = new Set([...s.keep].map(labelDir));
        for (const entry of readdirSync(root, { withFileTypes: true })) {
            if (!LABEL_DIR.test(entry.name)) continue;
            const path = join(root, entry.name);
            const want = wanted.get(entry.name);
            if (!want) {
                if (kept.has(entry.name)) continue;
                remove(path);
                removed++;
                continue;
            }
            if (entry.isSymbolicLink() || !entry.isDirectory()) {
                remove(path);
                removed++;
                continue;
            }
            for (const skill of readdirSync(path)) {
                if (!SKILL_DIR.test(skill) || want.has(skill)) continue;
                remove(join(path, skill));
                removed++;
            }
        }
    } finally {
        unlock();
    }
    return { written, removed, omitted };
}
