// Even direct core tests and their stdio children get a throwaway HOME.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = mkdtempSync(join(tmpdir(), 'events-suite-'));
try {
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR };
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...readdirSync('test/.build').filter(f => f.endsWith('.test.mjs')).map(f => join('test/.build', f))], { stdio: 'inherit', env });
    process.exitCode = r.status ?? 1;
} finally { rmSync(home, { recursive: true, force: true }); }
