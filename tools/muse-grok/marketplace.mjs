// Use Muse's own package digests and check installation from the resulting catalog.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const dirs = ['ard/codex', 'server-cards/codex', 'skills/muse', 'events/muse', 'tasks/muse'];
const profile = mkdtempSync(join(tmpdir(), 'agentpolyfill-muse-market-'));
const env = { PATH: process.env.PATH, HOME: profile, XDG_DATA_HOME: join(profile,'data'), XDG_CONFIG_HOME: join(profile,'config'), XDG_CACHE_HOME: join(profile,'cache'), XDG_STATE_HOME: join(profile,'state') };
function muse(...args) {
    return JSON.parse(execFileSync('muse', ['plugins', ...args, '--json'], { cwd: root, env, encoding: 'utf8' }));
}
try {
    const plugins = dirs.map(dir => {
        const source = 'polyfills/' + dir + '/plugin';
        const { installed } = muse('install', source);
        muse('remove', installed.id, '--delete-data');
        return { name: installed.id, version: installed.version, install: { transport: 'local-path', source },
            integrity: { digest: installed.package_sha256 }, availability: { status: 'available' } };
    });
    const path = join(root, 'marketplace.json');
    const contents = JSON.stringify({ schemaVersion: 1, source: 'local', plugins }, null, 2) + '\n';
    if (process.argv.includes('--check')) {
        if (readFileSync(path, 'utf8') !== contents) throw Error('Rebuild marketplace.json with this command without --check.');
    } else writeFileSync(path, contents);
    const { marketplace } = muse('marketplace', 'add', 'agent-polyfill', root);
    if (marketplace.plugin_count !== plugins.length || marketplace.skipped.length) throw Error('Incomplete Muse marketplace');
    for (const plugin of plugins) {
        const { installed } = muse('install', plugin.name + '@agent-polyfill');
        if (installed.package_sha256 !== plugin.integrity.digest) throw Error('Marketplace install digest mismatch: ' + plugin.name);
    }
    console.log('Muse installed all ' + plugins.length + ' packages from the native catalog.');
} finally { rmSync(profile, { recursive: true, force: true }); }
