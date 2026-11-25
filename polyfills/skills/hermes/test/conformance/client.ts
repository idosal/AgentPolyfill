// The client under test for the official MCP conformance suite's SEP-2640 client scenarios
// (modelcontextprotocol/conformance, src/scenarios/client/skills/), run as the Hermes plugin runs
// it: the bundled helper (plugin/dist/helper.mjs) over its stdin/stdout, as tools/hermes/shared/
// _helper.py starts it. Hermes's approval is stood in for by `prepare_load` before each load (the
// question the plugin's pre_tool_call hook raises, answered yes here, as a person would, so the
// verification scenarios get as far as a load).
//
//   sep-2640-client-no-prefetch     connect, list the skills, write the stubs, exit
//   sep-2640-client-verify-*        connect, list, load each skill, then read its files
//
// Run by test/conformance/run.sh.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const url = process.argv.at(-1)!;
const scenario = process.env.MCP_CONFORMANCE_SCENARIO ?? '';
const helper = fileURLToPath(new URL('../../plugin/dist/helper.mjs', import.meta.url));
const state = mkdtempSync(join(tmpdir(), 'mcp-skills-hermes-conformance-'));
process.on('exit', () => rmSync(state, { recursive: true, force: true }));
const child = spawn(process.execPath, [helper], { env: { PATH: process.env.PATH, HOME: state, TMPDIR: process.env.TMPDIR }, stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map<number, (m: Record<string, unknown>) => void>();
createInterface({ input: child.stdout! }).on('line', (l) => {
    const m = JSON.parse(l) as Record<string, unknown>;
    if (typeof m.id === 'number') waiting.get(m.id)?.(m);
});
let id = 0;
const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((done) => {
        const n = ++id;
        waiting.set(n, (m) => done((m.result ?? { error: m.error }) as Record<string, unknown>));
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    });
const call = async (name: string, args: Record<string, unknown>) => (await request('call', { name, arguments: args, session: 'conformance' })) as { text: string; isError: boolean };

await request('initialize', { state, servers: { conformance: { url } }, skipped: {} });
const { stubs } = (await request('stubs', { waitMs: 20000 })) as { stubs: { uri: string }[] };
console.log(`listed ${stubs.length} skill(s); stubs written`);
let failed = false;
if (scenario !== 'sep-2640-client-no-prefetch') {
    // Every skill the server lists, including one with no stub (its name broke the naming rule).
    const listed = (await call('list_skills', { server: 'conformance' })).text;
    const uris = [...new Set([...stubs.map((s) => s.uri), ...[...listed.matchAll(/uri (\S+?)\)/g)].map((m) => m[1]!)])];
    for (const uri of uris) {
        const asked = await request('prepare_load', { session: 'conformance', server: 'conformance', uri });
        if (asked.refuse) {
            console.log(`not put to the user: ${String(asked.refuse)}`);
            failed = true;
            continue;
        }
        const loaded = await call('load_skill', { server: 'conformance', uri });
        console.log(loaded.isError ? `not loaded: ${loaded.text}` : `loaded ${uri}`);
        if (loaded.isError) {
            failed = true;
            continue;
        }
        // The files its manifest lists, as the loaded text names them (before the skill's own text).
        const head = loaded.text.split('<mcp-skill ')[0]!;
        for (const path of [...head.matchAll(/^- (\S+) \(\d+ bytes\)$/gm)].map((m) => m[1]!)) {
            const read = await call('read_skill_file', { server: 'conformance', skill: uri, path });
            console.log(read.isError ? `not read: ${read.text}` : `read ${path}`);
            failed ||= read.isError;
        }
    }
}
child.stdin!.end();
process.exit(failed ? 1 : 0);
