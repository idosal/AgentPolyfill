// How Hermes comes to list the skills your MCP servers serve.
//
// A Hermes plugin adds a skill with ctx.register_skill(name, path): Hermes lists it as
// `mcp-skills:<name>` with the user's other skills and shows the file at `path` when the
// model views it. For each served skill this helper writes a short SKILL.md of its own,
//
//   $HERMES_HOME/mcp-skills/stubs/<name>/SKILL.md      (<name> = <server>-<skill name>)
//
// and an index of them (stubs/index.json), which the plugin's Python half registers: at
// once for a running gateway (Hermes lists a skill added that way from the next session
// on), and from the index when the gateway next starts (so the first session lists them).
//
// A stub holds the name, the server's description marked with the server, and a body in
// the plugin's own words that says how to load the skill: with the load_skill tool, which
// Hermes asks the user about, and which fetches the skill from its server and verifies it.
// Nothing of a skill's content is fetched to write a stub or written to disk.

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rootOf, type Listed } from '../../core/src/skills.ts';
import { plain } from '../../codex/src/stubs.ts';
import { PLUGIN } from './words.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** The most served skills listed. More are still reachable with list_skills. */
export const MAX_STUBS = 100;
const NAME_LIMIT = 64;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

export type Stub = { name: string; path: string; description: string; server: string; uri: string };

/**
 * The name each listed skill goes by in Hermes (`<server>-<name>`, as `mcp-skills:` prefixes it):
 * only letters, digits, `-` and `_`. Names are unique after every step (cleaning, cutting, the
 * suffix, case), so no skill's stub can take another's name: two that would share one both get a
 * part of a digest of their server and URI, longer each round, until none do.
 */
export function stubNames(skills: Listed[]): Map<Listed, string> {
    const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
    const tagOf = (l: Listed) => sha256(`${l.label}\n${l.entry.uri}`);
    const names = new Map<Listed, string>(skills.map((l) => {
        const base = clean(`${l.label}-${l.entry.frontmatter.name}`) || 'skill';
        return [l, base.length > NAME_LIMIT ? `${base.slice(0, NAME_LIMIT - 9)}-${tagOf(l).slice(0, 8)}` : base];
    }));
    for (let tagLength = 8; tagLength <= 24; tagLength += 4) {
        const seen = new Map<string, Listed[]>();
        for (const [l, n] of names) seen.set(n.toLowerCase(), [...(seen.get(n.toLowerCase()) ?? []), l]);
        const clashing = [...seen.values()].filter((g) => g.length > 1).flat();
        if (!clashing.length) break;
        for (const l of clashing) {
            const base = clean(`${l.label}-${l.entry.frontmatter.name}`) || 'skill';
            names.set(l, `${base.slice(0, NAME_LIMIT - tagLength - 1)}-${tagOf(l).slice(0, tagLength)}`);
        }
    }
    return names;
}

/**
 * A server's text as it goes into Hermes's list of skills, which is part of the system prompt: no
 * control or invisible characters (plain), and no angle brackets, so it can't open or close a tag
 * of the prompt around it.
 */
export const promptSafe = (text: unknown, max: number): string => plain(text, max).replace(/</g, '\u2039').replace(/>/g, '\u203a');

export function renderStub(l: Listed, name: string): string {
    const q = JSON.stringify;
    const description = `[MCP server ${q(l.label)}, not a local skill] ${promptSafe(l.entry.frontmatter.description, 900)}`;
    return [
        '---',
        `name: ${q(name)}`,
        `description: ${q(description)}`,
        '---',
        '',
        `# ${promptSafe(l.entry.frontmatter.name, 64)}, served by the MCP server ${q(l.label)}`,
        '',
        `This skill is not on this computer. The MCP server ${q(l.label)} serves it over the MCP Skills extension, and this file only says how to load it. Its description above is that server's text.`,
        '',
        `To use it, call the \`load_skill\` tool (from the ${PLUGIN} plugin) with exactly these arguments:`,
        '',
        '```json',
        JSON.stringify({ server: l.label, uri: l.entry.uri }, null, 2),
        '```',
        '',
        "Hermes asks the user first. The tool then fetches the skill from that server, checks it against the digests the server published, and returns its text marked with where it came from. Read the files the skill refers to with `read_skill_file` (same server, the skill's URI, and the path): they are not on this computer.",
        '',
        'If the tool is not there, or the user does not approve the skill, say so and go on without it.',
        ''
    ].join('\n');
}

function writeIfChanged(path: string, text: string): boolean {
    try {
        if (!lstatSync(path).isSymbolicLink() && readFileSync(path, 'utf8') === text) return false;
    } catch {
        // not there yet
    }
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o644 });
    renameSync(tmp, path);
    return true;
}

/**
 * Makes `root` hold exactly the stubs for `listed` (at most MAX_STUBS), keeps the stubs of the
 * servers in `keep` (configured, but not reachable now), removes the rest, and writes the index.
 * Only folders whose names a stub could have are touched; a symbolic link is removed, never followed.
 */
export function syncStubs(root: string, listed: Listed[], keep: Set<string>): { stubs: Stub[]; written: number; removed: number; omitted: number } {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    let before: Stub[] = [];
    try {
        const j = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as unknown;
        if (Array.isArray(j)) before = j.filter((s): s is Stub => typeof s?.name === 'string' && NAME.test(s.name) && typeof s.server === 'string' && typeof s.uri === 'string');
    } catch {
        // none yet
    }
    const all = listed.filter((l) => !l.declined && rootOf(l.entry.uri) !== undefined);
    const shown = all.slice(0, MAX_STUBS);
    const names = stubNames(shown);
    const stubs: Stub[] = [];
    let written = 0;
    for (const l of shown) {
        const name = names.get(l)!;
        const dir = join(root, name);
        const st = lstatSync(dir, { throwIfNoEntry: false });
        if (st && (st.isSymbolicLink() || !st.isDirectory())) rmSync(dir, { force: true });
        mkdirSync(dir, { recursive: true });
        const path = join(dir, 'SKILL.md');
        if (writeIfChanged(path, renderStub(l, name))) written++;
        stubs.push({ name, path, description: `[MCP server ${JSON.stringify(l.label)}] ${promptSafe(l.entry.frontmatter.description, 300)}`, server: l.label, uri: l.entry.uri });
    }
    const have = new Set(stubs.map((s) => s.name));
    for (const s of before) {
        if (have.has(s.name) || !keep.has(s.server)) continue;
        have.add(s.name);
        stubs.push(s);
    }
    let removed = 0;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!NAME.test(entry.name) || have.has(entry.name)) continue;
        rmSync(join(root, entry.name), { recursive: true, force: true });
        removed++;
    }
    writeIfChanged(join(root, 'index.json'), JSON.stringify(stubs, null, 2) + '\n');
    return { stubs, written, removed, omitted: all.length - shown.length };
}
