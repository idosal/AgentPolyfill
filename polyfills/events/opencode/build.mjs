// Bundles the plugin, with the shared Events client (../core), into
// plugin/server.js: the one file OpenCode loads from the plugin folder, with no
// node_modules and nothing outside it. plugin/server.js is committed;
// `node build.mjs --check` (and the tests) fail when it is stale.
//
//   node build.mjs           build plugin/server.js
//   node build.mjs --check   fail if plugin/server.js is not what the sources build
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const out = resolve(root, 'plugin', 'server.js');
const check = process.argv.includes('--check');
const result = await build({
    absWorkingDir: root,
    entryPoints: ['src/plugin.ts'],
    outfile: out,
    write: !check,
    platform: 'node',
    format: 'esm',
    // OpenCode runs plugins in its own runtime (Bun); the bundle keeps to what Node 20 has too.
    target: 'node20',
    bundle: true,
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    // Bundled CommonJS dependencies (cross-spawn) still require Node builtins.
    banner: { js: 'import { createRequire as __agentpolyfillRequire } from "node:module"; const require = __agentpolyfillRequire(import.meta.url);' },
    logLevel: check ? 'silent' : 'info'
});
if (check) {
    const fresh = result.outputFiles[0].text;
    const committed = readFileSync(out, 'utf8');
    if (fresh !== committed) {
        console.error('plugin/server.js is stale: run npm run build');
        process.exit(1);
    }
    console.log('plugin/server.js is up to date');
}
