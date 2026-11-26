import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
await build({
    absWorkingDir: root,
    entryPoints: ['src/server.ts', 'src/tui.ts', 'src/rpc.ts'],
    outdir: resolve(process.argv[2] ?? resolve(root, 'plugin')),
    platform: 'node',
    format: 'esm',
    target: 'node22',
    bundle: true,
    minify: true,
    external: ['@opencode/plugin/*', '@opencode/plugin'],
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }
});
