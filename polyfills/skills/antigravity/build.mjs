import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../../server-cards/antigravity/build.mjs';

const root = dirname(fileURLToPath(import.meta.url));
// Shared build driver, with the CommonJS compatibility the Skills SDK needs.
const wrapped = { build: opts => esbuild.build({
    ...opts,
    banner: { js: (opts.banner?.js ?? '') + '\nimport { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    plugins: [{ name: 'fixture-location', setup(b) {
        b.onLoad({ filter: /skills\/claude-code\/test\/harness\.ts$/ }, args => ({
            contents: readFileSync(args.path, 'utf8').replace("fileURLToPath(new URL('./fixture-skills-server.ts', import.meta.url))", JSON.stringify(resolve(root, 'test/.build/fixture.mjs'))), loader: 'ts'
        }));
    } }]
}) };
if (process.argv.includes('--tests') || process.argv.includes('--interop')) {
    await esbuild.build({ entryPoints: [resolve(root, '../claude-code/test/fixture-skills-server.ts')], outfile: resolve(root, 'test/.build/fixture.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node20' });
}
if (process.argv.includes('--interop')) {
    await wrapped.build({ entryPoints: [resolve(root, 'test/interop/real.ts')], outfile: resolve(root, 'test/.build/interop.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node20' });
} else {
    await build({ esbuild: wrapped, root, name: 'mcp-skills', version: '0.1.0' });
    // The shared driver recreates .build; put the independently written fixture there afterwards.
    if (process.argv.includes('--tests')) await esbuild.build({ entryPoints: [resolve(root, '../claude-code/test/fixture-skills-server.ts')], outfile: resolve(root, 'test/.build/fixture.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node20' });
}
