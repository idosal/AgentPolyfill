// Bundles the helper, with the shared Events client (../core), into plugin/dist/helper.mjs,
// and writes plugin/dist/words.json (the tools and the system-prompt paragraph, which the
// Python half registers before the helper runs). The installed plugin folder then runs on
// its own, with no node_modules and nothing outside it. plugin/dist/ is committed;
// test/plugin-test.ts fails when it is stale.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const out = process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'plugin', 'dist');
await build({
    absWorkingDir: root,
    entryPoints: ['src/helper.ts'],
    outfile: join(out, 'helper.mjs'),
    platform: 'node',
    format: 'esm',
    target: 'node20',
    bundle: true,
    minify: true,
    sourcemap: false,
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    logLevel: 'info'
});
const words = await import(pathToFileURL(join(root, 'src', 'words.ts')).href);
const { WAKE_HEADER } = await import(pathToFileURL(join(root, 'src', 'session.ts')).href);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'words.json'), JSON.stringify({ tools: words.TOOLS, instructions: words.INSTRUCTIONS, wakeHeader: WAKE_HEADER }, null, 2) + '\n');
// The Python modules every Hermes form shares (tools/hermes/shared), copied in: the plugin folder is installed on its own.
for (const f of ['_helper.py', '_servers.py']) copyFileSync(join(root, '..', '..', '..', 'tools', 'hermes', 'shared', f), join(root, 'plugin', f));
