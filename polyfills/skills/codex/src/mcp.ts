// The MCP server Codex starts for this plugin, over stdio: newline-delimited
// JSON-RPC, written by hand so that it does exactly this and nothing more:
//
//   initialize, ping, tools/list, tools/call    from Codex
//   elicitation/create                          to Codex: the question before a skill is
//                                               loaded, which Codex puts to the person
//
// It speaks the 2025 revisions' opening (`initialize`), which Codex 0.170 uses.
// A 2026-07-28 `server/discover` is answered "method not found", so a client
// falls back to `initialize`.

import type { Readable, Writable } from 'node:stream';
import { SKILLS_EXTENSION } from '../../core/src/skills.ts';
import { describeError } from '../../core/src/untrusted.ts';
import type { App, Asked, Decision } from './app.ts';
import { PLUGIN, VERSION } from './version.ts';

type Json = Record<string, unknown>;
const REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LINE = 4 * 1024 * 1024;
/** How long a question waits for the person. Codex is told to wait as long for the tool (.mcp.json). */
const ASK_TIMEOUT_MS = 9 * 60 * 1000;

const INSTRUCTIONS = `Skills served by the user's MCP servers (the MCP Skills extension), which Codex does not load by itself. Codex lists them among its skills as ${PLUGIN}:<server>:<name>; the SKILL.md it shows for one only says how to load it. Load a skill with load_skill, giving its server and uri: the user is asked first, and the skill's text comes back marked with the server it came from. Read the files a loaded skill refers to with read_skill_file, never from disk. list_skills lists every served skill, including any not in Codex's list.`;

const identity = { server: { type: 'string', description: 'The MCP server that serves the skill, by its name in the user\'s Codex config.' } };
export const TOOLS = [
    {
        name: 'list_skills',
        title: 'List MCP-served skills',
        description: 'Lists the skills the user\'s MCP servers serve over the MCP Skills extension, each with its server, uri and the server\'s description, and the servers left alone with the reason. Nothing is loaded.',
        inputSchema: { type: 'object', properties: { server: { type: 'string', description: 'Only this server.' } } },
        annotations: { readOnlyHint: true, openWorldHint: true }
    },
    {
        name: 'load_skill',
        title: 'Load an MCP-served skill',
        description: 'Loads a skill an MCP server serves, by its server and the URI of its SKILL.md. The user is asked first (once per skill, and again if it changes). Returns the skill\'s text, verified against the server\'s digests and marked with its origin, and the list of its other files.',
        inputSchema: { type: 'object', properties: { ...identity, uri: { type: 'string', description: 'The URI of the skill\'s SKILL.md, for example skill://name/SKILL.md.' } }, required: ['server', 'uri'] },
        annotations: { readOnlyHint: true, openWorldHint: true }
    },
    {
        name: 'read_skill_file',
        title: 'Read a file of a loaded skill',
        description: 'Reads one file of a skill loaded with load_skill, from the server that serves it, verified against the skill\'s manifest. The path is relative to the skill\'s folder, as the skill refers to it.',
        inputSchema: { type: 'object', properties: { ...identity, skill: { type: 'string', description: 'The URI of the loaded skill\'s SKILL.md.' }, path: { type: 'string', description: 'The file\'s path inside the skill, for example references/GUIDE.md.' } }, required: ['server', 'skill', 'path'] },
        annotations: { readOnlyHint: true, openWorldHint: true }
    },
    {
        name: 'list_skill_directory',
        title: 'List a folder of a loaded skill',
        description: 'Lists what a folder of a skill loaded with load_skill holds: from the skill\'s manifest, or for a skill whose content the server generates, from the server where it lists directories.',
        inputSchema: { type: 'object', properties: { ...identity, skill: { type: 'string', description: 'The URI of the loaded skill\'s SKILL.md.' }, path: { type: 'string', description: 'The folder inside the skill; empty for its top.' } }, required: ['server', 'skill'] },
        annotations: { readOnlyHint: true, openWorldHint: true }
    }
] as const;

const TITLES: Record<Decision, string> = { no: 'Do not load it', show: 'Show me its SKILL.md first', load: 'Load it' };

export type ServeOptions = {
    app: App;
    input: Readable;
    output: Writable;
    log?: (line: string) => void;
    /** Called with what the client declared at initialize. */
    onInitialize?: (clientCapabilities: Json, clientInfo: Json) => void;
    askTimeoutMs?: number;
    /** How the person is asked, where it is not an MCP elicitation (Muse: muse.ts museAsk). */
    ask?: (message: string, choices: Decision[]) => Promise<Asked>;
    /** The host's words in place of Codex's, for what the server says (Muse: muse.ts museWords). */
    words?: (text: string) => string;
};

