// A live run: a real Pi, a real model, the extension, and Hugging Face's public
// MCP server, which serves skills. Asks a question one of its skills covers,
// answers the extension's question with "Load it", and prints a transcript.
//
// Needs a Pi agent directory you signed in to (PI_LIVE_AGENT_DIR; this script
// writes its mcp.json, and never reads its credentials) and the model to use:
//
//   PI_LIVE_AGENT_DIR=… PI_LIVE_PROVIDER=openai-codex PI_LIVE_MODEL=gpt-6.2-sol node live/run.ts [question]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pi, temp } from '../test/pi-rpc.ts';

const EXTENSION = fileURLToPath(new URL('../extension/dist/index.js', import.meta.url));
const agentDir = process.env.PI_LIVE_AGENT_DIR;
const provider = process.env.PI_LIVE_PROVIDER;
const model = process.env.PI_LIVE_MODEL;
if (!agentDir || !provider || !model) throw new Error('set PI_LIVE_AGENT_DIR, PI_LIVE_PROVIDER and PI_LIVE_MODEL');
const question = process.argv[2] ?? 'Which GGUF quantization should I use to run a 7B model on a 16 GB Mac?';

const dir = temp('mcp-skills-live-');
writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { huggingface: { url: 'https://huggingface.co/mcp' } } }, null, 2));
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
    env: { HOME: home, MCP_SKILLS_STATE: join(dir, 'state'), MCP_SKILLS_STARTUP_WAIT_MS: '20000' },
    answer: (r) => {
        say('Pi asks the user', `${(r.title ?? '').slice(0, 900)}\n  options: ${(r.options ?? []).join(' | ')}`);
        const pick = r.method === 'select' ? r.options?.find((o) => o === 'Load it') : r.method === 'confirm' ? true : undefined;
        say('user answers', String(pick));
        return pick;
    }
});
await pi.ready(60000);
say('user', question);
await pi.prompt(question, 600000);
for (const r of pi.records) {
    if (r.type === 'tool_execution_start') say('tool call', `${String(r.toolName)} ${JSON.stringify(r.args ?? '')}`.slice(0, 300));
    if (r.type === 'tool_execution_end') {
        const c = (r.result as { content?: { text?: string }[] } | undefined)?.content ?? [];
        say(`tool result${r.isError ? ' (error)' : ''}`, c.map((x) => x.text ?? '').join(' ').replace(/\s+/g, ' ').slice(0, 300));
    }
    if (r.type === 'message_end') {
        const m = r.message as { role: string; content: unknown };
        if (m.role !== 'assistant') continue;
        const text = (Array.isArray(m.content) ? m.content : []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('');
        if (text) say('Pi', text);
    }
}
await pi.stop();
