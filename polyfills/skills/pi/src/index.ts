// mcp-skills for Pi: the extension.
//
// Pi loads this file into its own process. It registers the four tools; when a
// session starts it reaches the MCP servers Pi connects (pi-config.ts, lent.ts),
// lists the skills of those that declared the Skills extension, and hands Pi a
// folder of SKILL.md stubs on `resources_discover`, so Pi lists the served
// skills among its own. Loading one asks the person first (a Pi dialog). While a
// served skill is loaded, a read of another server's resource through Pi's
// `read_mcp_resource` is put to the person too, naming both servers.

import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { oneLine, secrets } from '../../core/src/untrusted.ts';
import { App, type Ask, type Decision } from './app.ts';
import { lenderOf } from './lent.ts';
import { agentDir, readPiEntries, readPiServers } from './pi-config.ts';
import { Store } from './store.ts';
import { stubRootOf } from './stubs.ts';
import { PLUGIN, VERSION } from './version.ts';

/** How long Pi's start waits for the servers' listings before it lists skills; the rest are listed after a /reload. */
const STARTUP_WAIT_MS = Number(process.env.MCP_SKILLS_STARTUP_WAIT_MS ?? 8000);
const SECTION = 'mcp_skills';
const INSTRUCTIONS =
    'Some of the skills listed for you are served by the user\'s MCP servers (the MCP Skills extension), named mcp-<server>-<name> and marked with their server; the SKILL.md you read for one only says how to load it. ' +
    'Load a served skill with load_skill, giving its server and uri: the user is asked first, and the skill\'s text comes back marked with the server it came from. ' +
    'Read the files a loaded skill refers to with read_skill_file, never from disk. list_skills lists every served skill, including any not in your list.';

