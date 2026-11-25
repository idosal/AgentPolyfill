// Bundles the Muse form, with the Codex form's sources it reuses (../codex/src) and the shared
// Skills client (../core), into the Codex plugin folder, beside the Codex bundle and apart from it:
//   ../codex/mod/muse/dist/helper.js               the MCP server (.muse-plugin/plugin.json starts it)
//   ../codex/mod/muse/hooks/user-prompt-submit.mjs  the UserPromptSubmit hook
// One module differs: where the Codex form's own files import its stubs.ts, this bundle gives them
// src/stubs.ts, which writes the stubs flat into Muse's skill folder. The Codex bundle
// (../codex/mod/dist/helper.js) is built by ../codex/build.mjs alone, from unchanged sources, and is
// the same whether or not this form exists. Both are committed; test/plugin-test.ts fails when
// these are stale. It uses the Codex form's pinned esbuild, so the two are built alike.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const codexSrc = resolve(root, '..', 'codex', 'src');
const { build } = createRequire(resolve(root, '..', 'codex', 'package.json'))('esbuild');
const mod = resolve(root, '..', 'codex', 'mod', 'muse');
const out = process.argv[2] ? resolve(process.argv[2]) : undefined;

/** The Codex form's files get the Muse stubs module in place of their own. */
const museStubs = {
    name: 'muse-stubs',
    setup(b) {
        b.onResolve({ filter: /(^|\/)stubs\.ts$/ }, (args) => {
            const target = resolve(args.resolveDir, args.path);
            if (target === join(codexSrc, 'stubs.ts') && dirname(args.importer) === codexSrc) return { path: resolve(root, 'src', 'stubs.ts') };
            return undefined;
        });
    }
};
const common = {
    absWorkingDir: root,
    platform: 'node',
    format: 'esm',
    // Node 20 is the oldest the MCP SDK runs on.
    target: 'node20',
    bundle: true,
    minify: true,
    sourcemap: false,
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    logLevel: 'info'
};
await build({ ...common, entryPoints: ['src/helper.ts'], entryNames: '[name]', outdir: out ?? join(mod, 'dist'), plugins: [museStubs] });
await build({ ...common, entryPoints: ['src/muse-prompt-hook.ts'], outfile: out ? join(out, 'user-prompt-submit.mjs') : join(mod, 'hooks', 'user-prompt-submit.mjs') });
