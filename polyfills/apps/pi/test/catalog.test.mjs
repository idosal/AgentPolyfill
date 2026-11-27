import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isModelVisible } from '../visibility.mjs';

const run = promisify(execFile);
const path = relative => fileURLToPath(new URL(relative, import.meta.url));
const cli = process.env.PI_APPS_TEST_CLI ?? path('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const qualified = name => 'mcp__catalog__' + name;

test('model visibility defaults to both and ignores invalid declarations', () => {
    assert.equal(isModelVisible({}), true);
    for (const visibility of [[], ['app'], null, 'model'])
        assert.equal(isModelVisible({_meta:{ui:{visibility}}}), false);
});

test('an unrecognized runtime can still load in Pi with Apps disabled', async t => {
    const root = await mkdtemp(join(tmpdir(), 'pi-apps-build-'));
    t.after(() => rm(root, {force:true, recursive:true}));
    const dist = join(root, 'dist');
    await mkdir(join(dist, 'extensions/mcp'), {recursive:true});
    await writeFile(join(root, 'package.json'), JSON.stringify({type:'module'}));
    await writeFile(join(dist, 'extensions/mcp/runtime.js'), 'export const label = "native runtime";');
    const entry = join(dist, 'cli.js');
    await writeFile(entry, `import assert from 'node:assert/strict';
        import { protectModelCatalog } from ${JSON.stringify(new URL('../visibility.mjs', import.meta.url).href)};
        assert.throws(() => protectModelCatalog(process.argv[2], '1.6.0'), /does not recognize/);
        assert.throws(() => protectModelCatalog(process.argv[2], 'unknown'), /supported Node build/);
        assert.equal((await import('./extensions/mcp/runtime.js')).label, 'native runtime');`);
    await run(process.execPath, [entry, root]);
});

for (const exposure of ['direct','codemode','deferred']) {
    test('real Pi filters both catalog pages and a visibility change with ' + exposure + ' exposure', async t => {
        const home = await mkdtemp(join(tmpdir(), 'pi-apps-catalog-'));
        t.after(() => rm(home, {force:true, recursive:true}));
        const profile = join(home, 'agent'), log = join(home, 'observations');
        await mkdir(profile);
        await writeFile(join(profile,'mcp.json'), JSON.stringify({mcpServers:{catalog:{
            command:process.execPath, args:[path('catalog-server.mjs')], exposure, toolExposure:{switch_catalog:'direct'}
        }}}));
        const invocation = run(process.execPath, [cli, '--offline','--no-session','--provider','catalog-observer','--model','offline',
            '-e', path('catalog-provider.ts'), '-e', path('../index.ts'),'-p','Switch editions'], {
            cwd:home, env:{HOME:home,PATH:process.env.PATH,PI_CODING_AGENT_DIR:profile,CATALOG_OBSERVATIONS:log},
            timeout:20000
        });
        invocation.child.stdin.end();
        await invocation;
        const [before, after] = (await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
        assert.ok(before && after);
        assert.ok(before.registered.includes(qualified('default_label')));
        assert.ok(before.registered.includes(qualified('retired')));
        assert.ok(!before.registered.includes(qualified('new_label')));
        assert.ok(!after.registered.includes(qualified('retired')));
        assert.ok(after.registered.includes(qualified('new_label')));
        for (const observation of [before, after]) {
            for (const hidden of ['app_label','unlisted']) assert.ok(!JSON.stringify(observation).includes(qualified(hidden)));
        }
        if (exposure === 'direct') {
            assert.ok(JSON.stringify(before.declarations).includes(qualified('retired')));
            assert.ok(!after.active.includes(qualified('retired')));
        }
    });
}
