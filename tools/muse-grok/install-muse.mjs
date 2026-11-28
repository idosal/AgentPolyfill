import { readConfig, securePublisher } from './config.ts';
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
const option = args.indexOf('--publisher');
const requested = option >= 0 ? args[option+1] : undefined;
if (option>=0 && (args.lastIndexOf('--publisher')!==option || !requested || requested.startsWith('--'))) throw Error('--publisher requires one existing connection name or a public HTTPS URL.');
const names = args.filter((arg,i) => arg !== '--approve' && (option<0 || i!==option && i!==option+1));
if (requested && (!approve || !names.some(n=>n==='all'||n==='skills'))) throw Error('Use skills --approve --publisher NAME_OR_URL to install the publisher reader.');
if (!names.length || names.some(name => name !== 'all' && !Object.hasOwn(plugins, name))) {
    console.error('Usage: node install-muse.mjs all|cards|ard|skills|events|tasks ... [--approve] [--publisher CONNECTION_OR_HTTPS_URL]');
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
    if (approve && !requested) {
        const sync = spawnSync(process.execPath, [join(plugin, 'dist', 'server.mjs'), '--refresh-native-list'], {
            env: { HOME: homedir(), PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, MUSE_PLUGIN_DATA_DIR: data }, stdio: 'inherit', timeout: 30000
        });
        if (sync.status !== 0) console.warn('The publisher list will refresh in your next trusted Muse session.');
    }
}
const configDir = isAbsolute(process.env.XDG_CONFIG_HOME || '') ? process.env.XDG_CONFIG_HOME : join(homedir(),'.config');
const settingsFile = join(configDir,'muse/settings.json');
let publisherName, newUrl;
if (requested) {
    const servers = existsSync(settingsFile) ? readConfig(settingsFile).mcpServers ?? {} : {};
    if (Object.hasOwn(servers,requested)) publisherName=requested;
    else {
        if (!securePublisher(requested)) throw Error('Unknown connection. Enter its existing Muse name or an HTTPS URL without credentials.');
        const url = new URL(requested);
        const existing = Object.keys(servers).filter(name => servers[name]?.url === requested || servers[name]?.url === url.href);
        if (existing.length>1) throw Error('Several connections use this endpoint. Choose the existing connection by name.');
        publisherName=existing[0] ?? url.hostname.replace(/[^a-z0-9-]/gi,'-').slice(0,62);
        if (!existing.length) {
            if (Object.hasOwn(servers,publisherName)) throw Error('A different connection already uses that name. Register this publisher in Muse and use its name.');
            newUrl=url.href;
        }
    }
    if (!/^[a-z0-9][a-z0-9_.:@-]{0,63}$/i.test(publisherName) || servers[publisherName]?.enabled===false || servers[publisherName]?.disabled===true) throw Error('Choose an enabled Muse connection with a supported name.');
}
for (const { id, plugin, update } of plan) {
    if (update) muse('plugins', 'update', id);
    else muse('plugins', 'install', plugin);
    if (approve) muse('plugins', 'approve', id);
    else console.log('After reviewing the plugin, run: muse plugins approve ' + id);
    if (id === 'mcp-skill-reference') configureSkills(plugin);
}
if (requested) {
    if (newUrl) muse('mcp','add',publisherName,'--user','--url',newUrl);
    const base = isAbsolute(process.env.XDG_DATA_HOME || '') ? process.env.XDG_DATA_HOME : join(homedir(),'.local','share');
    const selectedFile=join(base,'muse/plugins/data/mcp-skill-reference/muse-servers.json');
    const previous=existsSync(selectedFile) ? readConfig(selectedFile) : [];
    if (!Array.isArray(previous) || !previous.every(n=>typeof n==='string')) throw Error('Could not read the selected publisher list.');
    const selector=fileURLToPath(new URL('./select-muse-sources.mjs',import.meta.url));
    const selected=spawnSync(process.execPath,[selector,'skills',...new Set([...previous,publisherName])],{stdio:'inherit'});
    if (selected.status!==0) process.exit(selected.status??1);
    const result=spawnSync('muse',['skills','list','--source','user','--json'],{encoding:'utf8'});
    if (result.status!==0) throw Error('Muse could not report its native skill inventory.');
    const count=JSON.parse(result.stdout).skills.filter(s=>s.name.startsWith('mcp-skills:'+publisherName+':') && s.activation==='on').length;
    console.log(count+' native publisher skills available from '+publisherName+'.');
    if (!count) process.exitCode=1;
}
console.log('Start a new trusted Muse session to use the approved plugins.');
