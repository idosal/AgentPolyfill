// The plugin's MCP server, as Codex starts it (.mcp.json): read_resource_link over stdio.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { App } from './app.ts';
import { AppServerReader } from './appserver.ts';
import { codexHomeOf, disabled, stateDirOf } from './config.ts';
import { serve } from './mcp.ts';
import { PLUGIN, VERSION } from './version.ts';

const pluginRoot = process.env.PLUGIN_ROOT || process.cwd();
const codexHome = codexHomeOf(process.env, pluginRoot);
const state = stateDirOf(process.env, pluginRoot);
const log = (line: string) => {
    try {
        mkdirSync(state, { recursive: true, mode: 0o700 });
        appendFileSync(join(state, `${PLUGIN}.log`), `${new Date().toISOString()} [${process.pid}] ${line}\n`, { mode: 0o600 });
    } catch {
        // nowhere to log to
    }
};

const reader = new AppServerReader(codexHome, process.env, log);
const off = disabled(process.env);
log(`${PLUGIN} ${VERSION} started${off ? ', turned off by MCP_RESOURCE_LINKS_DISABLED' : ''}; notes in ${state}`);
const { done } = serve({ app: new App({ state, reader, log }), input: process.stdin, output: process.stdout, disabled: off, log });
done.then(() => {
    reader.close();
    process.exit(0);
});
