#!/usr/bin/env node
// mcp-skills for Muse Code: the plugin's MCP server (mod/muse/dist/helper.js, bundled from here).
//
// Muse starts it from the plugin's .muse-plugin/plugin.json, once per session, with the session's
// id in MUSE_SESSION_ID. It runs the Codex form's code unchanged (../../codex/src: the app, the
// store, the stub text and the tools), with what differs in Muse (muse.ts): the servers in Muse's
// own settings, the stubs flat in Muse's own skill folder (stubs.ts, swapped in by build.mjs), and
// the person's yes typed as a message of their own, which the plugin's UserPromptSubmit hook reads
// (muse-confirm.ts, muse-prompt-hook.ts).
//
// On disk: the stubs (~/.config/muse/skills/mcp-skills-served--*), and the plugin's store in the
// data folder Muse gives it. No skill content, no tokens.

import { appendFileSync, chmodSync, existsSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describeError, oneLine, secrets } from '../../core/src/untrusted.ts';
import { App } from '../../codex/src/app.ts';
import { declaresSkills } from '../../codex/src/mcp.ts';
import { Store } from '../../codex/src/store.ts';
import { museAsk, museManagedFor, museSession, museStoreDir, museStubRoot, museWords, readMuseSkillsConfig } from './muse.ts';
import { serveMuse } from './serve.ts';
import { VERSION } from './version.ts';

const env = process.env;
const store = new Store(museStoreDir(env));

const logFile = join(store.dir, 'mcp-skills.log');
try {
    if (existsSync(logFile) && statSync(logFile).size > 2 * 1024 * 1024) renameSync(logFile, `${logFile}.1`);
    if (!existsSync(logFile)) writeFileSync(logFile, '', { mode: 0o600 });
    chmodSync(logFile, 0o600);
} catch {
    // logging is best effort
}
const log = (s: string) => {
    try {
        appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${oneLine(secrets.scrub(s), 600)}\n`);
    } catch {
        // no log
    }
};
process.on('unhandledRejection', (e) => log(`unexpected failure (${describeError(e)})`));
process.on('uncaughtException', (e) => log(`unexpected failure (${describeError(e)})`));

const settings = store.settings();
// An organisation's Muse policy (muse config status) means no server is reached, as a managed Codex policy does.
const managed = settings.off ? undefined : museManagedFor(env);
const config = readMuseSkillsConfig(env, { only: settings.servers, skip: settings.skip, managed });
const stubRoot = env.MCP_SKILLS_STUBS ? resolve(env.MCP_SKILLS_STUBS) : museStubRoot(env);
const app = new App({
    table: config.table,
    store,
    stubRoot,
    // Muse turns a listed skill off itself (muse skills disable): it is not in Muse's list, so it is not offered.
    skillRules: () => [],
    log,
    connectTimeoutMs: Number(env.MCP_SKILLS_CONNECT_TIMEOUT_MS ?? 10_000)
});
log(`mcp-skills ${VERSION} for Muse: ${Object.keys(config.table.servers).length} server(s) to look at in ${config.file}; stubs in ${stubRoot}`);

const { done } = serveMuse({
    app,
    input: process.stdin,
    output: process.stdout,
    log,
    ask: museAsk(store.dir, museSession(env), Date.now, museWords),
    words: museWords,
    onInitialize: (caps, info) => {
        log(`client ${oneLine(String(info.name ?? ''), 60)} ${oneLine(String(info.version ?? ''), 30)}`);
        if (declaresSkills(caps)) app.standDown('the client declares the MCP Skills extension itself');
    }
});

if (settings.off) app.standDown('settings.json says off');
else void app.start();

void done.then(async () => {
    await app.stop().catch(() => {});
    process.exit(0);
});
process.on('SIGTERM', () => void app.stop().finally(() => process.exit(0)));
