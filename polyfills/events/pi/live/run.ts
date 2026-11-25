// A live run: a real Pi, a real model, the extension, and the hand-written
// Events server. Asks in plain words to watch for new tickets, says yes to the
// extension's question, goes idle, fires an event at the server, and records
// what happens; then asks Pi to stop watching. Prints a transcript.
//
// Needs a Pi agent directory you signed in to (PI_LIVE_AGENT_DIR; this script
// writes its mcp.json, and never reads its credentials) and the model to use:
//
//   PI_LIVE_AGENT_DIR=… PI_LIVE_PROVIDER=openai-codex PI_LIVE_MODEL=gpt-6.2-sol node live/run.ts

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pi, temp, waitFor } from '../test/pi-rpc.ts';
import { EXTENSION, FIXTURE } from '../test/world.ts';

const agentDir = process.env.PI_LIVE_AGENT_DIR;
const provider = process.env.PI_LIVE_PROVIDER;
const model = process.env.PI_LIVE_MODEL;
if (!agentDir || !provider || !model) throw new Error('set PI_LIVE_AGENT_DIR, PI_LIVE_PROVIDER and PI_LIVE_MODEL');

const dir = temp('mcp-events-live-');
const upstream = join(dir, 'upstream.jsonl');
writeFileSync(upstream, '');
writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { tickets: { command: process.execPath, args: ['--no-warnings', FIXTURE], env: { FIXTURE_UPSTREAM: upstream, FIXTURE_HEARTBEAT_MS: '5000' } } } }, null, 2));
const home = join(dir, 'home');
mkdirSync(home);
const cwd = join(dir, 'project');
mkdirSync(cwd);

const say = (who: string, text: string) => console.log(`\n[${who}] ${text}`);
const pi = new Pi({
    extensions: [EXTENSION],
    agentDir,
    cwd,
    model: { provider, id: model },
    env: { HOME: home, MCP_EVENTS_STATE: join(dir, 'state') },
    answer: (r) => {
        say('Pi asks the user', `${r.title}\n${r.message ?? ''}`);
        say('user answers', 'yes');
        return r.method === 'confirm' ? true : undefined;
    }
});
const settled = () => pi.records.filter((r) => r.type === 'agent_settled').length;
const show = (from: number) => {
    for (const r of pi.records.slice(from)) {
        if (r.type === 'tool_execution_start') say('tool call', `${String(r.toolName)} ${JSON.stringify(r.args ?? '')}`.slice(0, 400));
        if (r.type === 'tool_execution_end') {
            const c = (r.result as { content?: { text?: string }[] } | undefined)?.content ?? [];
            say(`tool result${r.isError ? ' (error)' : ''}`, c.map((x) => x.text ?? '').join(' ').slice(0, 400));
        }
        if (r.type === 'message_end') {
            const m = r.message as { role: string; customType?: string; content: unknown };
            if (m.role === 'custom') say(`message from ${m.customType}`, String(m.content));
            if (m.role === 'assistant') {
                const text = (Array.isArray(m.content) ? m.content : []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('');
                if (text) say('Pi', text);
            }
        }
    }
};

await pi.ready(60000);
let from = pi.records.length;
const ask = 'Watch the tickets MCP server for new tickets. When one comes in, tell me its title and priority.';
say('user', ask);
await pi.prompt(ask, 300000);
show(from);

say('test', 'Pi is idle. A ticket is created at the server.');
from = pi.records.length;
const before = settled();
appendFileSync(upstream, JSON.stringify({ eventId: 'evt-live-1', name: 'ticket.created', timestamp: new Date().toISOString(), data: { id: 'T-104', title: 'VPN drops every 10 minutes', priority: 'high', reporter: 'dana@example.com' } }) + '\n');
await waitFor(() => settled() > before, 300000, 'the woken turn to settle');
show(from);

from = pi.records.length;
const stop = 'Thanks. Stop watching for tickets now.';
say('user', stop);
await pi.prompt(stop, 300000);
show(from);
await pi.stop();