const identity = { server: { type: 'string', description: "The MCP server that serves the skill, by its name in Pi's MCP configuration." } };
const TOOLS = [
    {
        name: 'list_skills',
        label: 'List MCP-served skills',
        description: "Lists the skills the user's MCP servers serve over the MCP Skills extension, each with its server, uri and the server's description, and the servers left alone with the reason. Nothing is loaded.",
        parameters: { type: 'object', properties: { server: { type: 'string', description: 'Only this server.' } }, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    {
        name: 'load_skill',
        label: 'Load an MCP-served skill',
        description: "Loads a skill an MCP server serves, by its server and the URI of its SKILL.md. The user is asked first (once per skill, and again if it changes). Returns the skill's text, verified against the server's digests and marked with its origin, and the list of its other files.",
        parameters: { type: 'object', properties: { ...identity, uri: { type: 'string', description: "The URI of the skill's SKILL.md, for example skill://name/SKILL.md." } }, required: ['server', 'uri'], additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    {
        name: 'read_skill_file',
        label: 'Read a file of a loaded skill',
        description: "Reads one file of a skill loaded with load_skill, from the server that serves it, verified against the skill's manifest. The path is relative to the skill's folder, as the skill refers to it.",
        parameters: { type: 'object', properties: { ...identity, skill: { type: 'string', description: "The URI of the loaded skill's SKILL.md." }, path: { type: 'string', description: "The file's path inside the skill, for example references/GUIDE.md." } }, required: ['server', 'skill', 'path'], additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    {
        name: 'list_skill_directory',
        label: 'List a folder of a loaded skill',
        description: "Lists what a folder of a skill loaded with load_skill holds: from the skill's manifest, or for a skill whose content the server generates, from the server where it lists directories.",
        parameters: { type: 'object', properties: { ...identity, skill: { type: 'string', description: "The URI of the loaded skill's SKILL.md." }, path: { type: 'string', description: 'The folder inside the skill; empty for its top.' } }, required: ['server', 'skill'], additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    }
] as const;

/** The choices of the load question, as the person reads them. */
const CHOICES: Record<Decision, string> = { no: "Don't load it", show: 'Show me its SKILL.md first', load: 'Load it' };

export default function mcpSkills(pi: ExtensionAPI): void {
    const env = process.env;
    // There is no sound way yet to tell that Pi serves MCP skills itself, so this is how to stand it down.
    if (env.MCP_SKILLS_OFF === '1') return;
    const base = env.MCP_SKILLS_STATE || join(agentDir(env), 'mcp-skills');
    const store = new Store(base);
    if (store.settings().off) return;
    const logFile = join(base, 'mcp-skills.log');
    const log = (s: string) => {
        try {
            if (existsSync(logFile) && statSync(logFile).size > 2 * 1024 * 1024) renameSync(logFile, logFile + '.1');
            appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${oneLine(secrets.scrub(s), 600)}\n`, { mode: 0o600 });
        } catch {
            // logging is best effort
        }
    };
    let app: App | undefined;
    let abort: AbortController | undefined;
    let ui: ExtensionContext['ui'] | undefined;

    const start = (ctx: ExtensionContext): App => {
        abort = new AbortController();
        const trusted = ctx.isProjectTrusted();
        const registered = pi.getMcpServers().map((s) => ({ name: s.name, config: s.config as unknown }));
        const table = readPiServers({ env, cwd: ctx.cwd, trusted, registered });
        const entries = new Map([...readPiEntries({ env, cwd: ctx.cwd, trusted, registered }).entries].map(([k, v]) => [k, v.config]));
        const lend = lenderOf(pi);
        log(`${PLUGIN} ${VERSION} for Pi started${lend ? ' (Pi lends its MCP connections)' : ''}`);
        const a = new App({ table, entries, lend, store, stubRoot: stubRootOf(base), log, signal: abort.signal, connectTimeoutMs: Number(env.MCP_SKILLS_CONNECT_TIMEOUT_MS ?? 10000) });
        a.onStubsChanged = () => ui?.notify('mcp-skills: your MCP servers serve new or changed skills. Run /reload to list them.', 'info');
        void a.start();
        return a;
    };

    for (const spec of TOOLS) {
        pi.registerTool({
            name: spec.name,
            label: spec.label,
            description: spec.description,
            parameters: spec.parameters as never,
            annotations: spec.annotations,
            async execute(_id, params, _signal, _onUpdate, ctx) {
                if (!app) return { content: [{ type: 'text' as const, text: 'mcp-skills has not started in this session yet.' }], details: {}, isError: true };
                const ask: Ask = async (message, choices) => {
                    if (!ctx.hasUI) return { unavailable: 'Pi has no one to ask in this mode (print or JSON)' };
                    const [title, ...rest] = message.split('\n');
                    const picked = await ctx.ui.select(`${title}\n${rest.join('\n')}`, choices.map((c) => CHOICES[c]));
                    const decision = (Object.keys(CHOICES) as Decision[]).find((d) => CHOICES[d] === picked);
                    // Closing the question, or anything but one of its choices, is a no.
                    return { decision: decision && choices.includes(decision) ? decision : 'no' };
                };
                const answer = await app.call(spec.name, params, { ask });
                return { content: [{ type: 'text' as const, text: answer.text }], details: {}, ...(answer.isError ? { isError: true } : {}) };
            }
        });
    }

    pi.on('session_start', (_event, ctx) => {
        ui = ctx.ui;
        if (!app) app = start(ctx);
    });

    // Pi lists skills from the folders extensions give it here: the stubs, written once the servers
    // were looked at (or, past the wait, as an earlier session left them).
    pi.on('resources_discover', async () => {
        if (!app) return;
        const a = app;
        let settled = false;
        await Promise.race([a.settled.then(() => (settled = true)), new Promise((r) => setTimeout(r, STARTUP_WAIT_MS).unref())]);
        // A server that answers after Pi stopped waiting has its skills written for the next /reload: say so.
        if (!settled) void a.settled.then(() => a === app && a.host.listed().length && ui?.notify('mcp-skills: your MCP servers serve skills Pi has not listed yet. Run /reload to list them.', 'info'));
        return { skillPaths: [stubRootOf(base)] };
    });

    pi.on('before_agent_start', (event) => {
        if (app?.conns.size) event.systemPromptOptions.sections[SECTION] = INSTRUCTIONS;
    });

    // SEP-2640 X8: while a served skill is loaded, a read of another server's resource is put to the
    // person, with both servers named, or refused where nobody can be asked. Pi runs this for the
    // model's calls and for calls a codemode script makes alike.
    pi.on('tool_call', async (event, ctx) => {
        if (!app || event.toolName !== 'read_mcp_resource') return;
        const held = [...new Set(app.host.held().map((h) => h.label))];
        const target = (event.input as { server?: unknown }).server;
        if (!held.length || typeof target !== 'string') return;
        const others = held.filter((s) => s !== target);
        if (!others.length) return;
        const uri = (event.input as { uri?: unknown }).uri;
        const why = `A skill served by the MCP server ${others.map((s) => JSON.stringify(s)).join(', ')} is loaded in this session, and Pi wants to read a resource from the MCP server ${JSON.stringify(target)}${typeof uri === 'string' ? ` (${oneLine(uri, 200)})` : ''}. The skill's text may be what asks for it.`;
        if (!ctx.hasUI) return { block: true, reason: `${why} Nobody can be asked in this mode, so it is not read.` };
        const ok = await ctx.ui.confirm('mcp-skills: read another server\'s resource?', `${why}\n\nAllow this one read?`);
        if (!ok) return { block: true, reason: `${why} The user did not allow it.` };
    });

    pi.on('session_shutdown', async () => {
        const a = app;
        app = undefined;
        abort?.abort();
        await a?.stop().catch(() => {});
    });
}
