// A runtime of the mod's own, for a machine that has neither Node nor Bun.
//
// The helper (dist/helper.js) is JavaScript, and Claude Code installs with no JavaScript runtime a
// plugin can start. Where none is found, the person can have the mod fetch one: `/mcp-skills setup`
// downloads the official Bun release for this platform into the plugin's own data folder, and the
// helper runs on that copy. Nothing else on the machine changes: no PATH entry, no shell profile.
//
// What makes that safe to offer:
//   - it happens only when the person types the command (never from the model, a script or `-p`);
//   - the version is fixed here, and so is the SHA-256 of each platform's archive, copied from the
//     release's own SHASUMS256.txt: an archive that does not match is deleted and nothing is run;
//   - the archive is hashed in this module, so no checksum program on the PATH is trusted;
//   - exactly one named file is taken out of the archive, into a folder made for it, and the copy is
//     moved into place only after it answered with the version expected.
//
// It needs `curl` and `unzip`, as Bun's own installer does.

import type { EngineInterface } from 'claude-code'

// Present where a hooks module runs; the typings for one just do not name them.
declare const crypto: { subtle: { digest: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer> } }
declare const atob: (base64: string) => string

export type Pin = {
  version: string
  /** The folder of the release's files, ending in a slash. */
  base: string
  /** Per platform: the archive's name without `.zip` (also the folder inside it) and its SHA-256. */
  assets: Record<string, { name: string; sha256: string }>
}

/**
 * The Bun release this version of the mod fetches. The x64 builds are the "baseline" ones, which run
 * on any x64 processor. To move to a newer release: change the version and copy the six sums from
 * that release's SHASUMS256.txt.
 */
export const BUN: Pin = {
  version: '1.4.5',
  base: 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.5/',
  assets: {
    'darwin-arm64': { name: 'bun-darwin-aarch64', sha256: 'b5d6bc2e13caf14e57c89661e89efd073ff16165b41bfe43882616410609cd10' },
    'darwin-x64': { name: 'bun-darwin-x64-baseline', sha256: 'fb0121739a7e80e7511b6bfe4d2116422b48ba18a013acadef0c425348e95891' },
    'linux-arm64': { name: 'bun-linux-aarch64', sha256: '18656a3bf0ea5641f5796ae4213b75255579a70a0fded2f337933785568cdf84' },
    'linux-arm64-musl': { name: 'bun-linux-aarch64-musl', sha256: 'd655765d3a0c0fdf707e27c7aa1a4f2c84f1bbc1f759db7e6e3d3c5be414396c' },
    'linux-x64': { name: 'bun-linux-x64-baseline', sha256: 'dcb23a18a1c2fff12d57bcef696dbbb42eb67fde29f43816ecb595459a24c463' },
    'linux-x64-musl': { name: 'bun-linux-x64-musl-baseline', sha256: '96fb94108eed872ff623ed39007d6b5699a83a5d0086fcfba84921c18145e3e6' },
  },
}

/** No archive of a runtime is anywhere near this size: a download past it is not what was asked for. */
const LIMIT = 200 * 1024 * 1024
/** One read of the archive: under the 4 MiB a read may answer, base64 included. */
const STEP = 2 * 1024 * 1024

/** Why the mod's own runtime could not be set up, in words for the person. */
export class SetupError extends Error {}

type Ran = { ok: boolean; stdout: string; stderr: string; isMissing: boolean }
async function run($: EngineInterface, argv: string[], timeoutMs = 20_000): Promise<Ran> {
  try {
    const { exitCode, stdout, stderr } = await $.process.run(argv, { timeoutMs })
    return { ok: exitCode === 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), isMissing: exitCode === 127 }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return { ok: false, stdout: '', stderr: why, isMissing: /ENOENT|not found/i.test(why) }
  }
}
const brief = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 200)

/** `darwin-arm64`, `linux-x64-musl` and so on; undefined where the mod fetches no runtime (Windows, anything else). */
export async function platformOf($: EngineInterface): Promise<string | undefined> {
  const [system, machine] = (await run($, ['uname', '-sm'])).stdout.trim().split(/\s+/)
  const arch = machine === 'arm64' || machine === 'aarch64' ? 'arm64' : machine === 'x86_64' || machine === 'amd64' ? 'x64' : undefined
  if (!arch) return undefined
  if (system === 'Darwin') return `darwin-${arch}`
  if (system !== 'Linux') return undefined
  // musl, by what ldd says of itself, or by the loader a musl system has (where ldd is missing or says nothing).
  const ldd = await run($, ['ldd', '--version'])
  const loader = `/lib/ld-musl-${arch === 'arm64' ? 'aarch64' : 'x86_64'}.so.1`
  const isMusl = /musl/i.test(`${ldd.stdout}${ldd.stderr}`) || (await $.fs.exists(loader).catch(() => false)) || (await $.fs.exists('/etc/alpine-release').catch(() => false))
  return `linux-${arch}${isMusl ? '-musl' : ''}`
}

