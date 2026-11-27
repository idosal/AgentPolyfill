import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(resolve(root, 'polyfills/skills/codex/package.json'));
const { build } = require('esbuild');
const entries = { skills: 'reference', tasks: 'tasks', events: 'monitor', routine: 'watch' };
const selected = process.argv.slice(2).find(arg => !arg.startsWith('--'));
if (selected && !Object.hasOwn(entries, selected)) throw Error('Unknown feature');
for (const [feature, name] of Object.entries(entries)) {
    if (selected && selected !== feature) continue;
    const dir = feature === 'routine' ? resolve(root, 'polyfills/events/grok-bot') : resolve(root, 'polyfills', feature, 'muse');
    const out = resolve(dir, feature === 'routine' ? 'dist/watch.mjs' : 'plugin/dist/server.mjs');
    const built = await build({ absWorkingDir: dir, entryPoints: ['src/' + name + '.ts'], platform: 'node', target: 'node22',
        format: 'esm', bundle: true, minify: true, write: false, preserveSymlinks: true,
        banner: { js: 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);' } });
    const result = built.outputFiles[0].text;
    if (process.argv.includes('--check')) {
        if (readFileSync(out, 'utf8') !== result) throw Error('Rebuild ' + out);
    } else {
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, result);
    }
}
