// Build an independently installable plugin, plus rule tests redirected at its bundle.
import { mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export async function buildCards(esbuild, root, ard) {
  const args = process.argv.slice(2), out = join(root, 'plugin/dist')
  if (args.includes('--tests')) {
    const testout = join(root, 'test/.build')
    rmSync(testout, { recursive: true, force: true }); mkdirSync(testout, { recursive: true })
    const shared = ['card', 'configure', 'discover', 'format', 'offer'].map(n => join(repo, `polyfills/server-cards/claude-code/mod/tests/${n}.test.ts`))
    if (ard) shared.push(join(repo, 'polyfills/ard/claude-code/mod/tests/registry.test.ts'))
    const files = [...shared, ...readdirSync(join(root, 'test')).filter(n => n.endsWith('.test.ts')).map(n => join(root, 'test', n))]
    for (const file of files) await esbuild.build({ entryPoints: [file], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: join(testout, basename(file).replace('.ts', '.mjs')), logLevel: 'error', plugins: [{ name: 'installed-helper', setup(b) {
      b.onResolve({ filter: /^claude-code\/testing$/ }, () => ({ path: join(repo, 'polyfills/server-cards/codex/test/testing.ts') }))
      b.onResolve({ filter: /(^|\/)(hooks|src)\/[\w.-]+$/ }, a => {
        const path = resolve(a.resolveDir, a.path)
        if (path.includes('/mod/hooks/') || path.includes('/hermes/src/')) return { path: '../../plugin/dist/helper.mjs', external: true }
      })
    } }] })
    return
  }
  const result = await esbuild.build({ absWorkingDir: repo, entryPoints: [join(root, 'src/main.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false, logLevel: 'error', legalComments: 'none' })
  const helper = result.outputFiles[0].text
  // Import a data URL: exports are available without invoking the stdio entrypoint.
  const mod = await import('data:text/javascript;base64,' + Buffer.from(helper).toString('base64'))
  const outputs = new Map([
    [join(out, 'helper.mjs'), helper],
    [join(out, 'words.json'), JSON.stringify({ tools: mod.TOOLS, instructions: mod.INSTRUCTIONS }, null, 2) + '\n'],
    ...['_helper.py', '_servers.py', '_card_config.py', '_card_runtime.py'].map(n => [join(root, 'plugin', n), readFileSync(join(repo, 'tools/hermes/shared', n), 'utf8')]),
  ])
  if (args.includes('--check')) {
    for (const [p, text] of outputs) if (readFileSync(p, 'utf8') !== text) throw new Error(`${p} is stale; run npm run build`)
    console.log('Bundle, tool schemas and Python shared modules are up to date')
  } else {
    mkdirSync(out, { recursive: true })
    for (const [p, text] of outputs) writeFileSync(p, text)
    console.log('Built plugin/dist/helper.mjs, words.json and shared Python modules')
  }
}
