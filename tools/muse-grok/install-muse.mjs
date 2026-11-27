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
for (const name of selected) {
    const [path, id] = plugins[name];
    const plugin = fileURLToPath(new URL('../../polyfills/' + path + '/plugin', import.meta.url));
    muse('plugins', 'install', plugin);
    if (approve) muse('plugins', 'approve', id);
    else console.log('After reviewing the plugin, run: muse plugins approve ' + id);
}
console.log('Start a new trusted Muse session to use the approved plugins.');
