// A live run of mcp-events for OpenCode against public infrastructure, by hand
// (not in CI), with a real model in a throwaway home:
//
// 1. Poll, from a public server: AgentPolyfill's event-feeds
//    (https://event-feeds.idosalomon.workers.dev/mcp). The model makes a demo
//    button with the server's own tool and watches its presses; this script
//    presses it, as the button's page would, and the idle session should wake.
// 2. Webhook, through the public relay (MCP_EVENTS_RELAY=public, run by
//    AgentPolyfill's author): the fixture server's webhook-only deploy.finished
//    is delivered, signed, to the relay, and the plugin collects it there. The
//    fixture runs locally; MCP_EVENTS_DEV=1 lets it take a webhook subscription
//    without a sign-in (the SEP asks for an authenticated caller).
//
//   node --no-warnings tools/opencode/live-events.ts [provider/model] [out folder]

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, sleep, World, type Message } from './harness.ts';

const model = process.argv[2] ?? 'opencode/qwen4-max-free';
const out = process.argv[3] ?? join(process.env.TMPDIR ?? '/tmp', `opencode-live-events-${Date.now()}`);
mkdirSync(out, { recursive: true });
const transcript = join(out, 'transcript.md');
const say = (s: string) => {
    console.log(s);
    appendFileSync(transcript, s + '\n');
};
const FEEDS = 'https://event-feeds.idosalomon.workers.dev';
const upstream = join(out, 'upstream.jsonl');
writeFileSync(upstream, '');

const world = new World({
    model,
    plugins: [join(REPO, 'polyfills', 'events', 'opencode', 'plugin')],
    mcp: {
        feeds: { type: 'remote', url: `${FEEDS}/mcp`, oauth: false },
        deploys: {
            type: 'local',
            command: [process.execPath, '--no-warnings', join(REPO, 'polyfills', 'events', 'claude-code', 'test', 'fixture-events-server.ts')],
            environment: { FIXTURE_UPSTREAM: upstream }
        }
    },
    permissions: [
        { action: 'mcp_events_watch', resource: '*', effect: 'ask' },
        ...['shell', 'edit'].map((action) => ({ action, resource: '*', effect: 'deny' as const }))
    ],
    env: { MCP_EVENTS_WAKE_GAP_S: '0', MCP_EVENTS_RELAY: 'public', MCP_EVENTS_DEV: '1' }
});

/** A message's text: a user or synthetic message's own, or an assistant message's text parts and tool names. */
const text = (m: Message): string => {
    if (typeof m.text === 'string') return m.text;
    const payload = m.payload as { text?: string } | undefined;
    if (typeof payload?.text === 'string') return payload.text;
    const content = m.content as { type?: string; text?: string; tool?: string; name?: string }[] | undefined;
    if (Array.isArray(content)) return content.map((p) => (p.type === 'text' ? (p.text ?? '') : p.type === 'tool' ? `[tool ${p.tool ?? p.name ?? ''}] ` : '')).join('').trim();
    return JSON.stringify(m).slice(0, 300);
};
let lastAsked: { action: string; resources: string[]; metadata?: Record<string, unknown> } | undefined;

async function settle(session: string, since: number, timeoutMs = 240000) {
    const end = Date.now() + timeoutMs;
    const answered = new Set<string>();
    while (Date.now() < end) {
        for (const p of await world.permissions(session).catch(() => [])) {
            if (answered.has(p.id)) continue;
            answered.add(p.id);
            lastAsked = p;
            say(`\n> **OpenCode asks:** \`${p.action}\` on \`${p.resources.join(', ')}\`\n> metadata: \`${JSON.stringify(p.metadata ?? {}).slice(0, 500)}\`\n> answered: once`);
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
    for (const m of (await world.messages(session)).slice(before + 1)) say(`\n**${m.type}:** ${text(m).slice(0, 1200)}`);
}

async function wake(session: string, act: () => Promise<void>, what: string) {
    await sleep(3000);
    const before = (await world.session(session)).time.idle ?? 0;
    const len = (await world.messages(session)).length;
    await act();
    say(`\n(${what}; nobody types anything)`);
    await settle(session, before, 180000);
    for (const m of (await world.messages(session)).slice(len)) say(`\n**${m.type}:** ${text(m).slice(0, 1200)}`);
}

try {
    await world.start();
    say(`# Live run (events, public infrastructure): ${new Date().toISOString()}, OpenCode 2.4.1, model ${model}\n`);

    say('\n## Poll, from event-feeds');
    const a = await world.createSession();
    await ask(a, "Use the feeds MCP server's new_demo_button tool to make a demo button. Then watch the feeds server's demo.button event for that button's channel; when it is pressed, tell me the press's message in one sentence.");
    const channel = (lastAsked?.metadata?.arguments as { channel?: string } | undefined)?.channel;
    if (!channel) say('\n(no channel in the watch request: the model did not watch demo.button)');
    else
        await wake(a, async () => {
            const r = await fetch(`${FEEDS}/api/press`, { method: 'POST', headers: { 'content-type': 'application/json', origin: FEEDS }, body: JSON.stringify({ channel, message: 'Pressed by the OpenCode live run' }) });
            say(`\n(button pressed: HTTP ${r.status} ${(await r.text()).slice(0, 100)})`);
        }, 'the demo button is pressed over HTTP, as its page does');

    say('\n## Webhook, through the public relay');
    const b = await world.createSession();
    await ask(b, 'Watch the deploys MCP server for finished deploys; when one finishes, tell me which service in one sentence.');
    await wake(b, async () => {
        appendFileSync(upstream, JSON.stringify({ eventId: `evt_${randomUUID().slice(0, 8)}`, name: 'deploy.finished', timestamp: new Date().toISOString(), data: { service: 'billing', status: 'ok' } }) + '\n');
    }, 'a deploy.finished event is written on the fixture, which posts it, signed, to the relay');
} finally {
    await world.stop({ keep: true });
    say(`\n(world kept at ${world.dir}; transcript ${transcript})`);
}
