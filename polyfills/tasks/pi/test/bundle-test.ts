import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the bundled Pi package matches the sources and the development version', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'extension', 'package.json'), 'utf8'));
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.equal(manifest.version, pkg.version);
    const out = mkdtempSync(join(tmpdir(), 'pi-tasks-bundle-'));
    try {
        execFileSync(process.execPath, [join(root, 'build.mjs'), out], { cwd: root, stdio: 'ignore' });
        assert.equal(readFileSync(join(out, 'index.js'), 'utf8'), readFileSync(join(root, 'extension', 'dist', 'index.js'), 'utf8'), 'run npm run build');
    } finally {
        rmSync(out, { recursive: true, force: true });
    }
});
