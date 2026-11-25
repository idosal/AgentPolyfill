// A live run: a real Pi, a real model, an extension (this form's, or ARD's with
// PI_LIVE_EXTENSION), and a conversation of plain-words prompts. Answers each
// question of the extension with its yes ("Add it", or a search's yes), and
// prints a transcript and the mcp.json the run left.
//
// Needs a Pi agent directory you signed in to (PI_LIVE_AGENT_DIR; this script
// writes its mcp.json, and never reads its credentials) and the model to use:
//
//   PI_LIVE_AGENT_DIR=… PI_LIVE_PROVIDER=openai-codex PI_LIVE_MODEL=gpt-6.2-sol \
//     node live/run.ts "What MCP servers does neon.com publish?" "Add Neon Docs."

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pi, temp } from '../test/pi-rpc.ts';

const EXTENSION = process.env.PI_LIVE_EXTENSION ?? fileURLToPath(new URL('../extension/dist/index.js', import.meta.url));
const agentDir = process.env.PI_LIVE_AGENT_DIR;
const provider = process.env.PI_LIVE_PROVIDER;
const model = process.env.PI_LIVE_MODEL;
if (!agentDir || !provider || !model) throw new Error('set PI_LIVE_AGENT_DIR, PI_LIVE_PROVIDER and PI_LIVE_MODEL');
const prompts = process.argv.slice(2);
if (!prompts.length) throw new Error('give the prompts, in order');

const dir = temp('mcp-cards-live-');
writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2));
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
const file = join(agentDir, 'mcp.json');
say('mcp.json after the run', existsSync(file) ? readFileSync(file, 'utf8') : '(none)');
await pi.stop();
