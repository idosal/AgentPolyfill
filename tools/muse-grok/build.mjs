import { buildGrok } from '../../polyfills/events/grok-bot/build.mjs';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(resolve(root, 'polyfills/skills/codex/package.json'));
const { build } = require('esbuild');
const entries = [
    ['skills', 'reference', 'server'], ['skills', 'suggest', 'user-prompt-submit'], ['skills', 'native-open', 'native-open'], ['tasks', 'tasks', 'server'],
    ['events', 'monitor', 'server'], ['events', 'helper', 'inbox'],
    ['events', 'muse-prompt-hook', 'user-prompt-submit'], ['routine', 'watch', 'watch']
];
const selected = process.argv.slice(2).find(arg => !arg.startsWith('--'));
if (selected && !entries.some(([feature]) => feature === selected)) throw Error('Unknown feature');
for (const [feature, name, output] of entries) {
    if (selected && selected !== feature) continue;
    if (feature === 'routine') {
        await buildGrok(build, process.argv.includes('--check'));
        continue;
    }
    const dir = resolve(root, 'polyfills', feature, 'muse');
    const out = resolve(dir, 'plugin/dist', output + '.mjs');
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
