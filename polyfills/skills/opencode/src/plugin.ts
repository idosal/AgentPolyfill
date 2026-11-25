// mcp-skills for OpenCode: a V2 server plugin.
//
// OpenCode loads it into its server, once per location (project folder). It
// connects to the MCP servers in OpenCode's configuration, keeps those that
// declare the Skills extension (SEP-2640), and adds each skill they serve to
// OpenCode's own skill list with `ctx.skill.transform`, as a short entry that
// holds no text of the skill's: the server's description, marked with the
// server, and how to load it. Loading goes through the plugin's `load_skill`
// tool, which puts it to OpenCode's permission rules (`ctx.permission.assert`)
// before anything of the skill is fetched; then the skill's text, checked
// against the server's digests, reaches the model as that server's content.
//
// Once a session has loaded a served skill, a read of another server's
// resource with OpenCode's own `read_mcp_resource` is put to OpenCode's rules
// too, naming both servers (SEP-2640's X8).

import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rootOf } from '../../core/src/skills.ts';
import { oneLine, secrets } from '../../core/src/untrusted.ts';
import { App } from './app.ts';
import { askByDefault, askByDefaultOff } from './consent.ts';
import { OpenCodeServers } from './config.ts';
import type { Context, Plugin, ToolCallContext } from './opencode.ts';
import { VERSION } from './version.ts';
import { ACTIONS, NAMESPACE, NAMESPACE_DESCRIPTION, stubContent, stubDescription, TOOL, TOOLS } from './words.ts';

/** OpenCode's own tool that reads an MCP resource (2.4.1). */
export const READ_RESOURCE_TOOL = 'opencode_read_mcp_resource';
/** Where the skills a session loaded are kept, in the plugin's storage: (server, the URI of its SKILL.md). */
export const LOADED_KEY = (session: string) => `loaded/${session}`;

type LoadedSkill = { server: string; uri: string };

/** A URI with its scheme and authority in lower case, as URIs compare them: SKILL://Git-Workflow/… is skill://git-workflow/…. */
const caseless = (uri: string) => uri.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*)/, (m) => m.toLowerCase());

/** Whether `uri` is a file of the skill whose SKILL.md is `skillUri` (in its folder), with scheme and authority compared without case. */
export function inSkill(skillUri: string, uri: string): boolean {
    const skill = caseless(skillUri);
    const file = caseless(uri);
    const root = rootOf(skill);
    return root !== undefined && (file === skill || file.startsWith(`${root}/`));
}
/**
 * Whether a URI's path has a `.` or `..` segment, or an encoded dot or slash: one that may name a
 * loaded skill's file without starting with its folder (`skill://srv/skills/x/../haiku/FORMS.md`).
 */
export function oddPath(uri: string): boolean {
    const path = uri.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, '');
    return /(^|\/)\.\.?(\/|$)/.test(path) || /%2e|%2f|%5c/i.test(path);
}
/** How many parents up a subagent's session is checked. */
const MAX_DEPTH = 8;

/**
 * Whether a call is OpenCode's resource read, however it was named: its effective name
 * (`opencode_read_mcp_resource`), the dotted name a model or a Code Mode program uses
 * (`opencode.read_mcp_resource`), or the tool OpenCode resolved it to.
 */
export function isResourceRead(event: { tool: string; info?: { name?: string; options?: { namespace?: string } } }): boolean {
    if (event.tool.replace(/\./g, '_') === READ_RESOURCE_TOOL) return true;
    return event.info?.name === 'read_mcp_resource' && (event.info.options?.namespace ?? 'opencode') === 'opencode';
}
const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,120}$/;

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
    if (env.MCP_SKILLS_STATE) return env.MCP_SKILLS_STATE;
    const data = env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share');
    return join(data, 'opencode', 'mcp-skills');
}

