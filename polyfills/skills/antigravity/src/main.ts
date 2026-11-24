import { appendFileSync, chmodSync, existsSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../codex/src/store.ts';
import { TOOLS } from '../../codex/src/mcp.ts';
import { describeError, oneLine, secrets } from '../../core/src/untrusted.ts';
import { serve, type Tool } from '../../../server-cards/codex/src/mcp.ts';
import { runHook, stateDir, TICKET_ARG } from '../../../server-cards/antigravity/src/gate.ts';
import { App } from './app.ts';
import { handlers } from './approval.ts';
import { homeOf, isOff, NAME, VERSION } from './config.ts';

/** The plugin's MCP server as Antigravity names it: `<plugin>_<key in mcp_config.json>`. */
export const SERVER = 'mcp-skills_skills';
import { stubRootOf } from './stubs.ts';

export const INSTRUCTIONS = 'MCP-served skills for Antigravity. list_skills shows origins and metadata; load_skill requires the plugin approval hook and returns verified server content. Stubs in the personal skills folder only say how to load a skill. Read supporting files with read_skill_file and list_skill_directory, never as local files. The approval card offers yes/no, with no private content preview.';

export function tools(app: App): Tool[] {
    return TOOLS.map(def => {
        const schema = JSON.parse(JSON.stringify(def.inputSchema));
        if (schema.properties.server) schema.properties.server.description = 'The server label in your personal Antigravity mcp_config.json.';
        if (def.name !== 'list_skills') schema.properties[TICKET_ARG] = { type: 'string', description: 'Added by the plugin hook. Do not invent or reuse a ticket.' };
        return { ...def, inputSchema: schema, run: args => app.call(def.name, args) };
    });
}

export async function start(env: NodeJS.ProcessEnv = process.env, argv = process.argv.slice(2)) {
    const dir = stateDir(NAME, env), store = new Store(dir);
    if (argv.includes('--hook')) return runHook(handlers(env, store), dir, SERVER);
    const logFile = join(dir, 'mcp-skills.log');
    try {
        if (existsSync(logFile) && statSync(logFile).size > 2 * 1024 * 1024) renameSync(logFile, `${logFile}.1`);
        if (!existsSync(logFile)) writeFileSync(logFile, '', { mode: 0o600 });
        chmodSync(logFile, 0o600);
    } catch {}
    const log = (s: string) => { try { appendFileSync(logFile, `${new Date().toISOString()} ${oneLine(secrets.scrub(s), 600)}\n`); } catch {} };
    const app = new App({ env, store, stubRoot: stubRootOf(homeOf(env)), log });
    const off = isOff(env, store);
    serve({ name: NAME, version: VERSION, instructions: off ? undefined : INSTRUCTIONS, tools: off ? [] : tools(app), log });
    void app.start().catch(e => log(describeError(e)));
    const stop = () => void app.stop().finally(() => process.exit(0));
    process.stdin.on('end', stop);
    process.on('SIGTERM', stop);
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
    void start().catch(() => {
        // Hooks fail open on nonzero exit. Even a failure before runHook must be an explicit deny.
        if (process.argv.includes('--hook')) { process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'The plugin could not initialize its private approval state.' }) + '\n'); process.exitCode = 0; }
        else process.exitCode = 1;
    });
}
