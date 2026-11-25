import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkEntry, manifestHash, rootOf, SkillsHost, type SkillEntry } from '../../core/src/skills.ts';
import { Connection, fingerprintOf } from '../../core/src/wire.ts';
import { describeError, LocalError, secrets } from '../../core/src/untrusted.ts';
import { Store, type Approval } from '../../codex/src/store.ts';
import { plain } from './stubs.ts';
import { digestOf, ownArgs, writePrivate, type Handler } from '../../../server-cards/antigravity/src/gate.ts';
import { heldServers } from './held.ts';
import { isOff, readConfig, SIGN_IN, VERSION } from './config.ts';

// Whole-name match, including the plugin AND its MCP key. No arbitrary prefix/suffix.
export const MATCHER = 'mcp_+mcp[-_]skills_skills[_/.](load_skill|read_skill_file|list_skill_directory)';
export const matchesTool = (name: string) => new RegExp(`^(?:${MATCHER})$`).test(name);
export const CLIENT = { name: 'mcp-skills-antigravity', version: VERSION };
export function textArg(args: Record<string, unknown>, key: string): string {
    const v = args[key];
    if (typeof v !== 'string' || !v.trim() || v.length > 4096) throw new LocalError(`"${key}" is required and must be at most 4096 characters`);
    if (v !== v.trim()) throw new LocalError(`"${key}" has spaces or line breaks around it, so it names no skill`);
    return v;
}
export const readDigest = (tool: string, args: Record<string, unknown>, fingerprint: string) => digestOf({ tool, args: ownArgs(args), fingerprint });

export async function versionOf(server: string, entry: SkillEntry, fingerprint: string) {
    const hash = await manifestHash(entry);
    const approval: Approval | undefined = hash ? { server, uri: entry.uri, fingerprint, hash } : undefined;
    // Includes frontmatter and size too: even a dynamic entry's metadata must be the one asked about.
    return { approval, digest: digestOf({ server, fingerprint, entry }), hash };
}

/** Snapshot contains validated metadata, never file text or configured credentials. */
export function shareEntry(dir: string, server: string, entry: SkillEntry, fingerprint: string) {
    writePrivate(join(dir, `entry-${digestOf({ server, uri: entry.uri })}.json`), JSON.stringify({ server, fingerprint, entry }));
}

export function preparedEntry(dir: string, server: string, uri: string, fingerprint: string): SkillEntry {
    let raw;
    try { raw = JSON.parse(readFileSync(join(dir, `entry-${digestOf({ server, uri })}.json`), 'utf8')); }
    catch { throw new LocalError('the hook did not share the skill version for this call'); }
    const c = checkEntry(raw?.entry);
    if (raw?.server !== server || raw?.fingerprint !== fingerprint || !('entry' in c) || c.entry.uri !== uri || c.declined) throw new LocalError('the skill version shared by the hook is invalid or the server moved');
    return c.entry;
}

function nestedIn(dir: string, server: string, uri: string): string | undefined {
    try {
        const entries: unknown = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));
        if (!Array.isArray(entries)) return;
        for (const l of entries) {
            const checked = checkEntry(l?.entry);
            if (l?.label === server && 'entry' in checked && checked.entry.uri !== uri && rootOf(uri)?.startsWith(`${rootOf(checked.entry.uri)}/`)) return checked.entry.frontmatter.name;
        }
    } catch {}
}

export function question(server: string, entry: SkillEntry, store: Store): string {
    const resources = entry.resources === 'dynamic' ? [] : entry.resources;
    const nested = nestedIn(store.dir, server, entry.uri);
    return [
        // The CLI's card shows a question's first two lines and hides the rest (CLI 1.5.17).
        `Load the skill ${JSON.stringify(entry.frontmatter.name)} from the MCP server ${JSON.stringify(server)}?`,
        `${store.wasApproved(server, entry.uri) ? 'It has changed on the server (or the server has moved) since you last approved it' : 'This is a new skill approval: you have not approved this version before'} · URI ${entry.uri}`,
        entry.resources === 'dynamic' ? 'The server generates its content and publishes no digests, so it cannot be verified. Approval is required at every load.' : `${resources.length} files, ${resources.reduce((n, r) => n + r.size, 0)} bytes; each is checked against the server\'s SHA-256 digest when read.`,
        ...(nested ? [`It is nested inside the skill ${JSON.stringify(nested)}; approving that one does not approve this one.`] : []),
        `The server's description (untrusted): ${plain(entry.frontmatter.description, 600)}`,
        'This is server content, not a local skill. Loading grants no permissions; subsequent actions use your usual Antigravity approvals.',
        'Approve or decline. This approval card cannot privately preview SKILL.md. You can decline, inspect the publisher\'s source outside the model, and try again; list_skills can show its origin, URI and description.'
    ].join('\n');
}

