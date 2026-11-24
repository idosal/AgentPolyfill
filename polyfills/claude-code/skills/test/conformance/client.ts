// The client under test for the official MCP conformance suite's SEP-2640 client
// scenarios (modelcontextprotocol/conformance, src/scenarios/client/skills/).
// The suite starts a server, runs this with the server's URL as the last
// argument and the scenario's name in MCP_CONFORMANCE_SCENARIO, and watches what
// arrives. This does what each scenario's contract asks of a client, with the
// mod's own connection (src/wire.ts) and Skills logic (src/skills.ts):
//
//   sep-2640-client-no-prefetch     connect, list the skills, exit
//   sep-2640-client-verify-*        connect, list, load the skill, then read its
//                                   supporting file
//
// Run by test/conformance/run.sh.

import { SkillsHost } from '../../src/skills.ts';
import { Connection } from '../../src/wire.ts';

const url = process.argv.at(-1)!;
const scenario = process.env.MCP_CONFORMANCE_SCENARIO ?? '';
const wire = new Connection('conformance', { url });
await wire.connect(10_000);
const host = new SkillsHost(() => wire);
const { skills } = await host.list('conformance');
console.log(`listed ${skills.length} skill(s) on protocol revision ${wire.revision}`);
let failure: unknown;
if (scenario !== 'sep-2640-client-no-prefetch') {
    try {
        for (const { entry } of skills) {
            const loaded = await host.load('conformance', entry.uri);
            console.log(`loaded ${entry.uri} (${loaded.body.length} characters)`);
            for (const file of entry.resources === 'dynamic' ? [] : entry.resources) {
                if (file.uri === entry.uri) continue;
                const read = await host.readFile('conformance', entry.uri, file.uri);
                console.log(`read ${read.uri} (${read.size} bytes)`);
            }
        }
    } catch (e) {
        failure = e;
        console.log(`not loaded: ${e instanceof Error ? e.message : String(e)}`);
    }
}
await wire.close();
process.exit(failure ? 1 : 0);
