import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
// A fixed working directory and a pinned esbuild keep paths and output stable.
await build({
    absWorkingDir: root,
    entryPoints: ["src/bridge.mjs"],
    entryNames: '[name]',
    outExtension: { '.js': '.mjs' },
    outdir: process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'plugin', 'dist'),
    platform: 'node',
    format: 'esm',
    target: 'node22',
    bundle: true,
    minify: true,
    sourcemap: false,
    // Bundled CommonJS dependencies (cross-spawn) still require Node builtins.
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    logLevel: 'info'
});
