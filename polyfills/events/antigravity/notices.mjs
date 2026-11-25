// As tools/bundle-notices.mjs, but for this form's src/main.ts entry.
import { build } from '../codex/node_modules/esbuild/lib/main.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const root = dirname(fileURLToPath(import.meta.url));
const { metafile } = await build({ absWorkingDir: root, entryPoints: ['src/main.ts'], bundle: true, platform: 'node', format: 'esm', write: false, metafile: true, logLevel: 'silent' });
const packages = new Map();
for (const input of Object.keys(metafile.inputs)) {
    const m = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(input);
    if (m) {
        const dir = resolve(root, m[1]), p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        packages.set(`${p.name}@${p.version}`, { dir, p });
    }
}
const lines = ['Third-party software bundled into plugin/dist/server.mjs', '', 'Each package is listed with the license and notices it ships.', ''];
for (const [id, { dir, p }] of [...packages.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push('-'.repeat(72), `${id} (${p.license})`, '');
    for (const f of readdirSync(dir).filter(f => /^(licen[cs]e|copying|notice|unlicense|copyright)/i.test(f)).sort()) lines.push(`${f}:`, '', readFileSync(join(dir, f), 'utf8').trim(), '');
}
const text = lines.join('\n').replace(/[ \t]+$/gm, '').trimEnd() + '\n', target = join(root, 'plugin/THIRD_PARTY_LICENSES.txt');
if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== text) throw new Error('Third-party notices are stale: node notices.mjs');
} else writeFileSync(target, text);
