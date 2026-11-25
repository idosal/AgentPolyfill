// The installed plugin: its manifest, its one file, and that the file is what the sources build.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { BUNDLE, ROOT, temp } from './harness.ts';
import { VERSION } from '../src/version.ts';

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));

test('the manifest names the extension folder, and every version agrees', () => {
    const m = JSON.parse(readFileSync(join(ROOT, 'plugin', 'plugin.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(m.name, 'mcp-events');
    assert.equal(m.extensions, 'extensions/');
    assert.equal(m.version, VERSION);
    assert.equal((JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version, VERSION);
    assert.deepEqual(walk(join(ROOT, 'plugin')).map((f) => relative(join(ROOT, 'plugin'), f)).sort(), ['THIRD_PARTY_LICENSES.txt', 'extensions/mcp-events/extension.mjs', 'plugin.json']);
});

test('the committed extension is what the sources build', () => {
    const out = temp('mcp-events-copilot-build-');
    execFileSync(process.execPath, [join(ROOT, 'build.mjs'), out], { cwd: ROOT, stdio: 'pipe' });
    assert.ok(readFileSync(join(out, 'extension.mjs')).equals(readFileSync(BUNDLE)), 'plugin/extensions/mcp-events/extension.mjs is stale: run npm run build');
});

test('the SDK Copilot provides is imported, not bundled, by the name both Copilot CLI and VS Code\'s Copilot harness resolve; nothing else is imported from outside Node', () => {
    const text = readFileSync(BUNDLE, 'utf8');
    const imports = [...text.matchAll(/from\s*"([^"]+)"/g)].map((m) => m[1]!).filter((s) => !s.startsWith('node:'));
    assert.deepEqual([...new Set(imports)], ['@github/copilot-sdk/extension']);
});
