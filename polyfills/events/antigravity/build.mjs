// Reuse the Antigravity builder and already installed Codex dependencies.
import * as esbuild from '../codex/node_modules/esbuild/lib/main.js';
import { build } from '../../server-cards/antigravity/build.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = dirname(fileURLToPath(import.meta.url));
const shim = 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);';
if (process.argv.includes('--probe')) {
    await esbuild.build({ entryPoints: [join(root, 'test/probe.ts')], outfile: join(root, 'test/.build/probe.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node20', banner: { js: shim } });
} else await build({
    esbuild: { build: o => esbuild.build({ ...o, banner: { js: `${o.banner?.js ?? ''}\n${shim}` }, plugins: [{
        name: 'shared-test-harness', setup(b) {
            b.onResolve({ filter: /^\.\/harness\.ts$/ }, args => /events\/claude-code\/test\//.test(args.importer) ? { path: join(root, 'test/harness.ts') } : undefined);
        }
    }] }) },
    root, name: 'mcp-events', version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
});
