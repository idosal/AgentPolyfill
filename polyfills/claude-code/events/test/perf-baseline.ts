// The same idle measurement as test/perf.ts, for the plugin as it was before it became a mod:
// two processes (a stdio MCP server and a monitor), built from the first commit.
//
//   node --no-warnings test/perf-baseline.ts <folder holding that commit's dist/main.js and dist/monitor.js>
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { sleep, world } from './harness.ts';

const old = process.argv[2]!;
const say = (what: string, value: string) => console.log(`${what.padEnd(58)} ${value}`);
function ps(pid: number): { rssMiB: number; cpuMs: number } {
    const [rss, time] = execFileSync('ps', ['-o', 'rss=,time=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/);
    const parts = time!.replace('-', ':').split(':').map(Number);
    return { rssMiB: Number(rss) / 1024, cpuMs: parts.reduce((acc, p) => acc * 60 + p, 0) * 1000 };
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const envFor = (w: ReturnType<typeof world>) => ({ PATH: process.env.PATH!, HOME: w.dir, MCP_EVENTS_CONFIG: w.config, MCP_EVENTS_STATE: w.state, CLAUDE_CODE_SESSION_ID: 'sess-a', CLAUDE_PROJECT_DIR: w.project, MCP_EVENTS_DEV: '1' });

console.log(`# the plugin before the mod (stdio MCP server + monitor), node ${process.version}, bundles`);
const starts: number[] = [];
for (let i = 0; i < 5; i++) {
    const w = world();
    const t0 = performance.now();
    const client = new Client({ name: 'perf', version: '0' }, { versionNegotiation: { mode: 'auto' } } as never);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--no-warnings', join(old, 'dist', 'main.js')], env: envFor(w), stderr: 'ignore' }));
    starts.push(performance.now() - t0);
    await client.close();
}
say('start → MCP server answers initialize, 1 stdio server', `${median(starts).toFixed(0)} ms (it connects to every server first)`);

const w = world({ FIXTURE_POLL_MS: '5000', FIXTURE_HEARTBEAT_MS: '15000' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-warnings', join(old, 'dist', 'main.js')], env: envFor(w), stderr: 'ignore' });
const client = new Client({ name: 'perf', version: '0' }, { versionNegotiation: { mode: 'auto' } } as never);
await client.connect(transport);
const monitor = spawn(process.execPath, ['--no-warnings', join(old, 'dist', 'monitor.js'), w.state], { env: envFor(w), stdio: ['ignore', 'pipe', 'ignore'] });
monitor.stdout.resume();
for (const priority of ['high', 'low', 'medium', 'urgent']) await client.callTool({ name: 'watch_event', arguments: { server: 'tickets', event: 'ticket.created', arguments: { priority } } });
await sleep(3000);
const pids = [transport.pid!, monitor.pid!];
const a = pids.map(ps);
await sleep(30000);
const b = pids.map(ps);
say('idle, 4 push watches: memory (server + monitor)', `${b[0]!.rssMiB.toFixed(0)} + ${b[1]!.rssMiB.toFixed(0)} = ${(b[0]!.rssMiB + b[1]!.rssMiB).toFixed(0)} MiB`);
const cpu = b[0]!.cpuMs - a[0]!.cpuMs + (b[1]!.cpuMs - a[1]!.cpuMs);
say('idle, 4 push watches: CPU over 30 s (server + monitor)', `${cpu.toFixed(0)} ms (${((cpu / 30000) * 100).toFixed(2)} % of one core)`);
monitor.kill();
await client.close();
process.exit(0);
