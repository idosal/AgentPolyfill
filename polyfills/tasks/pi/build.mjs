// Bundles the extension, with the shared Tasks client (../core), into
// extension/dist/index.js, so the installed folder runs on its own, with no
// node_modules and nothing outside it. Pi's own packages stay imports: Pi maps
// them to its own copies when it loads an extension. extension/dist/ is
// committed; test/bundle-test.ts fails when it is stale.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
await build({
    absWorkingDir: root,
    entryPoints: ['src/index.ts'],
    entryNames: '[name]',
    outdir: process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'extension', 'dist'),
    platform: 'node',
    format: 'esm',
    target: 'node22',
    bundle: true,
    minify: true,
    sourcemap: false,
    external: ['@earendil-works/*'],
    // Bundled CommonJS dependencies (cross-spawn) still require Node builtins.
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    logLevel: 'info'
});
