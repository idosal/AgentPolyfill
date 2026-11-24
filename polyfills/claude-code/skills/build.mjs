// Bundles the mod's helper process into dist/, so an installed copy runs with
// no node_modules. mod/dist/ is committed; test/helper-test.ts fails when it is stale.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
// A fixed working directory and a pinned esbuild keep paths and output stable.
await build({
    absWorkingDir: root,
    entryPoints: ['src/helper.ts'],
    entryNames: '[name]',
    outdir: process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'mod', 'dist'),
    platform: 'node',
    format: 'esm',
    // Node 20 is the oldest the MCP SDK runs on; Bun runs the same bundle.
    target: 'node20',
    bundle: true,
    minify: true,
    sourcemap: false,
    // Bundled CommonJS dependencies (e.g. cross-spawn) still require Node builtins.
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    logLevel: 'info'
});
