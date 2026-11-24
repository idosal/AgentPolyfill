// Bundles the helper, with the shared Events client (../core), into
// plugin/dist/helper.js, so the installed plugin folder runs on its own, with no
// node_modules and nothing outside it. plugin/dist/ is committed; test/plugin-test.ts
// fails when it is stale.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
// A fixed working directory and a pinned esbuild keep paths and output stable.
await build({
    absWorkingDir: root,
    entryPoints: ['src/helper.ts'],
    entryNames: '[name]',
    outdir: process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'plugin', 'dist'),
    platform: 'node',
    format: 'esm',
    // Node 20 is the oldest the MCP SDK runs on.
    target: 'node20',
    bundle: true,
    minify: true,
    sourcemap: false,
    // Bundled CommonJS dependencies (cross-spawn) still require Node builtins.
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    logLevel: 'info'
});
