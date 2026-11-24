#!/usr/bin/env node
// mcp-skills for Codex: the plugin's MCP server (mod/dist/helper.js, bundled from here).
//
// Codex starts it with each session. It answers Codex at once, and meanwhile looks at
// the servers in the user's Codex config, lists the skills of those that declare the
// MCP Skills extension, and writes a short SKILL.md for each into the plugin's own
// skills folder, so that Codex lists them with its other skills (stubs.ts). Loading
// one goes through the load_skill tool, which asks the person first.
//
// On disk: the stubs (in the plugin's folder), and the plugin's store (store.ts) in
// $CODEX_HOME/mcp-skills. No skill content, no tokens.

import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeError, oneLine, secrets } from '../../core/src/untrusted.ts';
import { App } from './app.ts';
import { codexHomeOf, readCodexConfig, readSkillRules } from './config.ts';
import { declaresSkills, serve } from './mcp.ts';
import { Store } from './store.ts';
import { VERSION } from './version.ts';

const env = process.env;
// The bundle is <plugin>/dist/helper.js: the plugin's folder is the one above it.
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const codexHome = codexHomeOf(env, pluginRoot);
const store = new Store(env.MCP_SKILLS_STATE ? resolve(env.MCP_SKILLS_STATE) : join(codexHome, 'mcp-skills'));

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
const config = readCodexConfig(codexHome, env, { only: settings.servers, skip: settings.skip });
const stubRoot = env.MCP_SKILLS_STUBS ? resolve(env.MCP_SKILLS_STUBS) : join(pluginRoot, 'skills', 'served');
const app = new App({
    table: config.table,
    store,
    stubRoot,
    skillRules: () => readSkillRules(config.file),
    log,
    connectTimeoutMs: Number(env.MCP_SKILLS_CONNECT_TIMEOUT_MS ?? 10_000)
});
log(`mcp-skills ${VERSION}: ${Object.keys(config.table.servers).length} server(s) to look at in ${config.file}; stubs in ${stubRoot}`);

const { done } = serve({
    app,
    input: process.stdin,
    output: process.stdout,
    log,
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
