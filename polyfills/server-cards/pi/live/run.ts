// A live run: a real Pi, a real model, an extension (this form's, or ARD's with
// PI_LIVE_EXTENSION), and a conversation of plain-words prompts. Answers each
// question of the extension with its yes ("Add it", or a search's yes), and
// prints a transcript and the servers the run's mcp.json names (names and origins only).
//
// Needs a throwaway Pi agent folder you signed in to (PI_LIVE_AGENT_DIR, made with
// `node live/run.ts --new-agent-dir <path>`; see live/agent-dir.ts) and the model to use:
//
//   PI_LIVE_AGENT_DIR=… PI_LIVE_PROVIDER=openai-codex PI_LIVE_MODEL=gpt-6.2-sol \
//     node live/run.ts "What MCP servers does neon.com publish?" "Add Neon Docs."

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveAgentDir, mcpServersAfter, writeMcpJson } from './agent-dir.ts';
import { Pi, temp } from '../test/pi-rpc.ts';

const EXTENSION = process.env.PI_LIVE_EXTENSION ?? fileURLToPath(new URL('../extension/dist/index.js', import.meta.url));
const agentDir = liveAgentDir(process.env.PI_LIVE_AGENT_DIR);
const provider = process.env.PI_LIVE_PROVIDER;
const model = process.env.PI_LIVE_MODEL;
if (!provider || !model) throw new Error('set PI_LIVE_PROVIDER and PI_LIVE_MODEL');
const prompts = process.argv.slice(2);
if (!prompts.length) throw new Error('give the prompts, in order');

const dir = temp('mcp-cards-live-');
writeMcpJson(agentDir, { mcpServers: {} });
const home = join(dir, 'home');
const cwd = join(dir, 'project');
mkdirSync(home);
mkdirSync(cwd);

const say = (who: string, text: string) => console.log(`\n[${who}] ${text}`);
const pi = new Pi({
    extensions: [EXTENSION],
    agentDir,
    cwd,
    model: { provider, id: model },
    env: { HOME: home, ...(process.env.ARD_DISCOVERY_REGISTRY ? { ARD_DISCOVERY_REGISTRY: process.env.ARD_DISCOVERY_REGISTRY } : {}) },
    answer: (r) => {
        say('Pi asks the user', `${r.title ?? ''}${r.message ? `\n${r.message}` : ''}\n  options: ${(r.options ?? []).join(' | ')}`);
        const pick = r.method === 'confirm' ? true : r.options?.find((o) => /^(Add it|Search|Send|Yes)/i.test(o));
        say('user answers', String(pick));
        return pick;
    }
});
await pi.ready(60000);
for (const prompt of prompts) {
    const from = pi.records.length;
    say('user', prompt);
    await pi.prompt(prompt, 600000);
    for (const r of pi.records.slice(from)) {
        if (r.type === 'tool_execution_start') say('tool call', `${String(r.toolName)} ${JSON.stringify(r.args ?? '')}`.slice(0, 300));
        if (r.type === 'tool_execution_end') {
            const c = (r.result as { content?: { text?: string }[] } | undefined)?.content ?? [];
            say(`tool result${r.isError ? ' (error)' : ''}`, c.map((x) => x.text ?? '').join(' ').replace(/\s+/g, ' ').slice(0, 400));
        }
        if (r.type === 'message_end') {
            const m = r.message as { role: string; content: unknown };
            if (m.role !== 'assistant') continue;
            const text = (Array.isArray(m.content) ? m.content : []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('');
            if (text) say('Pi', text);
        }
    }
}
say('MCP servers after the run', mcpServersAfter(agentDir));
await pi.stop();
