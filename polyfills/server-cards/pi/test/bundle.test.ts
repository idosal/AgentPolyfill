import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { temp } from './pi-rpc.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
test('bundle: committed extension/dist/index.js is byte-identical to a fresh build', () => {
  const out = temp('bundle-')
  try {
    execFileSync(process.execPath, [join(ROOT, 'build.mjs'), '--out', out], { cwd: ROOT })
    assert.equal(readFileSync(join(ROOT, 'extension/dist/index.js'), 'utf8'), readFileSync(join(out, 'index.js'), 'utf8'))
    const pkg = JSON.parse(readFileSync(join(ROOT, 'extension/package.json'), 'utf8'))
    assert.deepEqual(pkg.pi, { extensions: ['./dist/index.js'] })
    assert.deepEqual(pkg.keywords, ['pi-package'])
    assert.equal(pkg.type, 'module')
  } finally { rmSync(out, { recursive: true, force: true }) }
})