/**
 * Rule X8: once a skill served by one MCP server is loaded in a conversation, a resource read from
 * another server is put to the person first, naming both, as the Pi and OpenCode forms do. It
 * can't tell which skill (or whether one) asked for it. Antigravity's agent reads MCP resources
 * with its `read_resource` tool ({ServerName, Uri}; CLI 1.5.17), which the plugin's
 * PreToolUse hook sees. The answer is `force_ask` or the plain `allow`; the call is never altered.
 */
export function crossServerRead(input: Record<string, unknown>, store: Store, env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
    const call = input.toolCall as { name?: unknown; args?: unknown } | undefined;
    if (call?.name !== 'read_resource' || typeof input.conversationId !== 'string') return undefined;
    const args = (call.args && typeof call.args === 'object' ? call.args : {}) as Record<string, unknown>;
    const target = typeof args.ServerName === 'string' ? args.ServerName : '';
    const held = heldServers(store.dir, input.conversationId);
    const others = held.filter(s => s !== target);
    if (!held.length || !others.length || isOff(env, store)) return undefined;
    readConfig(env, store); // registers the configuration's secrets with the redactor
    const uri = plain(typeof args.Uri === 'string' ? args.Uri : '', 300);
    return {
        decision: 'force_ask',
        reason: secrets.scrub([
            `A skill served by the MCP server ${others.map(s => JSON.stringify(s)).join(', ')} is loaded in this conversation, and the agent wants to read ${uri ? `the resource ${uri}` : 'a resource'} from ${target ? `the MCP server ${JSON.stringify(plain(target, 64))}` : 'another MCP server'}.`,
            "The loaded skill's text may be what asks for it. Allow it only if it is what you want.",
        ].join('\n')),
    };
}

/** Fresh metadata via the shared core, independent of the MCP server process. No resources/read. */
export function handlers(env: NodeJS.ProcessEnv, store: Store): Record<string, Handler> {
    const handle = (tool: string): Handler => async (args, input) => {
        if (!matchesTool(String(input.toolCall?.name ?? ''))) return { deny: 'This tool is not part of the mcp-skills plugin.' };
        if (typeof input.conversationId !== 'string' || !input.conversationId || input.conversationId.length > 200) return { deny: 'Antigravity did not identify the conversation.' };
        if (isOff(env, store)) return { deny: 'mcp-skills is turned off.' };
        try {
            const server = textArg(args, 'server');
            const table = readConfig(env, store), cfg = table.servers[server];
            if (!cfg) return { deny: table.skipped[server] ?? `no MCP server named ${JSON.stringify(server)} serves skills in this session` };
            const fingerprint = fingerprintOf(cfg);
            if (tool !== 'load_skill') {
                textArg(args, 'skill');
                if (tool === 'read_skill_file') textArg(args, 'path');
                return { pass: 'Read only within a skill this conversation loaded and approved.', digest: readDigest(tool, args, fingerprint) };
            }
            const uri = textArg(args, 'uri');
            if (rootOf(uri) === undefined) throw new LocalError('that is not the URI of a SKILL.md');
            const c = new Connection(server, cfg, { client: CLIENT, signInNote: SIGN_IN });
            try {
                try { await c.connect(8000); } catch { throw new LocalError(c.error ?? 'the server is not reachable'); }
                const host = new SkillsHost(label => label === server ? c : undefined, { requestTimeoutMs: 8000 });
                // The entry as the server lists it, as the core's load finds one; skills/get only for a
                // skill the listing doesn't hold (a server need not answer skills/get for a listed one:
                // the upstream suite's fixture doesn't). The server process re-checks at load.
                await host.list(server);
                const listed = host.listed(server).find(l => l.entry.uri === uri) ?? await host.get(server, uri);
                if (listed.declined) return { deny: `this skill is not loaded: ${listed.declined}` };
                shareEntry(store.dir, server, listed.entry, fingerprint);
                const v = await versionOf(server, listed.entry, fingerprint);
                return v.approval && store.isApproved(v.approval)
                    ? { pass: 'The user approved this exact skill version and server location earlier.', digest: v.digest }
                    : { ask: secrets.scrub(question(server, listed.entry, store)), digest: v.digest };
            } finally { await c.close(); }
        } catch (e) { return { deny: `The skill is not loaded: ${describeError(e)}` }; }
    };
    return Object.fromEntries(['load_skill', 'read_skill_file', 'list_skill_directory'].map(tool => [tool, handle(tool)]));
}
