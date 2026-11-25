#!/usr/bin/env node
// Writes <polyfill>/mod/THIRD_PARTY_LICENSES.txt: the licence of every npm
// package that esbuild bundles into that polyfill's mod/dist/helper.js, with
// each package's own licence and notice files. Run it after `npm ci` in the
// polyfill's folder, and again whenever its dependencies change.
//
//   node tools/bundle-notices.mjs polyfills/events/claude-code [--check]
//   node tools/bundle-notices.mjs polyfills/events/codex --plugin plugin [--check]
//   node tools/bundle-notices.mjs polyfills/events/pi --plugin extension --entry src/index.ts [--check]
//
// --plugin names the installed folder when it is not mod/ (a Codex plugin's, a
// Pi extension's, an OpenCode plugin's). --entry names the bundle's entry when
// it is not src/helper.ts. --bundle names the bundle when it is not the entry's
// name under dist/ (an OpenCode plugin's is server.js):
//
//   node tools/bundle-notices.mjs polyfills/events/opencode --plugin plugin --entry src/plugin.ts --bundle server.js
//
// --check fails if the file on disk differs from what it would write.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const folder = resolve(process.argv[2] ?? '.');
// The polyfill's own pinned esbuild, so the inputs match its build.mjs.
const { build } = await import(pathToFileURL(createRequire(join(folder, 'package.json')).resolve('esbuild')).href);
const check = process.argv.includes('--check');
const pluginAt = process.argv.indexOf('--plugin');
const plugin = pluginAt > 0 && process.argv[pluginAt + 1] ? process.argv[pluginAt + 1] : 'mod';
const option = (name) => {
    const at = process.argv.indexOf(name);
    return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : undefined;
};
const entry = option('--entry') ?? 'src/helper.ts';
const bundled = option('--bundle') ?? `${entry.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js')}`;
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense|copyright)/i;

// The same entry and resolution as the polyfill's build.mjs, without writing a bundle.
const { metafile } = await build({
    absWorkingDir: folder,
    entryPoints: [entry],
    // A Pi extension leaves Pi's own packages to Pi, as its build.mjs does.
    external: ['@earendil-works/*'],
    platform: 'node',
    format: 'esm',
    target: 'node20',
    bundle: true,
    write: false,
    metafile: true,
    logLevel: 'silent'
});

// node_modules/<name>/… or node_modules/@scope/<name>/…, the innermost one.
const packages = new Map();
for (const input of Object.keys(metafile.inputs)) {
    const m = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(input);
    if (m) packages.set(m[1], m[2]);
}

const entries = [...packages.entries()]
    .map(([dir, name]) => {
        const abs = join(folder, dir);
        const pkg = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8'));
        const files = readdirSync(abs).filter((f) => LICENSE_FILE.test(f)).sort();
        return { name, version: pkg.version, license: typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses ?? 'UNKNOWN'), texts: files.map((f) => ({ f, text: readFileSync(join(abs, f), 'utf8').trim() })) };
    })
    .sort((a, b) => (a.name + a.version).localeCompare(b.name + b.version));

const seen = new Set();
const out = [
    `Third-party software bundled into ${plugin}/${bundled}`,
    '',
    'The helper bundles the npm packages below. Each is listed with the licence',
    'its package.json names and the licence and notice files it ships.',
    ''
];
for (const e of entries) {
    const key = `${e.name}@${e.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push('-'.repeat(72), `${key} (${e.license})`, '');
    if (!e.texts.length) out.push('(The package ships no licence file; its package.json names the licence above.)', '');
    for (const t of e.texts) out.push(`${t.f}:`, '', t.text, '');
}
const text = out.join('\n').trimEnd() + '\n';
const target = join(folder, plugin, 'THIRD_PARTY_LICENSES.txt');

if (check) {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
    if (current !== text) {
        console.error(`${target} is out of date: run node tools/bundle-notices.mjs ${process.argv.slice(2).filter((a) => a !== '--check').join(' ')}`);
        process.exit(1);
    }
    console.log(`${target}: up to date (${seen.size} packages)`);
} else {
    writeFileSync(target, text);
    console.log(`wrote ${target}: ${seen.size} packages`);
}
