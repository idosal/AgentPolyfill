import { build } from 'esbuild';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
await build({ absWorkingDir: root, entryPoints: ['src/helper.ts'], outfile: 'plugin/dist/helper.mjs',
    platform: 'node', format: 'esm', target: 'node22', bundle: true, minify: true,
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
for (const name of ['_helper.py','_servers.py']) {
    copyFileSync(new URL('../../../tools/hermes/shared/' + name, import.meta.url), new URL('plugin/' + name, import.meta.url));
}
