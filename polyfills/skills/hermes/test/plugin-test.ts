// The plugin folder as Hermes installs it: the committed bundle and words.json match a fresh
// build, the shared Python modules are the same as tools/hermes/shared, and the versions agree.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
import { VERSION } from '../src/version.ts';

test('plugin/dist matches a fresh build', () => {
    const out = mkdtempSync(join(tmpdir(), 'mcp-skills-hermes-build-'));
    process.on('exit', () => rmSync(out, { recursive: true, force: true }));
    execFileSync(process.execPath, [join(ROOT, 'build.mjs'), out], { cwd: ROOT, stdio: 'pipe' });
    for (const f of ['helper.mjs', 'words.json']) assert.equal(readFileSync(join(ROOT, 'plugin', 'dist', f), 'utf8'), readFileSync(join(out, f), 'utf8'), `plugin/dist/${f} is stale: run npm run build`);
});

test('the shared Python modules are the same as tools/hermes/shared', () => {
    for (const f of ['_helper.py', '_servers.py']) assert.equal(readFileSync(join(ROOT, 'plugin', f), 'utf8'), readFileSync(join(ROOT, '..', '..', '..', 'tools', 'hermes', 'shared', f), 'utf8'), `plugin/${f} differs: run npm run build`);
});

test('the versions agree', () => {
    assert.equal(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version, VERSION);
    assert.match(readFileSync(join(ROOT, 'plugin', 'plugin.yaml'), 'utf8'), new RegExp(`^version: "${VERSION.replace(/\./g, '\\.')}"$`, 'm'));
});
