// Bundles the extension, with the shared Events client (../core) and the session code it shares
// with the Codex form (../codex/src/threads.ts), into plugin/extensions/mcp-events/extension.mjs, so
// the installed plugin folder runs on its own, with no node_modules. Copilot runs it with its own
// Node and provides @microsoft/copilot-sdk, which stays out of the bundle. The output is committed;
// test/plugin-test.ts fails when it is stale.
//
//   node build.mjs           build plugin/extensions/mcp-events/extension.mjs
//   node build.mjs <dir>     build extension.mjs into <dir> instead (the staleness test)
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
await build({
    absWorkingDir: root,
    entryPoints: { extension: 'src/extension.ts' },
    outdir: process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'plugin', 'extensions', 'mcp-events'),
    outExtension: { '.js': '.mjs' },
    platform: 'node',
    format: 'esm',
    // Copilot 1.0.115 runs extensions on its own Node 24; Node 22 is what the tests run on.
    target: 'node22',
    bundle: true,
    minify: true,
    sourcemap: false,
    external: ['@microsoft/copilot-sdk', '@microsoft/copilot-sdk/*'],
    // Bundled CommonJS dependencies (cross-spawn) still require Node builtins.
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    logLevel: 'info'
});
