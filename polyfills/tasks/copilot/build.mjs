import { build } from 'esbuild';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
await build({
    absWorkingDir: root,
    entryPoints: ['src/extension.ts'],
    outfile: resolve(process.argv[2] ?? resolve(root, 'plugin/extensions/mcp-tasks/extension.mjs')),
    platform: 'node',
    format: 'esm',
    target: 'node20',
    bundle: true,
    minify: true,
    external: ['@github/copilot-sdk/extension'],
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }
});
