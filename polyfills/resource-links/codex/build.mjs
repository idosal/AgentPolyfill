// Bundles the plugin's MCP server and its hook into mod/dist/{helper,hook}.js, with the
// shared core (../core) inside them, so the installed plugin folder runs on its own with
// no node_modules. mod/dist/ is committed; test/bundle-test.ts fails when it is stale.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
// A fixed working directory and a pinned esbuild keep paths and output stable.
await build({
    absWorkingDir: root,
    entryPoints: ['src/helper.ts', 'src/hook.ts'],
    entryNames: '[name]',
    outdir: process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'mod', 'dist'),
    platform: 'node',
    format: 'esm',
    target: 'node20',
    bundle: true,
    minify: true,
    sourcemap: false,
    logLevel: 'info'
});
