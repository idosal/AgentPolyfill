// Installs the four OpenCode plugins as a person would, with `opencode plugin add`, from a Git
// repository, in a throwaway home, and checks that OpenCode loads each one: its tools reach the
// model. By hand, not in CI: it fetches the repository from GitHub.
//
//   node --no-warnings tools/opencode/install-check.ts [<repository>] [<branch, tag or commit>]
//
// The default repository is github:idosal/AgentPolyfill, at main. Each plugin is the `plugin/` folder
// of its form, which npm's `::path:` selector picks out of the repository. The model is the scripted
// one, so nothing is sent to a model provider; the only network use is the Git fetch.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openCodeBin, REPO, World } from './harness.ts';

const repository = process.argv[2] ?? 'github:idosal/AgentPolyfill';
const ref = process.argv[3] ?? 'main';

const FORMS: { folder: string; id: string; tool: string }[] = [
    { folder: 'events', id: 'mcp-events-opencode', tool: 'mcp_events_list_event_types' },
    { folder: 'skills', id: 'mcp-skills-opencode', tool: 'mcp_skills_list_skills' },
    { folder: 'server-cards', id: 'mcp-server-cards-opencode', tool: 'server_cards_discover_mcp_servers' },
    { folder: 'ard', id: 'ard-discovery-opencode', tool: 'ard_discover' }
];

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Every `server.js` under `dir` whose folder's package.json has the given name. */
function installed(dir: string, name: string, found: string[] = []): string[] {
    let entries: string[] = [];
    try {
        entries = readdirSync(dir);
    } catch {
        return found;
    }
    if (entries.includes('package.json') && entries.includes('server.js')) {
        try {
            if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === name) found.push(join(dir, 'server.js'));
        } catch {
            // not a package
        }
    }
    for (const e of entries) {
        const p = join(dir, e);
        try {
            if (statSync(p).isDirectory() && !statSync(p).isSymbolicLink()) installed(p, name, found);
        } catch {
            // gone
        }
    }
    return found;
}

const world = new World({ plugins: [] });
let failed = false;
try {
    await world.start();
    for (const f of FORMS) {
        const spec = `${repository}#${ref}::path:polyfills/${f.folder}/opencode/plugin`;
        const r = spawnSync(openCodeBin(), ['plugin', 'add', spec], { env: world.env, cwd: world.project, encoding: 'utf8', timeout: 300000 });
        const said = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').at(-1);
        console.log(`opencode plugin add ${spec}\n  -> exit ${r.status}: ${said}`);
        if (r.status !== 0) failed = true;
    }
    console.log('\nglobal opencode.json:\n' + readFileSync(join(world.home, '.config', 'opencode', 'opencode.json'), 'utf8'));

    // OpenCode reloads on a configuration change; a restart makes sure of it.
    await world.restart();
    const session = await world.createSession();
    const since = Date.now();
    await world.prompt(session, 'hello');
    await world.idle(session, since).catch(() => undefined);
    const tools = (world.llmRequests().at(-1)?.tools ?? []).map((t) => t.function?.name);
    for (const f of FORMS) {
        const loaded = tools.includes(f.tool);
        const copies = installed(world.home, f.id);
        const same = copies.map((c) => sha(c) === sha(join(REPO, 'polyfills', f.folder, 'opencode', 'plugin', 'server.js')));
        console.log(`${f.folder}: ${loaded ? 'loaded' : 'NOT loaded'} (${f.tool}); installed copies: ${copies.length}; the same bundle as this checkout: ${same.join(', ') || 'none found'}`);
        if (!loaded) failed = true;
    }

    // And taking them out again, as the README says.
    for (const f of FORMS) {
        const spec = `${repository}#${ref}::path:polyfills/${f.folder}/opencode/plugin`;
        const r = spawnSync(openCodeBin(), ['plugin', 'remove', spec], { env: world.env, cwd: world.project, encoding: 'utf8', timeout: 60000 });
        console.log(`opencode plugin remove ${spec}\n  -> exit ${r.status}: ${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').at(-1)}`);
        if (r.status !== 0) failed = true;
    }
    const left = JSON.parse(readFileSync(join(world.home, '.config', 'opencode', 'opencode.json'), 'utf8')).plugins ?? [];
    console.log(`plugins left in the global opencode.json: ${JSON.stringify(left)}`);
    if (left.length) failed = true;
} finally {
    await world.stop();
}
process.exit(failed ? 1 : 0);
