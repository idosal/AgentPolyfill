#!/usr/bin/env node
// Writes THIRD_PARTY_LICENSES.txt: the license of every crate compiled into
// the helper (normal dependencies, for each platform the plugin ships for)
// and of every npm package bundled into its host page (mod/helper/host/host.js),
// with each one's own license and notice files.
//
//   node package/third-party.mjs [--check]
//
// --check fails if the file on disk differs from what it would write.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGETS = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-unknown-linux-musl',
  'aarch64-unknown-linux-musl',
  'x86_64-pc-windows-msvc',
]
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense|copyright)/i

function licenseTexts(folder) {
  const names = readdirSync(folder).filter((name) => LICENSE_FILE.test(name)).sort()
  return names.map((name) => ({ name, text: readFileSync(join(folder, name), 'utf8').trim() }))
}

// Crates: what cargo builds for each shipped platform (normal dependencies
// with that platform's features, as `cargo tree` resolves them), from the
// lock file. Build scripts' and tests' dependencies aren't shipped.
const helperRs = join(root, 'helper-rs')
const run = (args) =>
  execFileSync('cargo', args, { cwd: helperRs, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }).toString()
const metadata = JSON.parse(run(['metadata', '--format-version', '1', '--locked']))
const byKey = new Map(metadata.packages.map((pkg) => [`${pkg.name} ${pkg.version}`, pkg]))
const ours = new Set(metadata.workspace_members.map((id) => metadata.packages.find((pkg) => pkg.id === id)?.name))
const crates = new Map()
for (const target of TARGETS) {
  const listed = run(['tree', '--locked', '-e', 'normal', '--target', target, '--prefix', 'none', '-f', '{p}'])
  for (const line of listed.split('\n')) {
    const match = /^(\S+) v(\S+)/.exec(line.trim())
    if (!match || ours.has(match[1])) continue
    const key = `${match[1]} ${match[2]}`
    const pkg = byKey.get(key)
    if (!pkg) throw new Error(`cargo tree lists ${key}, which cargo metadata doesn't`)
    crates.set(key, pkg)
  }
}

// npm packages: those the host page bundle names in its source comments.
const bundle = readFileSync(join(root, 'mod/helper/host/host.js'), 'utf8')
const bundled = new Set(
  [...bundle.matchAll(/^\s*\/\/ (?:\.\.\/)*node_modules\/((?:@[^/]+\/)?[^/]+)\//gm)].map((match) => match[1]),
)
const npm = []
for (const name of [...bundled].sort()) {
  const folder = join(root, 'mod/helper/node_modules', name)
  if (!existsSync(join(folder, 'package.json'))) {
    throw new Error(`${name} is bundled in host.js but isn't installed (run npm ci in mod/helper)`)
  }
  const pkg = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'))
  npm.push({ name, version: pkg.version, license: pkg.license, repository: pkg.repository?.url ?? pkg.repository, folder })
}

const lines = [
  'Third-party software in mcp-apps-cli',
  '',
  "The plugin's helper binaries are built from Rust crates, and the page that",
  'hosts each MCP App view bundles npm packages. Each is listed below with its',
  'license, followed by the license and notice files it ships.',
  '',
]
const missing = []
function section(title, license, repository, texts) {
  lines.push('='.repeat(78), title, `License: ${license || 'unspecified'}`)
  if (repository) lines.push(`Source: ${repository}`)
  lines.push('')
  if (texts.length === 0) {
    missing.push(title)
    lines.push(`(No license file is included in this package; its license is ${license}.)`, '')
  }
  for (const { name, text } of texts) lines.push(`--- ${name} ---`, '', text, '')
}
for (const key of [...crates.keys()].sort()) {
  const pkg = crates.get(key)
  section(`${pkg.name} ${pkg.version} (Rust crate)`, pkg.license ?? pkg.license_file, pkg.repository, licenseTexts(dirname(pkg.manifest_path)))
}
for (const pkg of npm) {
  section(`${pkg.name} ${pkg.version} (npm package)`, pkg.license, pkg.repository, licenseTexts(pkg.folder))
}
const output = lines.join('\n').replace(/\n+$/, '\n')

const file = join(root, 'THIRD_PARTY_LICENSES.txt')
if (process.argv.includes('--check')) {
  if (!existsSync(file) || readFileSync(file, 'utf8') !== output) {
    console.error('THIRD_PARTY_LICENSES.txt is out of date: run node package/third-party.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(file, output)
}
console.error(`${crates.size} crates, ${npm.length} npm packages${missing.length ? `; no license file in: ${missing.join(', ')}` : ''}`)
