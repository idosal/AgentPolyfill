#!/usr/bin/env node
// mcp-tasks for Codex: the plugin's MCP server.
//
// Codex starts this (plugin/.mcp.json) for each session, over stdio. Each tool call says, in
// `_meta.threadId`, which session it is from; a task belongs to that session. See app.ts.

import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { oneLine, secrets } from '../../core/src/untrusted.ts';
import { isHttp } from '../../core/src/upstream.ts';
import { App, PLUGIN } from './app.ts';
import { codexHome, readCodexServers } from './codex-config.ts';
import { serve } from './mcp-server.ts';
import { threadOf } from './meta.ts';
import { VERSION } from './version.ts';
import { codexNotFound, findCodex, queueMessage } from './waker.ts';

const env = process.env;
const off = env.MCP_TASKS_OFF === '1';
const base = env.MCP_TASKS_STATE || join(codexHome(env), 'mcp-tasks');
mkdirSync(base, { recursive: true, mode: 0o700 });

// The log is the user's: private, a few megabytes at most, with known secrets taken out.
const logFile = join(base, 'mcp-tasks.log');
try {
    if (existsSync(logFile) && statSync(logFile).size > 2 * 1024 * 1024) renameSync(logFile, logFile + '.1');
    if (!existsSync(logFile)) writeFileSync(logFile, '', { mode: 0o600 });
    chmodSync(logFile, 0o600);
} catch {
    // best effort
}
const log = (s: string) => {
    try {
        appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${oneLine(secrets.scrub(s), 600)}\n`);
    } catch {
        // best effort
    }
};
process.on('unhandledRejection', (e) => log(`unexpected failure (${e instanceof Error ? e.message : String(e)})`));
log(`mcp-tasks ${VERSION} for Codex started${off ? ' (MCP_TASKS_OFF=1: doing nothing)' : ''}`);

const table = off ? { servers: {}, skipped: {} } : readCodexServers(env, log);
for (const cfg of Object.values(table.servers)) {
    if (isHttp(cfg)) secrets.add(...Object.values(cfg.headers ?? {}));
    else secrets.add(...Object.values(cfg.env ?? {}));
}

const codex = findCodex(env);
if (!off && !codex) log(`${codexNotFound()}; tasks are followed, but a session can't be woken`);

const app = new App({
    table,
    base,
    clientInfo: { name: `${PLUGIN}-codex`, version: VERSION },
    off,
    log,
    connectTimeoutMs: Number(env.MCP_TASKS_CONNECT_TIMEOUT_MS ?? 10000),
    minPollMs: env.MCP_TASKS_MIN_POLL_MS ? Number(env.MCP_TASKS_MIN_POLL_MS) : undefined,
    wake: async (thread, text) => (codex ? queueMessage(codex, thread, text, env) : { ok: false, why: codexNotFound() })
});

const server = serve({
    name: PLUGIN,
    title: 'MCP Tasks (polyfill)',
    version: VERSION,
    instructions: () => app.instructions(),
    tools: () => app.tools(),
    onInitialize: (caps, info) => {
        log(`Codex connected (${oneLine(JSON.stringify(info), 120)}); it declares extensions: ${oneLine(JSON.stringify(Object.keys((caps.extensions as object) ?? {})), 200)}`);
        app.initialized(caps);
        app.resumeAll();
    },
    async call(name, args, ctx) {
        const thread = threadOf(ctx.meta);
        const trigger = (ctx.meta['x-codex-turn-metadata'] as { turn_trigger?: unknown } | undefined)?.turn_trigger;
        log(`${oneLine(name, 40)} from session ${thread?.slice(0, 8) ?? '(none)'} (turn started by ${typeof trigger === 'string' ? oneLine(trigger, 40) : 'unknown'})`);
        return app.call(name, args, ctx, thread);
    },
    input: process.stdin,
    output: process.stdout,
    log
});

const parent = process.ppid;
const tick = setInterval(() => {
    if (process.ppid !== parent) return void stop();
    app.recheck();
}, 5000);
tick.unref();

let stopping = false;
async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearInterval(tick);
    setTimeout(() => process.exit(0), 5000).unref();
    await app.stop().catch(() => {});
    log('stopped');
    process.exit(0);
}
void server.done.then(() => stop());
process.on('SIGTERM', () => void stop());
process.on('SIGHUP', () => void stop());
process.on('SIGINT', () => void stop());
