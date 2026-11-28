import { existsSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const plugins = {
    cards: ['server-cards/codex', 'mcp-server-cards'],
    ard: ['ard/codex', 'ard-discovery'],
    skills: ['skills/muse', 'mcp-skill-reference'],
    events: ['events/muse', 'mcp-event-monitor'],
    tasks: ['tasks/muse', 'mcp-task-monitor']
};
const args = process.argv.slice(2);
const approve = args.includes('--approve');
const names = args.filter(arg => arg !== '--approve');
if (!names.length || names.some(name => name !== 'all' && !Object.hasOwn(plugins, name))) {
    console.error('Usage: node install-muse.mjs all|cards|ard|skills|events|tasks ... [--approve]');
    process.exit(2);
}
const selected = names.includes('all') ? Object.keys(plugins) : [...new Set(names)];
function muse(...command) {
    const run = spawnSync('muse', command, { stdio: 'inherit' });
    if (run.error) console.error(run.error.message);
    if (run.status !== 0) process.exit(run.status ?? 1);
}
// Check every source before changing any plugin. Muse ties local updates to the original folder.
const inventory = spawnSync('muse', ['plugins', 'list', '--json'], { encoding: 'utf8' });
if (inventory.error || inventory.status !== 0) {
    console.error(inventory.error?.message ?? inventory.stderr);
    process.exit(inventory.status ?? 1);
}
const installed = new Map(JSON.parse(inventory.stdout).plugins.map(({ record }) => [record.id, record]));
function canonical(path) {
    try { return realpathSync(path); } catch { return resolve(path); }
}
const plan = selected.map(name => {
    const [path, id] = plugins[name];
    const plugin = fileURLToPath(new URL('../../polyfills/' + path + '/plugin', import.meta.url));
    const record = installed.get(id);
    if (record && (!record.source?.path || canonical(record.source.path) !== canonical(plugin))) {
        console.error(id + ' is installed from a different source: ' + (record.source?.path ?? record.source?.provenance ?? 'unknown'));
        console.error('For a local installation, unpack the update over the original kit folder and run this installer there.');
        process.exit(1);
    }
    return { id, plugin, update: Boolean(record) };
});
function configureSkills(plugin) {
    const dataHome = process.env.XDG_DATA_HOME;
    const data = join(dataHome && isAbsolute(dataHome) ? dataHome : join(homedir(), '.local', 'share'), 'muse', 'plugins', 'data', 'mcp-skill-reference');
    const configHome = process.env.XDG_CONFIG_HOME;
    const hint = join(data, 'native-config-home.json');
    if (configHome && isAbsolute(configHome)) {
        mkdirSync(data, { recursive: true, mode: 0o700 });
        const tmp = hint + '.' + randomUUID();
        writeFileSync(tmp, JSON.stringify(configHome), { flag: 'wx', mode: 0o600 });
        renameSync(tmp, hint);
    } else if (existsSync(hint)) unlinkSync(hint);
    if (approve) {
        const sync = spawnSync(process.execPath, [join(plugin, 'dist', 'server.mjs'), '--refresh-native-list'], {
            env: { HOME: homedir(), PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, MUSE_PLUGIN_DATA_DIR: data }, stdio: 'inherit', timeout: 30000
        });
        if (sync.status !== 0) console.warn('The publisher list will refresh in your next trusted Muse session.');
    }
}
for (const { id, plugin, update } of plan) {
    if (update) muse('plugins', 'update', id);
    else muse('plugins', 'install', plugin);
    if (approve) muse('plugins', 'approve', id);
    else console.log('After reviewing the plugin, run: muse plugins approve ' + id);
    if (id === 'mcp-skill-reference') configureSkills(plugin);
}
console.log('Start a new trusted Muse session to use the approved plugins.');
