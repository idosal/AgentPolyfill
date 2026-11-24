import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const suite = process.env.MCP_CONFORMANCE_SUITE_DIR;
if (!suite || !existsSync(join(suite, 'src/scenarios/client/events')) || !existsSync(join(suite, 'node_modules/tsx/dist/cli.mjs'))) {
    console.error('Set MCP_CONFORMANCE_SUITE_DIR to a reviewed conformance checkout with Events scenarios and dependencies installed (see docs/conformance.md).');
    process.exit(2);
}
const home = mkdtempSync(join(tmpdir(), 'ag-events-conformance-'));
try {
    const command = `"${process.execPath}" "${resolve('test/.build/probe.mjs')}"`;
    const output = process.env.MCP_CONFORMANCE_OUTPUT_DIR ? ['-o', resolve(process.env.MCP_CONFORMANCE_OUTPUT_DIR)] : [];
    for (const scenario of ['events-client-no-extension', 'events-client-poll', 'events-client-push', 'events-client-webhook']) {
        const r = spawnSync(process.execPath, [join(suite, 'node_modules/tsx/dist/cli.mjs'), 'src/index.ts', 'client', '--command', command, '--scenario', scenario, '--spec-version', '2026-07-28', '--force', ...output], { cwd: suite, stdio: 'inherit', env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR } });
        if (r.status !== 0) process.exitCode = 1;
    }
} finally { rmSync(home, { recursive: true, force: true }); }
