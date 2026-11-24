// Explicit opt-in network interop, never part of npm test. Like Codex's probe,
// this test approves each listed version and verifies every published file.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../../src/app.ts';
import { handlers } from '../../src/approval.ts';
import { Store } from '../../../codex/src/store.ts';
import { relativeTo } from '../../../codex/src/format.ts';
import { answerHook, stateDir } from '../../../../server-cards/antigravity/src/gate.ts';
import { configPath } from '../../src/config.ts';
import { stubRootOf } from '../../src/stubs.ts';

const home = mkdtempSync(join(tmpdir(), 'ag-skills-interop-'));
const env = { HOME: home, PATH: process.env.PATH };
const scenario = process.env.MCP_CONFORMANCE_SCENARIO;
const target = scenario ? `conformance=${process.argv.at(-1)}` : process.env.REAL_SERVERS ?? 'huggingface=https://huggingface.co/mcp';
const servers = Object.fromEntries(target.split(',').map(pair => {
    const at = pair.indexOf('='); return [pair.slice(0, at), { url: pair.slice(at + 1) }];
}));
mkdirSync(join(configPath(env), '..'), { recursive: true });
writeFileSync(configPath(env), JSON.stringify({ mcpServers: servers }));
const store = new Store(stateDir('mcp-skills', env));
const app = new App({ env, store, stubRoot: stubRootOf(home) });
let failures = 0, skills = 0, files = 0;
const gated = async (name: string, args: Record<string, unknown>) => {
    const hook = await answerHook({ conversationId: 'interop', toolCall: { name: `mcp_mcp-skills_skills_${name}`, args } }, handlers(env, store), store.dir);
    if (hook.decision === 'deny') return { isError: true, text: String(hook.reason) };
    return app.call(name, { ...args, ...hook.overwrite as object });
};
try {
    await app.start();
    console.log(app.status());
    console.log(`Stubs: ${readdirSync(stubRootOf(home)).length}`);
    for (const name of Object.keys(servers)) if (!app.conns.has(name)) failures++;
    if (scenario !== 'sep-2640-client-no-prefetch') for (const { label, entry, declined } of app.offered) {
        if (declined) { failures++; console.log(`Declined ${entry.uri}: ${declined}`); continue; }
        const load = await gated('load_skill', { server: label, uri: entry.uri });
        if (load.isError) { failures++; console.log(`FAIL ${entry.uri}: ${load.text}`); continue; }
        skills++;
        for (const r of entry.resources === 'dynamic' ? [] : entry.resources) {
            if (r.uri === entry.uri) continue;
            const read = await gated('read_skill_file', { server: label, skill: entry.uri, path: relativeTo(entry.uri, r.uri) });
            if (read.isError) { failures++; console.log(`FAIL ${r.uri}: ${read.text}`); } else files++;
        }
        console.log(`Verified ${entry.uri}`);
    }
    console.log(`${skills} skills loaded, ${files} supporting files verified, ${failures} failures.`);
} finally { await app.stop(); rmSync(home, { recursive: true, force: true }); }
process.exitCode = failures ? 1 : 0;
