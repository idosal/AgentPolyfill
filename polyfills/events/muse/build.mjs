// Bundles the Muse form, with the Codex form's sources it reuses (../codex/src) and the shared
// Events client (../core), into the Codex plugin folder, beside the Codex bundle and apart from it:
//   ../codex/plugin/muse/dist/helper.js             the MCP server (.muse-plugin/plugin.json starts it)
//   ../codex/plugin/muse/hooks/user-prompt-submit.mjs the UserPromptSubmit hook
// The Codex bundle (../codex/plugin/dist/helper.js) is built by ../codex/build.mjs alone, and is the
// same whether or not this form exists. Both bundles are committed; test/plugin-test.ts fails when
// these are stale. It uses the Codex form's pinned esbuild, so the two are built alike.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const { build } = createRequire(resolve(root, '..', 'codex', 'package.json'))('esbuild');
const plugin = resolve(root, '..', 'codex', 'plugin', 'muse');
const out = process.argv[2] ? resolve(process.argv[2]) : undefined;
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
await build({ ...common, entryPoints: ['src/helper.ts'], entryNames: '[name]', outdir: out ?? join(plugin, 'dist') });
await build({ ...common, entryPoints: ['src/muse-prompt-hook.ts'], outfile: out ? join(out, 'user-prompt-submit.mjs') : join(plugin, 'hooks', 'user-prompt-submit.mjs') });