function makeLog(base: string) {
    const file = join(base, 'mcp-skills.log');
    try {
        mkdirSync(base, { recursive: true, mode: 0o700 });
        if (existsSync(file) && statSync(file).size > 2 * 1024 * 1024) renameSync(file, file + '.1');
        if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 });
        chmodSync(file, 0o600);
    } catch {
        // logging is best effort
    }
    return (s: string) => {
        try {
            appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${oneLine(secrets.scrub(s), 600)}\n`);
        } catch {
            // the folder went away
        }
    };
}

export async function setup(ctx: Context, env: NodeJS.ProcessEnv = process.env): Promise<() => Promise<void>> {
    const off = env.MCP_SKILLS_OFF === '1' || ctx.options?.off === true;
    const log = makeLog(stateDir(env));
    log(`mcp-skills ${VERSION} for OpenCode ${ctx.app?.version ?? '?'} started in ${ctx.location.directory}${off ? ' (turned off: doing nothing)' : ''}`);
    if (off) return async () => {};

    // Loads and cross-server reads ask by default, whatever OpenCode's default rules say (consent.ts).
    const consent = askByDefaultOff(ctx.options?.askByDefault, env.MCP_SKILLS_ASK_BY_DEFAULT)
        ? async () => {}
        : await askByDefault(ctx, { actions: [ACTIONS.load, ACTIONS.crossServer], prefix: 'mcp-skills', plugin: 'mcp-skills', log });

    const app = new App({ log, connectTimeoutMs: Number(env.MCP_SKILLS_CONNECT_TIMEOUT_MS ?? 10000) });
    const servers = new OpenCodeServers(ctx);

    // OpenCode's skill list: one entry per served skill, rebuilt whenever the listings change.
    await ctx.skill.transform((editor) => {
        for (const { listed, id } of app.offered) {
            if (editor.get(id)) continue; // never over a skill OpenCode has from elsewhere
            editor.add({
                id,
                name: listed.entry.frontmatter.name,
                description: stubDescription(listed.label, listed.entry.frontmatter.description),
                // OpenCode's form for a skill with no folder on disk.
                path: `skill://${id}/SKILL.md`,
                content: stubContent(listed.label, listed.entry.uri, listed.entry.frontmatter.name)
            });
        }
    });
    const kept = async (session: string): Promise<LoadedSkill[]> => {
        try {
            const v = await ctx.storage.get(LOADED_KEY(session));
            return Array.isArray(v) ? v.filter((x): x is LoadedSkill => !!x && typeof x.server === 'string' && typeof x.uri === 'string') : [];
        } catch {
            return [];
        }
    };
    app.onLoaded = async (session, server, uri) => {
        const before = await kept(session);
        if (!before.some((k) => k.server === server && k.uri === uri)) await ctx.storage.set(LOADED_KEY(session), [...before, { server, uri }]);
    };
    /** The skills this session, or a session it is a subagent of, loaded. */
    const loadedSkills = async (session: string): Promise<LoadedSkill[]> => {
        const out = new Map<string, LoadedSkill>();
        let id: string | undefined = session;
        for (let depth = 0; id && depth < MAX_DEPTH; depth++) {
            for (const s of [...app.loadedSkills(id), ...(await kept(id))]) out.set(`${s.server}\n${s.uri}`, s);
            try {
                const r = (await ctx.session.get({ sessionID: id })) as { parentID?: string; data?: { parentID?: string } };
                id = r?.data?.parentID ?? r?.parentID;
            } catch {
                id = undefined;
            }
        }
        return [...out.values()];
    };

    app.onListed = () => {
        log(`OpenCode lists ${app.offered.length} served skill(s)`);
        void ctx.skill.reload().catch((e) => log(`OpenCode's skill list could not be rebuilt (${String(e)})`));
    };

    const askFor = (call: ToolCallContext) => (action: string, resource: string, o: { save: boolean; metadata: Record<string, unknown> }) =>
        ctx.permission.assert({ sessionID: call.sessionID, agent: call.agent, source: { type: 'tool', messageID: call.messageID, id: call.id }, action, resources: [resource], save: o.save ? [resource] : [], metadata: o.metadata });

    await ctx.tool.transform((editor) => {
        editor.namespace({ name: NAMESPACE, description: NAMESPACE_DESCRIPTION });
        for (const t of TOOLS)
            editor.add({
                name: t.name,
                description: t.description,
                input: t.input,
                options: { namespace: NAMESPACE, codemode: false },
                execute: async (input, call) => {
                    if (!SESSION_ID.test(call.sessionID)) return { content: 'mcp-skills needs to know which OpenCode session this call is from, and this call did not say.' };
                    const answer = await app.call(t.name, input, { ask: askFor(call), session: call.sessionID });
                    return { content: answer.isError ? `Error: ${answer.text}` : answer.text };
                }
            });
    });

    // V4: a loaded skill's files are read with read_skill_file, verified against the skill's manifest;
    // OpenCode's resource tool, which checks nothing, is refused for them.
    // X8: a session that loaded a served skill reads another server's resource only once OpenCode's
    // rules allow it, asked for that one read and naming both servers.
    await ctx.tool.hook('execute.before', async (event) => {
        if (!isResourceRead(event)) return;
        const input = (event.input ?? {}) as { server?: unknown; uri?: unknown };
        if (typeof input.server !== 'string') return;
        const uri = typeof input.uri === 'string' ? input.uri : '';
        const held = await loadedSkills(event.sessionID);
        const own = held.find((h) => h.server === input.server && inSkill(h.uri, uri));
        if (!own && oddPath(uri) && held.some((h) => h.server === input.server)) {
            log(`a read of ${input.server}'s ${oneLine(uri, 200)} through OpenCode's resource tool, with a dot or encoded path segment, after one of its skills loaded: refused`);
            throw new Error(`mcp-skills: ${uri} has a "." or ".." segment or an encoded dot or slash, on the MCP server ${JSON.stringify(input.server)}, which a loaded skill came from, so it may name one of that skill's files. Read a skill's file with ${TOOL.read}, which checks it against the skill's manifest; for anything else, ask for the resource by its plain URI.`);
        }
        if (own) {
            log(`a read of ${input.server}'s ${oneLine(uri, 200)} through OpenCode's resource tool, inside a loaded skill: refused`);
            throw new Error(`mcp-skills: ${uri} is a file of the skill ${own.uri}, loaded from the MCP server ${JSON.stringify(input.server)}. Read it with ${TOOL.read} (server ${JSON.stringify(input.server)}, skill ${JSON.stringify(own.uri)}, and its path), which checks it against the skill's manifest; OpenCode's resource tool does not.`);
        }
        const from = [...new Set(held.map((h) => h.server))].filter((s) => s !== input.server);
        if (!from.length) return;
        log(`a session that loaded skills of ${from.join(', ')} reads a resource of ${input.server}: put to OpenCode's rules`);
        await ctx.permission.assert({
            sessionID: event.sessionID,
            agent: event.agent,
            source: { type: 'tool', messageID: event.messageID, id: event.id },
            action: ACTIONS.crossServer,
            resources: [`${from.join(',')}->${input.server}:${uri}`],
            save: [],
            metadata: { skillsFrom: from, server: input.server, uri, note: `A skill served by ${from.map((f) => JSON.stringify(f)).join(', ')} may have led to this read from ${JSON.stringify(input.server)}.` }
        });
    });

    void servers
        .applied()
        .then(() => servers.table())
        .then((table) => app.start(table))
        .catch((e) => log(`the servers could not be looked at (${String(e)})`));

    return async () => {
        await consent();
        await app.stop();
    };
}

const plugin: Plugin = { id: 'mcp-skills', setup: (ctx) => setup(ctx) };
export default plugin;
