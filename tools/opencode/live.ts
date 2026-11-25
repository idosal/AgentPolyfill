// A live run of the four OpenCode plugins, by hand (not in CI): a real model,
// a real OpenCode server, and real public servers, in a throwaway home with no
// sign-in of yours. Each plugin's permission action has an `ask` rule, and
// every request is answered "once" here and printed, so the run shows what
// you would be asked. Shell commands and file edits are denied for the run.
//
//   node --no-warnings tools/opencode/live.ts [provider/model] [out folder]
//
// The default model is one of OpenCode's free ones, which need no account:
// what the run sends it are the prompts below and the tool results they lead
// to (the fixture's events, Hugging Face's skills, neon.com's catalog).

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { freePort, REPO, sleep, World, type Message } from './harness.ts';

const model = process.argv[2] ?? 'opencode/deepseek-v4.1-flash-free';
const out = process.argv[3] ?? join(tmpdir(), `opencode-live-${Date.now()}`);
mkdirSync(out, { recursive: true });
const transcript = join(out, 'transcript.md');
const say = (s: string) => {
    console.log(s);
    appendFileSync(transcript, s + '\n');
};

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
            // LIVE_TICKET_DELIVERY (for example "poll,push") changes how the fixture offers tickets.
            environment: { FIXTURE_UPSTREAM: upstream, FIXTURE_TICKET_DELIVERY: process.env.LIVE_TICKET_DELIVERY ?? 'poll', FIXTURE_POLL_MS: '1000' }
        },
        huggingface: { type: 'remote', url: 'https://huggingface.co/mcp', oauth: false }
    },
    permissions: [
        ...['mcp_events_watch', 'mcp_events_unwatch', 'mcp_skills_load', 'mcp_skills_cross_server', 'mcp_server_cards_add', 'mcp_server_cards_remove', 'ard_search'].map((action) => ({ action, resource: '*', effect: 'ask' as const })),
        // A served skill can tell the model to run things, and OpenCode's default allows it. In a run by
        // hand on your machine, nothing runs or changes: shell and edits are denied (a first run, with
        // them allowed, ran `uvx hf-mem` as a Hugging Face skill told it to).
        ...['shell', 'edit'].map((action) => ({ action, resource: '*', effect: 'deny' as const }))
    ],
    env: { MCP_EVENTS_WAKE_GAP_S: '0' }
});

const text = (m: Message): string => {
    const parts = (m.parts ?? m.content) as unknown;
    if (typeof m.text === 'string') return m.text;
    if (Array.isArray(parts)) return parts.map((p: { text?: string; type?: string; tool?: string }) => p.text ?? (p.tool ? `[tool ${p.tool}]` : '')).join('');
    return JSON.stringify(m).slice(0, 400);
};

/** Waits for the session to go idle, answering this run's permission requests "once" and printing each. */
async function settle(session: string, since: number, timeoutMs = 240000) {
    const end = Date.now() + timeoutMs;
    const answered = new Set<string>();
    while (Date.now() < end) {
        for (const p of await world.permissions(session).catch(() => [])) {
            if (answered.has(p.id)) continue;
            answered.add(p.id);
            say(`\n> **OpenCode asks:** \`${p.action}\` on \`${p.resources.join(', ')}\`${p.metadata ? `\n> metadata: \`${JSON.stringify(p.metadata).slice(0, 600)}\`` : ''}\n> answered: once`);
            await world.reply(session, p.id, 'once');
        }
        const t = (await world.session(session)).time;
        if ((t.busy ?? 0) > since && (t.idle ?? 0) >= (t.busy ?? 0) && !(await world.permissions(session).catch(() => [])).length) return;
        await sleep(700);
    }
    say('\n(timed out waiting for the session to go idle)');
}

async function ask(session: string, prompt: string) {
    say(`\n### You\n\n${prompt}`);
    const before = (await world.messages(session)).length;
    const since = Date.now();
    await world.prompt(session, prompt);
    await settle(session, since);
    for (const m of (await world.messages(session)).slice(before + 1)) say(`\n**${m.type}:** ${text(m).slice(0, 1500)}`);
}

try {
    await world.start();
    say(`# Live run: ${new Date().toISOString()}, OpenCode 2.4.1, model ${model}\n`);

    say('\n## Events');
    const ev = await world.createSession();
    await ask(ev, 'Which events can my MCP servers report? Then watch the tickets server for new tickets; when one is created, tell me its title in one sentence.');
    await sleep(3000);
    const before = (await world.session(ev)).time.idle ?? 0;
    appendFileSync(upstream, JSON.stringify({ eventId: `evt_${randomUUID().slice(0, 8)}`, name: 'ticket.created', timestamp: new Date().toISOString(), data: { title: 'Printer on fire on floor 3', priority: 'high' } }) + '\n');
    say('\n(an event is emitted on the fixture server; nobody types anything)');
    const len = (await world.messages(ev)).length;
    await settle(ev, before, 180000);
    for (const m of (await world.messages(ev)).slice(len)) say(`\n**${m.type}:** ${text(m).slice(0, 1500)}`);

    say('\n## Skills');
    const sk = await world.createSession();
    await ask(sk, 'Which GGUF quantization should I use to run a 7B model on a 16 GB Mac? Use a skill from my MCP servers if one fits.');
    // X8: this session loaded Hugging Face's skills; a read of another server's resource is asked about first.
    await ask(sk, 'Now read the MCP resource fixture://status from the tickets server, with OpenCode\'s read_mcp_resource tool.');

    say('\n## Server Cards');
    const sc = await world.createSession();
    await ask(sc, 'What MCP servers does neon.com publish?');
    await ask(sc, 'Add Neon Docs.');
    say(`\nOpenCode's MCP servers now: ${JSON.stringify((await world.api<{ data: unknown[] }>('GET', `/api/mcp?location[directory]=${encodeURIComponent(world.project)}`)).data)}`);

    say('\n## ARD');
    const ard = await world.createSession();
    await ask(ard, 'What does buildkite.com list in its ard.json? Use ARD discovery.');
    // A registry search, to the repository's demo registry on loopback (it reads ten publishers' live catalogs).
    const port = await freePort();
    const registry = spawn(process.execPath, [join(REPO, 'polyfills', 'ard', 'claude-code', 'demo', 'registry.mjs'), String(port)], { stdio: 'ignore' });
    try {
        await sleep(8000);
        await ask(ard, `Search the ARD registry at http://127.0.0.1:${port} for an MCP server that can check why my CI build failed.`);
    } finally {
        registry.kill();
    }
} finally {
    await world.stop({ keep: true });
    say(`\n(world kept at ${world.dir}; transcript ${transcript})`);
}