const folder = (data: string) => `${data}/runtime`

/** The copies of Bun this mod fetched earlier that still run, newest first. */
export async function fetched($: EngineInterface, data: string): Promise<{ path: string; version: string }[]> {
  const entries = await $.fs.list(folder(data)).catch(() => [])
  const found: { path: string; version: string }[] = []
  for (const entry of entries) {
    const version = /^bun-(\d+\.\d+\.\d+)$/.exec(entry.name)?.[1]
    if (!version || entry.kind !== 'dir' || entry.isLink) continue
    const path = `${folder(data)}/${entry.name}/bun`
    // A copy that no longer answers with its own version, and exits cleanly, (cut short, damaged) is not used.
    const says = await run($, [path, '--version'])
    if (says.ok && says.stdout.trim() === version) found.push({ path, version })
  }
  const parts = (v: string) => v.split('.').map(Number) as [number, number, number]
  return found.sort((a, b) => {
    const [x, y] = [parts(a.version), parts(b.version)]
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]
  })
}

/** The SHA-256 of a file, read in pieces and hashed here. */
export async function sha256Of($: EngineInterface, path: string, size: number): Promise<string> {
  const all = new Uint8Array(size)
  for (let at = 0; at < size; at += STEP) {
    const { base64 } = await $.fs.read(path, { as: 'bytes', offset: at, length: Math.min(STEP, size - at) })
    const raw = atob(base64)
    if (at + raw.length > size) throw new SetupError('The download changed while it was being checked. Nothing was installed.')
    for (let i = 0; i < raw.length; i++) all[at + i] = raw.charCodeAt(i)
  }
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Deletes a path, and answers whether it is gone. */
async function erase($: EngineInterface, path: string): Promise<boolean> {
  await run($, ['rm', '-rf', path])
  if (!(await $.fs.exists(path).catch(() => true))) return true
  // It could not be deleted: at least nothing in it is left runnable.
  await run($, ['chmod', '-R', 'a-x', path])
  return false
}

/** How long a lock of another session is waited out before it is taken as left behind. */
const LOCK_MS = 15 * 60 * 1000

/**
 * Fetches the pinned Bun into the plugin's data folder and answers where it is. Rejects with a
 * SetupError, having left nothing behind that could run, when any step does not come out as expected.
 * One session at a time: a lock folder (made in one step, so two sessions cannot both make it)
 * keeps a second from putting a copy in place over, or inside, the first's.
 */
export async function install($: EngineInterface, data: string, pin: Pin = BUN): Promise<{ path: string; version: string; bytes: number; isNew: boolean }> {
  const platform = await platformOf($)
  const asset = platform === undefined ? undefined : pin.assets[platform]
  if (!asset) throw new SetupError('This mod fetches a runtime only on macOS and Linux (arm64 or x64). Install Node from https://nodejs.org or Bun from https://bun.sh instead, then start a new session.')
  const have = (await fetched($, data)).find((copy) => copy.version === pin.version)
  if (have) return { ...have, bytes: 0, isNew: false }

  const now = await $.clock.now()
  const lock = `${folder(data)}/.lock`
  if (!(await run($, ['mkdir', '-p', folder(data)])).ok) throw new SetupError(`The plugin's data folder could not be written (${folder(data)}).`)
  if (!(await run($, ['mkdir', lock])).ok) {
    const at = await $.fs.stat(lock).then((stat) => stat.mtimeMs, () => 0)
    if (now - at < LOCK_MS) throw new SetupError('Another Claude Code session is setting up this runtime right now. Wait for it to finish, then run /mcp-skills setup again if this session still needs it.')
    // Left behind by a session that ended under it.
    if (!(await erase($, lock)) || !(await run($, ['mkdir', lock])).ok) throw new SetupError('Another session is setting up this runtime right now. Try again in a few minutes.')
  }
  try {
    return await installLocked($, data, pin, asset, now)
  } finally {
    await run($, ['rm', '-rf', lock])
  }
}

async function installLocked($: EngineInterface, data: string, pin: Pin, asset: { name: string; sha256: string }, now: number) {
  const home = `${folder(data)}/bun-${pin.version}`
  // Another session may have put it in place while this one waited for the lock.
  const have = (await fetched($, data)).find((copy) => copy.version === pin.version)
  if (have) return { ...have, bytes: 0, isNew: false }
  // What a fetch that was cut short (the session ended under it) left behind.
  for (const entry of await $.fs.list(folder(data)).catch(() => [])) {
    if (/^incoming-[\w-]+$/.test(entry.name)) await erase($, `${folder(data)}/${entry.name}`)
  }
  const work = `${folder(data)}/incoming-${now}-${Math.random().toString(36).slice(2, 10)}`
  const zip = `${work}/${asset.name}.zip`
  let unpacked: { size: number } | undefined
  try {
    const made = await run($, ['mkdir', '-p', work])
    if (!made.ok) throw new SetupError(`The folder for the download could not be made (${brief(made.stderr)}).`)
    // Only https, also after a redirect (GitHub hands a release file on to its own storage host).
    const got = await run($, ['curl', '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '570', '--max-filesize', String(LIMIT), '--output', zip, `${pin.base}${asset.name}.zip`], 600_000)
    if (got.isMissing) throw new SetupError('`curl` is needed for the download and was not found. Install Node from https://nodejs.org or Bun from https://bun.sh instead, then start a new session.')
    if (!got.ok) throw new SetupError(`The download did not finish (${brief(got.stderr) || 'curl failed'}). Nothing was installed; run /mcp-skills setup to try again.`)
    const { size, kind, isLink } = await $.fs.stat(zip)
    if (kind !== 'file' || isLink || size <= 0 || size > LIMIT) throw new SetupError('What was downloaded is not the archive that was asked for. Nothing was installed.')
    const sum = await sha256Of($, zip, size)
    if (sum !== asset.sha256) throw new SetupError(`The download does not match the checksum pinned in this mod for Bun ${pin.version} (${asset.name}.zip), so nothing of it was run. If this repeats, please report it.`)
    // One named file out of the archive, with its path dropped: nothing in it chooses where it lands.
    const out = await run($, ['unzip', '-q', '-o', '-j', zip, `${asset.name}/bun`, '-d', `${work}/bun-${pin.version}`], 120_000)
    if (out.isMissing) throw new SetupError('`unzip` is needed to unpack the download and was not found. Install it, or install Node or Bun yourself, then run /mcp-skills setup again.')
    if (!out.ok) throw new SetupError(`The download could not be unpacked (${brief(out.stderr) || 'unzip failed'}). Nothing was installed.`)
    const bin = `${work}/bun-${pin.version}/bun`
    const stat = await $.fs.stat(bin).catch(() => undefined)
    if (!stat || stat.kind !== 'file' || stat.isLink) throw new SetupError('The archive did not hold the program expected. Nothing was installed.')
    if (!(await run($, ['chmod', '755', bin])).ok) throw new SetupError('The unpacked program could not be made runnable. Nothing was installed.')
    const probe = await run($, [bin, '--version'])
    const says = probe.stdout.trim()
    if (!probe.ok || says !== pin.version) throw new SetupError(`The downloaded Bun did not start on this machine${says ? ` (it answered ${brief(says)})` : ''}. Nothing was installed.`)
    // A folder of this version that does not hold a copy that runs (cut short, damaged) is replaced.
    if ((await $.fs.exists(home).catch(() => false)) && !(await erase($, home))) throw new SetupError(`A damaged earlier copy could not be deleted (${home}). Delete that folder, then run /mcp-skills setup again.`)
    const moved = await run($, ['mv', `${work}/bun-${pin.version}`, home])
    if (!moved.ok) throw new SetupError(`The runtime could not be put in place (${brief(moved.stderr)}).`)
    unpacked = stat
  } catch (error) {
    const isGone = await erase($, work)
    const why = error instanceof SetupError ? error.message : `The setup failed (${brief(error instanceof Error ? error.message : String(error))}).`
    throw new SetupError(isGone ? `${why} The download was deleted.` : `${why} Its folder could not be deleted, and nothing in it is left runnable: ${work}`)
  }
  await erase($, work)
  const placed = (await fetched($, data)).find((copy) => copy.version === pin.version)
  if (!placed) throw new SetupError('The runtime was put in place but does not start from there. Run /mcp-skills setup remove, then /mcp-skills setup again.')
  // Copies of earlier versions are no longer needed.
  for (const old of await fetched($, data)) {
    if (old.version !== pin.version) await erase($, old.path.slice(0, -'/bun'.length))
  }
  return { ...placed, bytes: unpacked.size, isNew: true }
}

/** Deletes every copy this mod fetched. Answers how many were deleted, and the paths that could not be. */
export async function remove($: EngineInterface, data: string): Promise<{ removed: number; left: string[] }> {
  const entries = (await $.fs.list(folder(data)).catch(() => [])).filter((entry) => /^(bun-\d+\.\d+\.\d+|incoming-[\w-]+)$/.test(entry.name))
  let removed = 0
  const left: string[] = []
  for (const entry of entries) {
    const path = `${folder(data)}/${entry.name}`
    if (await erase($, path)) removed += entry.name.startsWith('bun-') ? 1 : 0
    else left.push(path)
  }
  return { removed, left }
}
