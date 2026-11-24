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
import { oneLine, secrets } from '../../core/src/untrusted.ts';
import { App } from './app.ts';
import { OpenCodeServers } from './config.ts';
import type { Context, Plugin, ToolCallContext } from './opencode.ts';
import { VERSION } from './version.ts';
import { ACTIONS, NAMESPACE, NAMESPACE_DESCRIPTION, stubContent, stubDescription, TOOLS } from './words.ts';

/** OpenCode's own tool that reads an MCP resource (2.4.1). */
export const READ_RESOURCE_TOOL = 'opencode_read_mcp_resource';
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

    // X8: a session that loaded a served skill reads another server's resource only once OpenCode's
    // rules allow it, asked for that one read and naming both servers.
    await ctx.tool.hook('execute.before', async (event) => {
        if (event.tool !== READ_RESOURCE_TOOL) return;
        const input = (event.input ?? {}) as { server?: unknown; uri?: unknown };
        if (typeof input.server !== 'string') return;
        const from = app.loadedFrom(event.sessionID).filter((s) => s !== input.server);
        if (!from.length) return;
        const uri = typeof input.uri === 'string' ? input.uri : '';
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

    return () => app.stop();
}

const plugin: Plugin = { id: 'mcp-skills', setup: (ctx) => setup(ctx) };
export default plugin;
