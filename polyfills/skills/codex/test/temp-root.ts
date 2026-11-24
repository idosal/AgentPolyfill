// Loaded before every test file (`node --import`, see package.json). Temporary folders made by the
// tests, and by the helpers and servers they start, go into one folder of this run, which is deleted
// when the run ends.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'mcp-skills-codex-run-'));
process.env.TMPDIR = process.env.TMP = process.env.TEMP = root;
process.on('exit', () => {
    try {
        rmSync(root, { recursive: true, force: true });
    } catch {
        // a folder still in use (Windows) is left to the system's own clean-up
    }
});
