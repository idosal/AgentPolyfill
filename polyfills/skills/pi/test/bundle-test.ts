// The installed folder (extension/) is what Pi loads: its bundle is built from
// src/ and committed, so it must match a fresh build, and its manifest must name it.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { temp } from './pi-rpc.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('extension/dist/index.js is what build.mjs makes from src/ now', () => {
    const out = temp('bundle-');
    execFileSync(process.execPath, [join(ROOT, 'build.mjs'), out], { cwd: ROOT, stdio: 'ignore' });
    assert.ok(readFileSync(join(out, 'index.js')).equals(readFileSync(join(ROOT, 'extension', 'dist', 'index.js'))), 'the committed bundle is stale: run npm run build');
});

test('the extension\'s manifest names the bundle, and the bundle imports nothing but Node and Pi', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'extension', 'package.json'), 'utf8')) as { pi?: { extensions?: string[] }; keywords?: string[]; dependencies?: unknown };
    assert.deepEqual(manifest.pi?.extensions, ['./dist/index.js']);
    assert.ok(manifest.keywords?.includes('pi-package'));
    assert.equal(manifest.dependencies, undefined, 'nothing to install');
    const bundle = readFileSync(join(ROOT, 'extension', 'dist', 'index.js'), 'utf8');
    const imports = [...bundle.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    assert.ok(imports.length > 0);
    for (const i of imports) assert.ok(i.startsWith('node:') || i.startsWith('@earendil-works/'), i);
});
