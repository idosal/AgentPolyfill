// Build from the shared Tasks packages and their committed dependency locks.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../tasks/codex/package.json', import.meta.url));
const { build } = require('esbuild');
await build({
    absWorkingDir: fileURLToPath(new URL('.', import.meta.url)), entryPoints: ['host.ts'],
    outfile: 'host.mjs', platform: 'node', format: 'esm', target: 'node20', bundle: true, minify: true,
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }
});
