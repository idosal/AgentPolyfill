// Interop with a real, public MCP server that serves skills over the extension,
// reached over the internet with no credentials: Hugging Face,
// https://huggingface.co/mcp. Run as the Codex adapter runs: its App, with its
// own connection, writing its stubs; every skill is then loaded (the question
// answered yes) and every file its manifest lists is read, each verified (size,
// SHA-256 digest, frontmatter). Loading everything is what a host must not do;
// here it is the test.
//
//   npm run interop:real            (REAL_SERVERS="name=url,..." for others)

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { declarationOf } from '../../../core/src/skills.ts';
import { App } from '../../src/app.ts';
import { relativeTo } from '../../src/format.ts';
import { Store } from '../../src/store.ts';

const DEFAULT = 'huggingface=https://huggingface.co/mcp';
const servers = Object.fromEntries((process.env.REAL_SERVERS ?? DEFAULT).split(',').map((pair) => pair.split('=') as [string, string]).map(([name, url]) => [name, { url }]));
const dir = mkdtempSync(join(tmpdir(), 'mcp-skills-codex-real-'));
const stubRoot = join(dir, 'skills', 'served');
const app = new App({ table: { servers, skipped: {} }, store: new Store(join(dir, 'state')), stubRoot, skillRules: () => [], connectTimeoutMs: 20_000 });
await app.start();
const ask = async () => ({ decision: 'load' as const });
const stubs = readdirSync(stubRoot, { recursive: true }).filter((p) => String(p).endsWith('SKILL.md'));
console.log(`stubs written for Codex to list: ${stubs.length}`);
for (const p of stubs.slice(0, 3)) console.log(`  ${readFileSync(join(stubRoot, String(p)), 'utf8').split('\n')[1]}`);
let failures = 0;
for (const name of Object.keys(servers)) {
    const c = app.conns.get(name);
    if (!c) {
        failures++;
        console.log(`${name}: NOT USED: ${app.unavailable.find((u) => u.name === name)?.why ?? 'it does not declare the Skills extension'}`);
        continue;
    }
    const d = declarationOf(c);
    const listed = app.catalog.listed(name);
    const refused = app.catalog.refused(name);
    console.log(`${name}: protocol revision ${c.revision}; ${listed.length} skills listed, ${refused.length} entries refused${d.declared && d.directoryRead ? '; lists directories' : ''}`);
    failures += refused.length;
    let files = 0;
    let bytes = 0;
    for (const { entry, declined } of listed) {
        if (declined) {
            console.log(`  declined ${entry.uri}: ${declined}`);
            continue;
        }
        const loaded = await app.call('load_skill', { server: name, uri: entry.uri }, { ask, thread: 'interop' });
        if (loaded.isError) {
            failures++;
            console.log(`  FAIL ${entry.uri}: ${loaded.text}`);
            continue;
        }
        const all = entry.resources === 'dynamic' ? [] : entry.resources.filter((r) => r.uri !== entry.uri);
        let ok = true;
        for (const r of all) {
            const file = await app.call('read_skill_file', { server: name, skill: entry.uri, path: relativeTo(entry.uri, r.uri) }, { ask, thread: 'interop' });
            if (file.isError) {
                ok = false;
                failures++;
                console.log(`  FAIL ${r.uri}: ${file.text}`);
            } else {
                files++;
                bytes += r.size;
            }
        }
        if (ok) console.log(`  ok  ${entry.frontmatter.name}: SKILL.md and ${all.length} file(s) verified${entry.resources === 'dynamic' ? ' (dynamic: frontmatter only)' : ''}`);
    }
    console.log(`${name}: ${listed.length} skills, ${files} supporting files, ${bytes} bytes read and verified`);
}
await app.stop();
console.log(failures ? `\nreal servers: ${failures} failure(s)` : '\nreal servers: all skills loaded and every file verified');
process.exit(failures ? 1 : 0);
