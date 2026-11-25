// Reading Pi's MCP configuration as Pi does (src/pi-config.ts, the same file as
// the Events form's, whose test/config-test.ts checks it in full against Pi's
// own entry check): here, that the copy is the same, that an entry Pi rejects
// runs nothing, and that the extension runs only with Pi's own MCP support.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { piRunsMcp, readPiServers } from '../src/pi-config.ts';
import { temp } from './harness.ts';

test("src/pi-config.ts is the Events form's, which is tested against Pi's own entry check", () => {
    const here = readFileSync(fileURLToPath(new URL('../src/pi-config.ts', import.meta.url)), 'utf8');
    const events = readFileSync(fileURLToPath(new URL('../../../events/pi/src/pi-config.ts', import.meta.url)), 'utf8');
    assert.equal(here, events);
});

test('an entry Pi rejects is left out, and nothing in it runs; the extension runs only with Pi\'s own MCP support', () => {
    const dir = temp();
    const agent = join(dir, 'agent');
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { bad: { command: 'node', args: ['a', 2], env: { T: '!echo ran' } }, good: { url: 'https://docs.example/mcp' } } }));
    let ran = 0;
    const t = readPiServers({ env: { PI_CODING_AGENT_DIR: agent, HOME: dir }, cwd: dir, trusted: false, runCommand: () => ((ran += 1), 'x') });
    assert.equal(ran, 0);
    assert.deepEqual(Object.keys(t.servers), ['good']);
    assert.equal(piRunsMcp([{ name: 'mcp', sourceInfo: { path: 'builtin:mcp' } }]), true);
    assert.equal(piRunsMcp([]), false);
    assert.equal(piRunsMcp([{ name: 'mcp', sourceInfo: { path: '/x/pi-mcp-adapter/index.ts' } }]), false);
});
