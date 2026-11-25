import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rootOf, type Listed } from '../../core/src/skills.ts';
import { MAX_STUBS, plain as plainText } from '../../codex/src/stubs.ts';
import { secrets } from '../../core/src/untrusted.ts';

/**
 * What a server wrote, as a stub or a listing shows it: plain, one line, and with no secret of the
 * configuration in it. Cleaned first, then scrubbed, then cut: a secret split
 * by a character that shows as nothing is joined again before the scrub looks for it.
 */
export const plain = (s: unknown, max: number) => plainText(secrets.scrub(plainText(s, 1_000_000)), max);
export { MAX_STUBS };

export const SHAPE = /^mcp-skills-served--[a-z0-9][a-z0-9_-]{0,19}-[0-9a-f]{6}--[0-9a-f]{16}$/;
const hash = (s: string, n: number) => createHash('sha256').update(s).digest('hex').slice(0, n);
const prefix = (label: string) => `mcp-skills-served--${label.toLowerCase().slice(0, 20)}-${hash(label, 6)}--`;
export const stubName = (label: string, uri: string) => `${prefix(label)}${hash(uri, 16)}`;
export const stubRootOf = (home: string) => join(home, '.gemini', 'config', 'skills');
export const stubPath = (root: string, label: string, uri: string) => join(root, stubName(label, uri), 'SKILL.md');

/** Serialize writers without adding a lock file to Antigravity's shared skills root. */
export function withStubLock<T>(state: string, write: () => T): T {
    const dir = join(state, 'stubs.lock');
    for (let i = 0; i < 40; i++) {
        try { mkdirSync(dir, { mode: 0o700 }); }
        catch {
            try { if (Date.now() - statSync(dir).mtimeMs > 30000) rmdirSync(dir); } catch {}
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
            continue;
        }
        try { return write(); } finally { rmdirSync(dir); }
    }
    throw new Error('another process is updating skill stubs; try again');
}

export function renderStub(l: Listed): string {
    return [
        '---', `name: ${JSON.stringify(stubName(l.label, l.entry.uri))}`,
        `description: ${JSON.stringify(`[MCP server ${JSON.stringify(l.label)}, not a local skill] ${plain(l.entry.frontmatter.description, 900)}`)}`, '---', '',
        `# ${l.entry.frontmatter.name}, served by MCP server ${JSON.stringify(l.label)}`, '',
        `This skill is not on this computer. The MCP server ${JSON.stringify(l.label)} serves it. The description above is that server's text; this file only says how to load it.`, '',
        'In Antigravity, call the `load_skill` tool of the `mcp-skills` plugin (MCP server `mcp-skills_skills`) with these arguments:', '',
        '```json', JSON.stringify({ server: l.label, uri: l.entry.uri }, null, 2), '```', '',
        'The tool asks the user before loading a new or changed skill, verifies its files, and returns server content with no authority of its own. Read its supporting files using `read_skill_file`, and folders with `list_skill_directory`, using the same server and skill URI. Nothing is stored here.', '',
        'If this plugin is unavailable or approval is declined, continue without the skill. Other programs reading this folder cannot load it through this stub.', ''
    ].join('\n').split('\n').map(line => secrets.scrub(line)).join('\n');
}

/** Writes only exact-shape folders, directly in the shared discovery root. Never follows a stub symlink. */
export function syncStubs(root: string, listed: Listed[], keep = new Set<string>()) {
    const st = lstatSync(root, { throwIfNoEntry: false });
    if (st && (!st.isDirectory() || st.isSymbolicLink())) throw new Error('the skills root is not a real directory');
    mkdirSync(root, { recursive: true });
    const existing = readdirSync(root).filter(n => SHAPE.test(n));
    const kept = existing.filter(n => lstatSync(join(root, n)).isDirectory() && [...keep].some(label => n.startsWith(prefix(label)))).sort().slice(0, MAX_STUBS);
    const all = listed.filter(l => !l.declined && rootOf(l.entry.uri));
    const shown = all.slice(0, Math.max(0, MAX_STUBS - kept.length));
    const wanted = new Set([...kept, ...shown.map(l => stubName(l.label, l.entry.uri))]);
    let written = 0, removed = 0;
    for (const l of shown) {
        const name = stubName(l.label, l.entry.uri);
        if (!SHAPE.test(name)) continue;
        const dir = join(root, name);
        const d = lstatSync(dir, { throwIfNoEntry: false });
        if (d && (!d.isDirectory() || d.isSymbolicLink())) rmSync(dir, { force: true });
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = join(dir, 'SKILL.md'), text = renderStub(l);
        try { if (!lstatSync(file).isSymbolicLink() && readFileSync(file, 'utf8') === text) continue; } catch {}
        const tmp = join(dir, `.SKILL.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
        writeFileSync(tmp, text, { mode: 0o600 });
        renameSync(tmp, file);
        written++;
    }
    for (const name of existing) if (!wanted.has(name)) { rmSync(join(root, name), { recursive: true, force: true }); removed++; }
    return { written, removed, omitted: all.length - shown.length };
}
