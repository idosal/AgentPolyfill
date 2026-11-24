// An OpenCode server for trying the plugins in OpenCode's own TUI, by hand: the
// same throwaway world as live.ts (a real model that needs no sign-in, the four
// plugins, an `ask` rule for each plugin action, shell and edits denied), kept
// running until this process is stopped. It writes what a TUI needs to attach
// to <out>/world.json (mode 600: it holds the throwaway server's password),
// and appends an event to the fixture server when <out>/emit appears.
//
//   node --no-warnings tools/opencode/tui-world.ts <out folder> [provider/model]
//
// Then, with the environment world.json gives:
//   opencode --server <url> <project>

import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { REPO, World } from './harness.ts';

const out = process.argv[2];
if (!out) throw new Error('usage: tui-world.ts <out folder> [provider/model]');
const model = process.argv[3] ?? 'opencode/deepseek-v4.1-flash-free';
mkdirSync(out, { recursive: true });
const plugin = (p: string) => join(REPO, 'polyfills', p, 'opencode', 'plugin');
const upstream = join(out, 'upstream.jsonl');
writeFileSync(upstream, '');

const world = new World({
    model,
    plugins: [plugin('events'), plugin('skills'), plugin('server-cards'), plugin('ard')],
    mcp: {
        tickets: {
            type: 'local',
            command: [process.execPath, '--no-warnings', join(REPO, 'polyfills', 'events', 'claude-code', 'test', 'fixture-events-server.ts')],
            environment: { FIXTURE_UPSTREAM: upstream, FIXTURE_TICKET_DELIVERY: 'poll', FIXTURE_POLL_MS: '1000' }
        },
        huggingface: { type: 'remote', url: 'https://huggingface.co/mcp', oauth: false }
    },
    permissions: [
        ...['mcp_events_watch', 'mcp_events_unwatch', 'mcp_skills_load', 'mcp_skills_cross_server', 'mcp_server_cards_add', 'mcp_server_cards_remove', 'ard_search'].map((action) => ({ action, resource: '*', effect: 'ask' as const })),
        ...['shell', 'edit'].map((action) => ({ action, resource: '*', effect: 'deny' as const }))
    ],
    env: { MCP_EVENTS_WAKE_GAP_S: '0' }
});

await world.start();
const env = Object.fromEntries(Object.entries(world.env).filter(([k]) => k !== 'PATH')) as Record<string, string>;
writeFileSync(join(out, 'world.json'), JSON.stringify({ url: world.url, project: world.project, dir: world.dir, env }, null, 2), { mode: 0o600 });
console.log(`ready ${world.url} ${world.project}`);

// An event, on request: touch <out>/emit.
const tick = setInterval(() => {
    const flag = join(out, 'emit');
    if (!existsSync(flag)) return;
    rmSync(flag);
    appendFileSync(upstream, JSON.stringify({ eventId: `evt_${randomUUID().slice(0, 8)}`, name: 'ticket.created', timestamp: new Date().toISOString(), data: { title: 'Printer on fire on floor 3', priority: 'high' } }) + '\n');
    console.log('emitted');
}, 300);

const stop = async () => {
    clearInterval(tick);
    await world.stop({ keep: true });
    console.log(`stopped; world kept at ${world.dir}`);
    process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
