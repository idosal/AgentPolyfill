// Interop with real, public MCP servers that serve skills over the extension,
// reached over the internet with no credentials:
//
//   Hugging Face   https://huggingface.co/mcp
//   TogoMCP        https://togomcp.rdfportal.org/mcp   (RDF Portal, on FastMCP)
//
// For each: connect, list, then load every skill and read every file its
// manifest lists, each verified (size, SHA-256 digest, frontmatter). Loading
// everything is what a host must not do; here it is the test.
//
//   npm run interop:real            (REAL_SERVERS="name=url,..." for others)

import { App } from '../../src/app.ts';
import { relativeTo } from '../../src/format.ts';
import { declarationOf } from '../../src/skills.ts';

const DEFAULT = 'huggingface=https://huggingface.co/mcp,togomcp=https://togomcp.rdfportal.org/mcp';
const servers = Object.fromEntries((process.env.REAL_SERVERS ?? DEFAULT).split(',').map((pair) => pair.split('=') as [string, string]).map(([name, url]) => [name, { url }]));
const app = new App({ table: { servers, skipped: {} }, verdict: async () => ({ ok: true }), connectTimeoutMs: 20_000 });
await app.start();
let failures = 0;
for (const name of Object.keys(servers)) {
    const c = app.conns.get(name);
    if (!c) {
        failures++;
        console.log(`${name}: NOT USED: ${app.unavailable.find((u) => u.name === name)?.why ?? 'it does not declare the Skills extension'}`);
        continue;
    }
    const d = declarationOf(c);
    const listed = app.host.listed(name);
    const refused = app.host.refused(name);
    console.log(`${name}: protocol revision ${c.revision}; ${listed.length} skills listed, ${refused.length} entries refused${d.declared && d.directoryRead ? '; lists directories' : ''}`);
    for (const r of refused) console.log(`  refused ${r.uri ?? ''}: ${r.reason}`);
    failures += refused.length;
    let files = 0;
    let bytes = 0;
    for (const { entry, declined } of listed) {
        if (declined) {
            console.log(`  declined ${entry.uri}: ${declined}`);
            continue;
        }
        try {
            const loaded = await app.host.load(name, entry.uri);
            bytes += loaded.body.length;
            const all = entry.resources === 'dynamic' ? [] : entry.resources.filter((r) => r.uri !== entry.uri);
            for (const r of all) {
                const file = await app.host.readFile(name, entry.uri, relativeTo(entry.uri, r.uri));
                files++;
                bytes += file.size;
            }
            console.log(`  ok  ${entry.frontmatter.name}: SKILL.md and ${all.length} file(s) verified${loaded.isVerified ? '' : ' (dynamic: frontmatter only)'}`);
        } catch (e) {
            failures++;
            console.log(`  FAIL ${entry.uri}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    console.log(`${name}: ${listed.length} skills, ${files} supporting files, ${bytes} bytes read and verified`);
}
await app.stop();
console.log(failures ? `\nreal servers: ${failures} failure(s)` : '\nreal servers: all skills loaded and every file verified');
process.exit(failures ? 1 : 0);
