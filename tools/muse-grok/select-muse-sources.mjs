// Choose existing Muse connections without importing their credentials into the kit.
import { readConfig } from './config.ts';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const [feature, ...names] = process.argv.slice(2);
const ids = { skills: 'mcp-skill-reference', events: 'mcp-event-monitor' };
if (!Object.hasOwn(ids, feature) || !names.length || names.some(n => !/^[a-z0-9][a-z0-9_.:@-]{0,63}$/i.test(n) && n !== '--clear') ||
    (names.includes('--clear') && names.length !== 1)) {
    console.error('Usage: node select-muse-sources.mjs skills|events NAME [NAME ...] | --clear');
    process.exit(2);
}
const selected = names[0] === '--clear' ? [] : [...new Set(names)];
const config = isAbsolute(process.env.XDG_CONFIG_HOME ?? '') ? process.env.XDG_CONFIG_HOME : join(homedir(), '.config');
const data = isAbsolute(process.env.XDG_DATA_HOME ?? '') ? process.env.XDG_DATA_HOME : join(homedir(), '.local', 'share');
const settingsPath = join(config, 'muse/settings.json');
const settings = selected.length && existsSync(settingsPath) ? readConfig(settingsPath) : {};
if (selected.length) {
    const servers = settings.mcpServers ?? {};
    for (const name of selected) {
        if (!Object.hasOwn(servers, name) || servers[name]?.enabled === false || servers[name]?.disabled === true) {
            throw Error('Unknown or disabled Muse connection: ' + name);
        }
    }
}
const dir = join(data, 'muse/plugins/data', ids[feature]);
mkdirSync(dir, { recursive: true, mode: 0o700 });
for (const [filename, value] of [['native-config-home.json', config], ['muse-servers.json', selected]]) {
    const tmp = join(dir, '.' + randomUUID());
    writeFileSync(tmp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(tmp, join(dir, filename));
}
// Populate the native inventory before Muse builds the first conversation's skill list.
if (feature === 'skills' && (!selected.length || settings.runtime_capabilities?.['plugin:mcp-skill-reference:mcp_server:skills']?.enabled === true)) {
    const reader = fileURLToPath(new URL('../../polyfills/skills/muse/plugin/dist/server.mjs', import.meta.url));
    const action = selected.length ? '--refresh-native-list' : '--clear-native-list';
    const result = spawnSync(process.execPath, [reader, action], {
        env: { HOME: homedir(), PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, MUSE_PLUGIN_DATA_DIR: dir },
        stdio: 'inherit', timeout: 30000
    });
    if (result.status !== 0) {
        if (!selected.length) throw Error('Selection cleared. Native inventory cleanup failed. Close Muse and rerun with --clear.');
        console.warn('The selection was saved. Catalog refresh will retry in Muse.');
    }
}
console.log('Selected Muse connections for ' + feature + ': ' + (selected.join(', ') || '(none)') + '. Open a fresh trusted session.');