export function serve(o: ServeOptions): { done: Promise<void> } {
    const log = o.log ?? (() => {});
    let clientCaps: Json = {};
    let revision = REVISIONS[0]!;
    let next = 1;
    const waiting = new Map<string, (m: Json) => void>();
    const cancelled = new Set<string | number>();
    const send = (m: Json) => {
        try {
            o.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
        } catch {
            // Codex is gone
        }
    };
    const reply = (id: unknown, result: Json) => {
        if (typeof id === 'string' || typeof id === 'number') {
            if (cancelled.delete(id)) return;
            send({ id, result });
        }
    };
    const fail = (id: unknown, code: number, message: string) => (typeof id === 'string' || typeof id === 'number') && send({ id, error: { code, message } });

    const words = o.words ?? ((s: string) => s);
    /** One question to the person, through Codex. Only a choice the form offered, given by the person, counts as an answer. */
    const elicit = (message: string, choices: Decision[]): Promise<Asked> => {
        if (typeof clientCaps.elicitation !== 'object' || clientCaps.elicitation === null) return Promise.resolve({ unavailable: 'Codex did not offer to put questions to you on this connection' });
        const id = `ask-${next++}`;
        return new Promise<Asked>((done) => {
            const timer = setTimeout(() => {
                waiting.delete(id);
                done({ unavailable: 'no answer came in time' });
            }, o.askTimeoutMs ?? ASK_TIMEOUT_MS);
            waiting.set(id, (m) => {
                clearTimeout(timer);
                if (m.error !== undefined) return done({ unavailable: 'Codex could not put the question' });
                const r = (m.result ?? {}) as { action?: unknown; content?: { decision?: unknown } };
                const decision = r.action === 'accept' && typeof r.content?.decision === 'string' && (choices as string[]).includes(r.content.decision) ? (r.content.decision as Decision) : 'no';
                done({ decision });
            });
            // A choice the person has to make: a form with a required field is never answered by Codex
            // in the person's place (it accepts only an empty form by itself). The choices are written
            // as the negotiated revision writes a titled single choice.
            const titled = revision >= '2025-11-25';
            const decision = titled ? { type: 'string', title: 'Your answer', oneOf: choices.map((c) => ({ const: c, title: TITLES[c] })) } : { type: 'string', title: 'Your answer', enum: choices, enumNames: choices.map((c) => TITLES[c]) };
            send({ id, method: 'elicitation/create', params: { ...(titled ? { mode: 'form' } : {}), message, requestedSchema: { type: 'object', properties: { decision }, required: ['decision'] } } });
        });
    };

    const ask = (message: string, choices: Decision[]): Promise<Asked> => (o.ask ?? elicit)(words(message), choices);

    const handle = async (m: Json) => {
        const id = m.id;
        const method = m.method;
        if (method === undefined) {
            if (typeof id === 'string' || typeof id === 'number') waiting.get(String(id))?.(m);
            waiting.delete(String(id));
            return;
        }
        const params = (typeof m.params === 'object' && m.params !== null ? m.params : {}) as Json;
        switch (method) {
            case 'initialize': {
                clientCaps = (typeof params.capabilities === 'object' && params.capabilities !== null ? params.capabilities : {}) as Json;
                const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
                revision = REVISIONS.includes(asked) ? asked : REVISIONS[0]!;
                o.onInitialize?.(clientCaps, (params.clientInfo ?? {}) as Json);
                return reply(id, { protocolVersion: revision, capabilities: { tools: { listChanged: false } }, serverInfo: { name: PLUGIN, title: 'MCP Skills (polyfill)', version: VERSION }, instructions: words(INSTRUCTIONS) });
            }
            case 'ping':
                return reply(id, {});
            case 'tools/list':
                return reply(id, { tools: o.words ? TOOLS.map((t) => ({ ...t, description: words(t.description), inputSchema: JSON.parse(words(JSON.stringify(t.inputSchema))) as Json })) : TOOLS });
            case 'tools/call': {
                const meta = (params._meta ?? {}) as Json;
                const turn = (meta['x-codex-turn-metadata'] ?? {}) as Json;
                const thread = [meta.threadId, turn.thread_id, turn.session_id].find((x): x is string => typeof x === 'string' && x.length <= 200);
                const answer = await o.app.call(String(params.name ?? ''), params.arguments, { ask, thread });
                return reply(id, { content: [{ type: 'text', text: words(answer.text) }], ...(answer.isError ? { isError: true } : {}) });
            }
            case 'notifications/cancelled':
                if (typeof params.requestId === 'string' || typeof params.requestId === 'number') cancelled.add(params.requestId);
                return;
            default:
                if (typeof method === 'string' && method.startsWith('notifications/')) return;
                return fail(id, -32601, 'Method not found');
        }
    };

    const done = new Promise<void>((resolve) => {
        let buf = '';
        o.input.setEncoding?.('utf8');
        o.input.on('data', (chunk: string) => {
            buf += chunk;
            if (buf.length > MAX_LINE && !buf.includes('\n')) {
                log('a message from Codex was too long, and was dropped');
                buf = '';
            }
            let at: number;
            while ((at = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, at).trim();
                buf = buf.slice(at + 1);
                if (!line) continue;
                let m: unknown;
                try {
                    m = JSON.parse(line);
                } catch {
                    send({ id: null, error: { code: -32700, message: 'Parse error' } });
                    continue;
                }
                if (typeof m !== 'object' || m === null || Array.isArray(m)) continue;
                handle(m as Json).catch((e) => {
                    log(`a request failed (${describeError(e)})`);
                    fail((m as Json).id, -32603, 'Internal error');
                });
            }
        });
        o.input.on('end', () => resolve());
        o.input.on('close', () => resolve());
    });
    return { done };
}

/** Whether a client says it serves MCP skills itself (how a host would declare the extension). */
export const declaresSkills = (caps: Json): boolean => typeof caps.extensions === 'object' && caps.extensions !== null && SKILLS_EXTENSION in (caps.extensions as Json);
