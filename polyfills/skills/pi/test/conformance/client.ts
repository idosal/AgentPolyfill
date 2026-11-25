// The client under test for the official MCP conformance suite's SEP-2640 client
// scenarios (modelcontextprotocol/conformance, src/scenarios/client/skills/), run
// as the Pi extension runs: its App, with its own connection, its stubs and its
// question before a load (answered "Load it" here, as a person would, so that the
// verification scenarios get as far as a load).
//
//   sep-2640-client-no-prefetch     connect, list the skills, write the stubs, exit
//   sep-2640-client-verify-*        connect, list, load each skill, then read its files
//
// Run by test/conformance/run.sh.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../../src/app.ts';
import { Store } from '../../src/store.ts';

const url = process.argv.at(-1)!;
const scenario = process.env.MCP_CONFORMANCE_SCENARIO ?? '';
const dir = mkdtempSync(join(tmpdir(), 'mcp-skills-pi-conformance-'));
const app = new App({ table: { servers: { conformance: { url } }, skipped: {} }, store: new Store(join(dir, 'state')), stubRoot: join(dir, 'served') });
await app.start();
const skills = app.host.listed('conformance');
console.log(`listed ${skills.length} skill(s) on protocol revision ${app.conns.get('conformance')?.revision}; stubs written`);
const ask = async () => ({ decision: 'load' as const });
let failed = false;
if (scenario !== 'sep-2640-client-no-prefetch') {
    for (const { entry } of skills) {
        const loaded = await app.call('load_skill', { server: 'conformance', uri: entry.uri }, { ask });
        console.log(loaded.isError ? `not loaded: ${loaded.text}` : `loaded ${entry.uri}`);
        if (loaded.isError) {
            failed = true;
            continue;
        }
        for (const file of entry.resources === 'dynamic' ? [] : entry.resources) {
            if (file.uri === entry.uri) continue;
            const read = await app.call('read_skill_file', { server: 'conformance', skill: entry.uri, path: file.uri }, { ask });
            console.log(read.isError ? `not read: ${read.text}` : `read ${file.uri}`);
            failed ||= read.isError === true;
        }
    }
}
await app.stop();
process.exit(failed ? 1 : 0);
