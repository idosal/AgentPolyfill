// The world the Pi tests run in: an agent directory whose mcp.json names the
// hand-written Events server (the Claude Code form's fixture, which shares no
// code with the client), and that server's upstream file, to emit events into.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temp, type Rule } from './pi-rpc.ts';

export const EXTENSION = fileURLToPath(new URL('../extension/dist/index.js', import.meta.url));
export const FIXTURE = fileURLToPath(new URL('../../claude-code/test/fixture-events-server.ts', import.meta.url));

/** An agent directory whose mcp.json names the hand-written Events server, and its upstream file. */
export function world(fixtureEnv: Record<string, string> = {}, name = 'tickets') {
    const dir = temp('mcp-events-pi-');
    const agentDir = join(dir, 'agent');
    const upstream = join(dir, 'upstream.jsonl');
    const fixtureLog = join(dir, 'fixture.jsonl');
    writeFileSync(upstream, '');
    const env = { FIXTURE_UPSTREAM: upstream, FIXTURE_LOG: fixtureLog, FIXTURE_HEARTBEAT_MS: '1000', FIXTURE_POLL_MS: '300', ...fixtureEnv };
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { [name]: { command: process.execPath, args: ['--no-warnings', FIXTURE], env } } }, null, 2));
    let n = 0;
    return {
        dir,
        agentDir,
        upstream,
        emit(eventName: string, data: Record<string, unknown>) {
            const eventId = `evt_${++n}_${Date.now()}`;
            appendFileSync(upstream, JSON.stringify({ eventId, name: eventName, timestamp: new Date().toISOString(), data }) + '\n');
            return eventId;
        },
        methods(): string[] {
            if (!existsSync(fixtureLog)) return [];
            return readFileSync(fixtureLog, 'utf8')
                .split('\n')
                .filter(Boolean)
                .map((l) => (JSON.parse(l) as { dir: string; m: { method?: string } }))
                .filter((r) => r.dir === 'in' && r.m.method)
                .map((r) => r.m.method!);
        }
    };
}

/** The stand-in model's rules: watch on "watch <server> <event>", read the event a wake names, then answer. */
export const RULES: Rule[] = [
    { when: '^watch (\\S+) (\\S+)$', call: { name: 'watch_event', args: { server: '$1', event: '$2', note: 'triage it' } } },
    { when: '\\[event (e\\d+);', call: { name: 'get_event', args: { id: '$1' } } },
    { when: '^Event (e\\d+), as the server', say: 'handled $1' }
];
