// Builds the Muse form's one file, ../codex/plugin/muse/dist/server.mjs, from src/ and the Codex
// form's sources and the shared modules it imports (bundled, never copied), with the Codex form's
// `bundle` and `bundleTests` (../codex/build.mjs) and its pinned esbuild. The Codex bundle,
// ../codex/plugin/dist/server.mjs, is built by ../codex/build.mjs alone, from unchanged sources.
//
//   node build.mjs             build ../codex/plugin/muse/dist/server.mjs
//   node build.mjs --check     fail if it is not what the sources build
//   node build.mjs --out DIR   build server.mjs into DIR instead (test/bundle.test.ts)
//   node build.mjs --tests     build the tests into test/.build, run by `npm test`
//
// The tests run against the committed Muse bundle: every import of the adapter or a shared
// module is pointed at it. Run `npm run build` after changing the sources; test/bundle.test.ts
// fails while it is stale.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundle } from '../codex/build.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The tests, each bundled to test/.build/<name>.test.mjs, as the Codex form's bundleTests does it,
 * but against the Muse bundle: every import of a shared module (`hooks/<x>`), of the Codex
 * adapter (`codex/src/...`) or of this form (`muse/src/...`) is the built Muse file.
 */
export async function bundleMuseTests({ esbuild, root, files, server }) {
  const outDir = resolve(root, 'test/.build')
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const shim = resolve(here, '../codex/test/testing.ts')
  const toServer = relative(outDir, server).split('\\').join('/')
  const redirect = {
    name: 'to-the-muse-bundle',
    setup(b) {
      b.onResolve({ filter: /^claude-code\/testing$/ }, () => ({ path: shim }))
      b.onResolve({ filter: /(^|\/)(hooks|src|dist)\/[\w.-]+$/ }, args => {
        const target = resolve(args.resolveDir, args.path)
        const shared = /[/\\]mod[/\\]hooks[/\\]/.test(target) && !target.endsWith('fixtures')
        const adapter = /[/\\](codex|muse)[/\\](src|plugin[/\\](muse[/\\])?dist)[/\\]/.test(target)
        return shared || adapter ? { path: `./${toServer}`, external: true } : undefined
      })
    },
  }
  for (const file of files) {
    await esbuild.build({
      entryPoints: [file],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      outfile: join(outDir, basename(file).replace(/\.test\.tsx?$/, '.test.mjs')),
      plugins: [redirect],
      logLevel: 'error',
    })
  }
}

/** Builds a Muse form of a Codex plugin (this one, and ARD's through it) into <codex>/plugin/muse/dist/server.mjs. */
export async function museMain({ root, codexRoot, entry, name, version }) {
  const esbuild = createRequire(join(codexRoot, 'package.json'))('esbuild')
  const server = resolve(codexRoot, 'plugin/muse/dist/server.mjs')
  const args = process.argv.slice(2)
  if (args.includes('--tests')) {
    const own = readdirSync(resolve(root, 'test'))
      .filter(f => f.endsWith('.test.ts'))
      .map(f => resolve(root, 'test', f))
    const rules = ['card', 'configure', 'discover', 'format'].map(name =>
      resolve(here, '../claude-code/mod/tests', name + '.test.ts'))
    await bundleMuseTests({ esbuild, root, files: [...own, ...rules], server })
    return
  }
  const text = (await bundle({ esbuild, root, entry, name, version })).replace(/^(\/\/ \S+ \S+), for Codex\./, '$1, for Muse Code.')
  const out = args.indexOf('--out')
  if (out >= 0) {
    const dir = resolve(args[out + 1] ?? '.')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'server.mjs'), text)
    return
  }
  if (args.includes('--check')) {
    let held = ''
    try {
      held = readFileSync(server, 'utf8')
    } catch {}
    if (held !== text) {
      console.error(`${relative(process.cwd(), server)} is not what the sources build. Run: npm run build`)
      process.exit(1)
    }
    console.log(`${relative(process.cwd(), server)} is up to date`)
    return
  }
  mkdirSync(dirname(server), { recursive: true })
  writeFileSync(server, text)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await museMain({
    root: here,
    codexRoot: resolve(here, '../codex'),
    entry: 'src/main.ts',
    name: 'mcp-server-cards',
    version: JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version,
  })
}
