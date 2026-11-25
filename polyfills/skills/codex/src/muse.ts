// The same helper in Muse Code (Meta's terminal agent), where the plugin folder's
// .muse-plugin/plugin.json starts it with `--host=muse`.
//
// What differs from Codex:
//
//   - The servers: Muse's user settings (~/.config/muse/settings.json), read as mcp-events'
//     Muse form reads them (polyfills/events/codex/src/muse-config.ts).
//   - Where the stubs go. Muse lists a SKILL.md one folder below one of its skill folders,
//     never deeper, so the stubs go flat into Muse's own, ~/.config/muse/skills, each in a
//     folder whose name starts with `mcp-skills-served--`. Codex does not read that folder.
//   - Asking the person. Muse gives a plugin no way to put a question to them: its MCP client
//     offers no elicitation, and a tool call that is not read-only, or a hook's "ask", goes to
//     Muse's approval judge, a model that may approve it with nobody asked. What only the person
//     can do is type their own message: Muse runs a plugin's UserPromptSubmit hook for those, and
//     not for a turn that Muse's timers or a model start. So load_skill answers with the question
//     and a short code; the person who wants the skill sends a message that is exactly
//     `load <code>`, the plugin's hook records it, and the next load_skill call of that session
//     loads it. An approval is kept as in Codex: the same skill, unchanged, loads without the
//     question afterwards.

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { museConfigDir, readMuseSettings } from '../../../events/codex/src/muse-config.ts';
import { rootOf } from '../../core/src/skills.ts';
import type { ServerTable } from '../../core/src/upstream.ts';
import { CONFIRM_TTL_MS, confirmFromPrompt, confirmPhrase, museAsk, museStoreDir } from './muse-confirm.ts';
import { labelDir, lockStubs, MAX_STUBS, realDir, removePath, renderStub, stubNames, writeIfChanged, type StubSync } from './stubs.ts';

/** True when the helper was started by the Muse manifest. */
export const isMuse = (argv: readonly string[] = process.argv): boolean => argv.includes('--host=muse');

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Muse session this process serves (MUSE_SESSION_ID), or undefined. */
export function museSession(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const id = env.MUSE_SESSION_ID?.trim();
    return id && SESSION_ID.test(id) ? id.toLowerCase() : undefined;
}

/** Muse's own skill folder, which Codex does not read. */
export const museStubRoot = (env: NodeJS.ProcessEnv = process.env): string => join(museConfigDir(env), 'skills');

/** This plugin's own helper, if someone added it to Muse's settings by hand: connecting to it would loop. */
const isSelf = (arg: string) => /mcp-skills[^\\/]*(?:[\\/][^\\/]+){0,4}[\\/]dist[\\/]helper\.js$/.test(arg) || /[\\/]skills[\\/]codex[\\/](?:mod[\\/]dist[\\/]helper\.js|src[\\/]helper\.ts)$/.test(arg);

/** The servers to look at in Muse, narrowed by the plugin's settings.json (`servers`, `skip`). */
export function readMuseSkillsConfig(env: NodeJS.ProcessEnv, o: { only?: string[]; skip?: string[] } = {}): { table: ServerTable; file: string } {
    const r = readMuseSettings(env, { file: env.MCP_SKILLS_CONFIG, only: o.only, skip: o.skip, isSelf });
    return { table: { servers: r.servers, skipped: r.skipped }, file: r.file };
}

export { CONFIRM_TTL_MS, confirmFromPrompt, confirmPhrase, museAsk, museStoreDir };

// ---- Stubs, flat ----

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const FLAT_PREFIX = 'mcp-skills-served--';
const FLAT_DIR = /^mcp-skills-served--([a-z0-9][a-z0-9_-]{0,63}-[0-9a-f]{6})--([0-9a-f]{16})$/;
/** The folder of one served skill's stub, directly in Muse's skill folder. */
export const flatStubDir = (root: string, label: string, uri: string): string => join(root, `${FLAT_PREFIX}${labelDir(label)}--${sha256(uri).slice(0, 16)}`);

/**
 * syncStubs (stubs.ts) for Muse: the same stubs, one folder each directly in `root`. Only folders
 * of this plugin's shape are written or removed; those of servers in `keep` are left as they are.
 */
export function syncFlatStubs(root: string, s: StubSync): { written: number; removed: number; omitted: number } {
    mkdirSync(root, { recursive: true });
    const unlock = lockStubs(root, `.${FLAT_PREFIX}lock`);
    let written = 0;
    let removed = 0;
    let omitted = 0;
    try {
        const all = [...s.listed.values()].flat().filter((l) => !l.declined && rootOf(l.entry.uri) !== undefined);
        const shown = all.slice(0, MAX_STUBS);
        omitted = all.length - shown.length;
        const names = stubNames(shown);
        const wanted = new Set<string>();
        for (const l of shown) {
            const dir = flatStubDir(root, l.label, l.entry.uri);
            wanted.add(dir.slice(root.length + 1));
            realDir(dir);
            if (writeIfChanged(join(dir, 'SKILL.md'), renderStub(l, names.get(l)!))) written++;
        }
        const listedLabels = new Set([...s.listed.keys()].map(labelDir));
        const kept = new Set([...s.keep].map(labelDir));
        for (const entry of readdirSync(root)) {
            const m = FLAT_DIR.exec(entry);
            if (!m || wanted.has(entry)) continue;
            // A server not read this time keeps its stubs while it is configured but not reachable.
            if (!listedLabels.has(m[1]!) && kept.has(m[1]!)) continue;
            removePath(join(root, entry));
            removed++;
        }
    } finally {
        unlock();
    }
    return { written, removed, omitted };
}

/** The plugin's words, as Muse users see them: Muse in place of Codex, and Muse's commands and files. */
export function museWords(s: string): string {
    return s
        .replaceAll('codex mcp login', 'muse mcp login')
        .replaceAll('http_headers in config.toml', "headers in Muse's settings.json")
        .replaceAll('your usual Codex approvals', "Muse's usual approvals")
        .replaceAll("user's Codex config", "user's Muse settings")
        .replaceAll('Codex', 'Muse');
}
