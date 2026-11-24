// Measures the bundled helper as an installed copy runs it: time to ready and to the first
// listing, the first load, memory and CPU while idle and under load. Servers are the test fixture
// (a local stdio server), so the numbers are the mod's own and not a network's.
//
//   node --no-warnings tools/measure.ts [--servers=N] [--skills=K] [--dead] [--loads=L]
//
// --dead adds a server that starts and never answers (as a hung local server does): what a
// slow or broken server costs the others.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fixture, scenarioOf, skill } from '../test/harness.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = join(ROOT, 'mod', 'dist', 'helper.js');
const arg = (name: string, d: number) => Number(/=(\d+)$/.exec(process.argv.find((a) => a.startsWith(`--${name}=`)) ?? '')?.[1] ?? d);
const SERVERS = arg('servers', 3);
const SKILLS = arg('skills', 20);
const LOADS = arg('loads', 300);
const dead = process.argv.includes('--dead');

const fixtures = Array.from({ length: SERVERS }, (_, i) => new Fixture(scenarioOf(Array.from({ length: SKILLS }, (_, j) => skill(`s${i}-${j}`, { 'references/guide.md': `# Guide ${j}\n${'text '.repeat(200)}` })))));
const dir = mkdtempSync(join(tmpdir(), 'mcp-skills-measure-'));
// The servers file of one's own must be outside the project folder: the project is a folder beside it.
mkdirSync(join(dir, 'project'));
const servers: Record<string, unknown> = Object.fromEntries(fixtures.map((f, i) => [`srv${i}`, f.config]));
if (dead) servers.hung = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1e9)'] };
writeFileSync(join(dir, 'servers.json'), JSON.stringify({ mcpServers: servers }));

const ms = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6;
const usage = (pid: number) => {
    const [rss, time] = spawnSync('ps', ['-o', 'rss=,time=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim().split(/\s+/);
    const [m, s] = String(time).split(':');
    return { rssMb: Number(rss) / 1024, cpuS: Number(m) * 60 + Number(s) };
};

const t0 = process.hrtime.bigint();
const child = spawn(process.execPath, ['--no-warnings', BUNDLE], { env: { PATH: process.env.PATH ?? '', HOME: dir, MCP_SKILLS_STATE: dir, MCP_SKILLS_CONFIG: join(dir, 'servers.json'), CLAUDE_PROJECT_DIR: join(dir, 'project') }, stdio: ['ignore', 'pipe', 'inherit'] });
const seen: Record<string, number> = {};
let ready: { url: string; token: string } | undefined;
let catalogs = 0;
let firstSkills = -1;
let buffer = '';
const got = new Promise<void>((done) => {
    child.stdout!.on('data', (d: Buffer) => {
        buffer += String(d);
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
            const m = JSON.parse(buffer.slice(0, end)) as { t: string; url?: string; token?: string; skills?: number };
            buffer = buffer.slice(end + 1);
            if (m.t === 'ready') ready = { url: m.url!, token: m.token! };
            if (m.t === 'catalog') {
                catalogs++;
                if (firstSkills < 0) firstSkills = m.skills ?? 0;
                const c = m as { complete?: boolean };
                seen[`catalog ${catalogs} (${m.skills} skills${c.complete === false ? ', not complete yet' : ''})`] = ms(t0);
                if (c.complete !== false) done();
            }
            seen[m.t] ??= ms(t0);
        }
    });
});
await Promise.race([got, new Promise((_, no) => setTimeout(() => no(new Error(`no full listing within 60 s: ${JSON.stringify(seen)}`)), 60_000))]);
const post = async (route: string, body: unknown) => (await (await fetch(`${ready!.url}${route}`, { method: 'POST', headers: { authorization: `Bearer ${ready!.token}` }, body: JSON.stringify(body) })).json()) as { text?: string; isError?: boolean };
await new Promise((r) => setTimeout(r, 3000));
const idle = usage(child.pid!);
const first = process.hrtime.bigint();
const one = await post('/tool', { name: 'load_skill', input: { server: 'srv0', uri: 'skill://s0-0/SKILL.md' } });
const firstLoad = ms(first);
if (one.isError) throw new Error(String(one.text));
const loadT = process.hrtime.bigint();
for (let i = 0; i < LOADS; i++) {
    const s = i % SERVERS;
    const k = i % SKILLS;
    const r = await post('/tool', { name: 'load_skill', input: { server: `srv${s}`, uri: `skill://s${s}-${k}/SKILL.md` } });
    const f = await post('/tool', { name: 'read_skill_file', input: { server: `srv${s}`, skill: `skill://s${s}-${k}/SKILL.md`, path: 'references/guide.md' } });
    if (r.isError || f.isError) throw new Error(String(r.text ?? f.text));
}
const loadMs = ms(loadT);
const loaded = usage(child.pid!);
child.kill();
await Promise.all(fixtures.map(() => undefined));
rmSync(dir, { recursive: true, force: true });
for (const f of fixtures) rmSync(f.dir, { recursive: true, force: true });

console.log(JSON.stringify({ servers: SERVERS, skillsEach: SKILLS, hungServer: dead, ms: seen, firstCatalogSkills: firstSkills, idle: { ...idle, afterMs: 3000 }, firstLoadMs: +firstLoad.toFixed(1), load: { calls: LOADS * 2, ms: +loadMs.toFixed(0), perCallMs: +(loadMs / LOADS / 2).toFixed(2), ...loaded } }, null, 1));
process.exit(0);
