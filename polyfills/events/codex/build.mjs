// Bundles the helper, with the shared Events client (../core), into
// plugin/dist/helper.js, so the installed plugin folder runs on its own, with no
// node_modules and nothing outside it. The same folder is the Muse plugin: its
// UserPromptSubmit hook is bundled on its own into plugin/muse/hooks/, because Muse
// trusts a hook by its one script file. Both are committed; test/plugin-test.ts fails
// when either is stale. With a folder argument (the tests), both go there.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const out = process.argv[2] ? resolve(process.argv[2]) : undefined;
// A fixed working directory and a pinned esbuild keep paths and output stable.
const common = {
    absWorkingDir: root,
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
};
await build({ ...common, entryPoints: ['src/helper.ts'], entryNames: '[name]', outdir: out ?? resolve(root, 'plugin', 'dist') });
await build({ ...common, entryPoints: ['src/muse-prompt-hook.ts'], outfile: out ? join(out, 'user-prompt-submit.mjs') : resolve(root, 'plugin', 'muse', 'hooks', 'user-prompt-submit.mjs') });
