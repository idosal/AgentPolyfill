// A stand-in for `@github/copilot-sdk/extension`, the module Copilot provides to an extension.
// joinSession() reports what the extension registered, and the test drives the session over this
// process's stdin and stdout (one JSON object per line), which a real extension leaves to the SDK:
//
//   to the test:   {t:'joined', tools:[{name, skipPermission}], hooks:[names]}
//                  {t:'result', id, value} {t:'hookResult', id, value}
//                  {t:'send', id, options}                       session.send() was called
//   from the test: {t:'call', id, name, args}                    the model calls a tool
//                  {t:'hook', id, name, input}                   Copilot runs a hook
//                  {t:'event', type, data, agentId?}             a session event
//                  {t:'sendReply', id, ok | error | hang}        how Copilot answers a send
//                  {t:'sendMode', mode: 'ok'|'error'|'hang'|'manual'}  how later sends are answered
//
// listConfigured() answers FAKE_COPILOT_CONFIGURED_FILE's contents, or FAKE_COPILOT_CONFIGURED (JSON),
// or fails when it is "error" or unset.
import { createInterface } from 'node:readline';

const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let sendMode = process.env.FAKE_SEND_MODE || 'ok';
let n = 0;
const waitingSends = new Map();

export async function joinSession(config = {}) {
    if (!process.env.SESSION_ID) throw new Error('joinSession() is intended for extensions running as child processes of the Copilot CLI.');
    // As the SDK's normalizeSessionOptions: a tools array is the older form of tools.definitions,
    // and hooks named directly the older form of hooks.handlers.
    const defs = Array.isArray(config.tools) ? config.tools : config.tools?.definitions ?? [];
    const hooks = config.hooks?.handlers ?? config.hooks ?? {};
    const listeners = [];
    const session = {
        sessionId: process.env.SESSION_ID,
        capabilities: { ui: { elicitation: true } },
        on(type, fn) {
            const l = { type, fn };
            listeners.push(l);
            return () => listeners.splice(listeners.indexOf(l), 1);
        },
        async send(options) {
            const id = ++n;
            out({ t: 'send', id, options });
            if (sendMode === 'ok') return `msg-${id}`;
            if (sendMode === 'error') throw new Error('session is not accepting messages');
            return new Promise((resolve, reject) => {
                if (sendMode === 'hang') return;
                waitingSends.set(id, { resolve, reject });
            });
        },
        async log() {},
        rpc: {
            mcp: {
                async listConfigured() {
                    // A file, re-read on each call, lets a test change what Copilot uses mid-session.
                    const f = process.env.FAKE_COPILOT_CONFIGURED_FILE;
                    const c = f ? (await import('node:fs')).readFileSync(f, 'utf8') : process.env.FAKE_COPILOT_CONFIGURED;
                    if (!c || c === 'error') throw new Error('Unhandled method session.mcp.listConfigured');
                    return { servers: JSON.parse(c) };
                }
            }
        }
    };
    createInterface({ input: process.stdin }).on('line', async (line) => {
        let m;
        try {
            m = JSON.parse(line);
        } catch {
            return;
        }
        if (m.t === 'call') {
            const d = defs.find((x) => x.name === m.name);
            try {
                const value = d ? await d.handler(m.args ?? {}, { sessionId: session.sessionId, toolCallId: `call-${m.id}`, toolName: m.name, arguments: m.args }) : `Tool '${m.name}' does not exist.`;
                out({ t: 'result', id: m.id, value });
            } catch (e) {
                out({ t: 'result', id: m.id, thrown: String(e?.message ?? e) });
            }
        } else if (m.t === 'hook') {
            const value = hooks[m.name] ? await hooks[m.name](m.input ?? {}) : undefined;
            out({ t: 'hookResult', id: m.id, value: value ?? null });
        } else if (m.t === 'event') {
            for (const l of [...listeners]) if (l.type === m.type || l.type === '*') l.fn({ type: m.type, data: m.data, ...(m.agentId ? { agentId: m.agentId } : {}) });
        } else if (m.t === 'sendMode') sendMode = m.mode;
        else if (m.t === 'sendReply') {
            const w = waitingSends.get(m.id);
            waitingSends.delete(m.id);
            if (m.error) w?.reject(new Error(m.error));
            else w?.resolve(`msg-${m.id}`);
        }
    });
    out({ t: 'joined', tools: defs.map((d) => ({ name: d.name, skipPermission: d.skipPermission === true, description: d.description, parameters: d.parameters })), hooks: Object.keys(hooks), toolsForm: Array.isArray(config.tools) ? 'array' : config.tools ? 'definitions' : 'none' });
    return session;
}
