#!/usr/bin/env node
// Puts every video and poster the site shows into public/media/, as listed in
// ../media.json.
//
// Two kinds of video:
//   - "launch" and "cuts": the launch video and one cut per polyfill, rendered
//     outside the repository. They
//     stay out of git. Each is recorded in media.json with its SHA-256; a build
//     uses the local file, or downloads it from the release named in
//     media.json ("release" + file name) and checks it. Their posters are
//     committed.
//   - "copy" and "derived": recordings already in the repository (paths
//     relative to its root), copied unchanged, with a poster frame each
//     (committed).
//
//   node scripts/media.mjs              before every build (npm run build does it)
//   node scripts/media.mjs --optional   the same, but a missing launch video or
//                                       cut is a warning (npm run dev; CI sets
//                                       SITE_MEDIA=optional for the same effect)
//   node scripts/media.mjs launch <master.mp4>
//                                       encodes the launch video for the web
//                                       (1080p, 30 fps, about 9 MB, no audio),
//                                       its poster, and records its size,
//                                       length and SHA-256 in media.json
//   node scripts/media.mjs cut <name> <master.mp4>
//                                       the same for one polyfill's cut (720p,
//                                       30 fps), e.g. cut events events.mp4
//   node scripts/media.mjs small <master.mp4>
//                                       encodes the launch video's 720p version,
//                                       which phones get (media.json launch.small)
//   node scripts/media.mjs posters      makes the posters again, after posterAt
//                                       is changed in media.json: a JPEG (for
//                                       link previews) and WebP at each width in
//                                       "webp" (public/media/p/, what pages show)
//   node scripts/media.mjs release      prints the commands that upload the
//                                       launch video and the cuts as release
//                                       assets, for builds on other machines
//   node scripts/media.mjs derive       rebuilds the derived files (needs ffmpeg)

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(site, '..')
const out = join(site, 'public', 'media')
const manifestPath = join(site, 'media.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`
const ffmpeg = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' })
const probe = (file) =>
  JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file], {
      encoding: 'utf8',
    }),
  )

// The launch video (and its 720p version) and the cuts.
const rendered = () => [
  { video: manifest.launch, label: 'the launch video' },
  ...(manifest.launch.small ? [{ video: manifest.launch.small, label: 'the launch video, 720p' }] : []),
  ...manifest.cuts.map((cut) => ({ video: cut, label: `the ${cut.name} cut` })),
]
// The videos that have posters.
const posted = () => [manifest.launch, ...manifest.cuts]

mkdirSync(out, { recursive: true })

const [command, ...rest] = process.argv.slice(2)

if (command === 'launch') encodeVideo(manifest.launch, rest[0], 'launch')
else if (command === 'cut') {
  const cut = manifest.cuts.find((c) => c.name === rest[0])
  if (!cut) fail(`usage: node scripts/media.mjs cut <${manifest.cuts.map((c) => c.name).join('|')}> <master.mp4>`)
  encodeVideo(cut, rest[1], 'cut')
} else if (command === 'small') encodeSmall(manifest.launch, rest[0])
else if (command === 'posters') for (const video of posted()) poster(video)
else if (command === 'release') printRelease()
else if (command === 'derive') for (const item of manifest.derived) deriveOne(item)
else await prepare({ optional: command === '--optional' || process.env.SITE_MEDIA === 'optional' })

async function prepare({ optional }) {
  for (const { file, from } of manifest.copy) {
    const source = join(root, from)
    const target = join(out, file)
    if (!existsSync(source)) fail(`${from} is missing; media.json lists it`)
    if (!existsSync(target) || statSync(target).size !== statSync(source).size) copyFileSync(source, target)
  }
  for (const item of manifest.derived) {
    if (existsSync(join(out, item.file))) continue
    if (!hasFfmpeg()) fail(`public/media/${item.file} is missing, and making it needs ffmpeg`)
    deriveOne(item)
  }
  for (const { video, label } of rendered()) await ensure(video, label, optional)
}

// A rendered video: the local file, or the release asset, checked against the
// SHA-256 in media.json.
async function ensure(video, label, optional) {
  const target = join(out, video.file)
  if (video.poster && !existsSync(join(out, video.poster))) fail(`public/media/${video.poster}, the poster of ${label}, is missing`)
  for (const width of video.webp ?? []) {
    if (!existsSync(webpPath(video, width))) fail(`${relative(site, webpPath(video, width))}, a poster of ${label}, is missing; run node scripts/media.mjs posters`)
  }
  if (existsSync(target)) {
    if (sha256(target) !== video.sha256) {
      console.warn(`media: public/media/${video.file} does not match the SHA-256 in media.json; using the local file`)
    }
    return
  }
  const url = new URL(video.file, manifest.release).href
  try {
    console.log(`media: downloading ${url}`)
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== video.sha256) throw new Error(`SHA-256 ${actual} is not the one in media.json`)
    writeFileSync(`${target}.part`, bytes)
    renameSync(`${target}.part`, target)
    console.log(`media: ${video.file}, ${mb(bytes.length)}, checked`)
  } catch (error) {
    const message = `${label}, public/media/${video.file}, is missing and the download failed (${error.message}). Encode it with node scripts/media.mjs (see its header), or upload the release asset.`
    if (optional) console.warn(`media: ${message}`)
    else fail(message)
  }
}

// Screen recordings of terminals, so 30 fps is enough for typing and pointer
// moves. The launch video is two-pass to a bitrate that lands it near 9 MB
// whatever its length; a cut is 720p at a constant quality (about 1 to 3 MB):
// the cards and guide pages show it at most about 700 px wide.
function encodeVideo(video, input, kind) {
  if (!input || !existsSync(input)) fail(`usage: node scripts/media.mjs ${kind === 'launch' ? 'launch' : `cut ${video.name}`} <master.mp4>`)
  const target = join(out, video.file)
  const part = `${target}.part.mp4`
  if (kind === 'launch') {
    const seconds = Number(probe(input).format.duration)
    const kbps = Math.min(2500, Math.floor((9 * 8 * 1024 * 1024) / seconds / 1000))
    const encode = [
      '-i', input, '-an',
      '-vf', 'scale=w=1920:h=1080:force_original_aspect_ratio=decrease:flags=lanczos,fps=30,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high',
      '-b:v', `${kbps}k`, '-maxrate', `${kbps * 2}k`, '-bufsize', `${kbps * 4}k`,
      '-passlogfile', join(out, '.launch-pass'),
    ]
    ffmpeg([...encode, '-pass', '1', '-f', 'mp4', '/dev/null'])
    ffmpeg([...encode, '-pass', '2', '-movflags', '+faststart', part])
    for (const suffix of ['-0.log', '-0.log.mbtree']) rmSync(join(out, `.launch-pass${suffix}`), { force: true })
  } else {
    ffmpeg([
      '-i', input, '-an',
      '-vf', 'scale=w=1280:h=720:force_original_aspect_ratio=decrease:flags=lanczos,fps=30,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-crf', '24', '-movflags', '+faststart', part,
    ])
  }
  renameSync(part, target)
  const info = probe(target)
  video.master = basename(input)
  video.width = info.streams[0].width
  video.height = info.streams[0].height
  video.seconds = Math.round(Number(info.format.duration) * 100) / 100
  video.bytes = statSync(target).size
  video.sha256 = sha256(target)
  poster(video)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`media: ${video.file}, ${video.width}x${video.height}, ${video.seconds} s, ${mb(video.bytes)}, from ${video.master}`)
  console.log(`media: poster ${video.poster} at ${video.posterAt} s (change posterAt in media.json, then node scripts/media.mjs posters)`)
  console.log('media: media.json updated. For builds on other machines: node scripts/media.mjs release')
}

// The launch video at 720p for small screens: the same cut, about a third of
// the bytes, so a phone on a slow network starts and keeps playing sooner.
function encodeSmall(launch, input) {
  if (!input || !existsSync(input)) fail('usage: node scripts/media.mjs small <master.mp4>')
  const small = (launch.small ??= { file: 'launch-720.mp4' })
  const target = join(out, small.file)
  ffmpeg([
    '-i', input, '-an',
    '-vf', 'scale=w=1280:h=720:force_original_aspect_ratio=decrease:flags=lanczos,fps=30,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-crf', '25', '-movflags', '+faststart', `${target}.part.mp4`,
  ])
  renameSync(`${target}.part.mp4`, target)
  const info = probe(target)
  small.width = info.streams[0].width
  small.height = info.streams[0].height
  small.seconds = Math.round(Number(info.format.duration) * 100) / 100
  small.bytes = statSync(target).size
  small.sha256 = sha256(target)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`media: ${small.file}, ${small.width}x${small.height}, ${mb(small.bytes)}`)
}

function webpPath(video, width) {
  return join(out, 'p', `${video.poster.replace(/\.jpg$/, '')}-${width}.webp`)
}

// A frame of the video as its poster: a JPEG at the video's own size (for link
// previews), and WebP at each width in video.webp, which the pages show with
// srcset. The frame is taken losslessly, then encoded once.
function poster(video) {
  const source = join(out, video.file)
  if (!existsSync(source)) fail(`public/media/${video.file} is missing, so its poster cannot be made`)
  ffmpeg(['-ss', String(video.posterAt), '-i', source, '-frames:v', '1', '-q:v', '3', join(out, video.poster)])
  if (!video.webp?.length) return
  mkdirSync(join(out, 'p'), { recursive: true })
  const frame = join(out, 'p', '.frame.png')
  ffmpeg(['-ss', String(video.posterAt), '-i', source, '-frames:v', '1', frame])
  for (const width of video.webp) {
    execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(width), '0', frame, '-o', webpPath(video, width)])
  }
  rmSync(frame, { force: true })
}

function printRelease() {
  const tag = new URL(manifest.release).pathname.split('/').filter(Boolean).at(-1)
  const files = rendered().map(({ video }) => `site/public/media/${video.file}`)
  console.log(`gh release create ${tag} --repo idosal/AgentPolyfill --prerelease --title "Site media" --notes "Videos for agentpolyfill.com, checked by SHA-256 in site/media.json" || true`)
  console.log(`gh release upload ${tag} ${files.join(' ')} --repo idosal/AgentPolyfill --clobber`)
}

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function deriveOne(item) {
  const source = join(root, item.from)
  const target = join(out, item.file)
  if (item.kind === 'poster') {
    // At the recording's own size, so the poster is as sharp as the video.
    ffmpeg(['-ss', String(item.at), '-i', source, '-frames:v', '1', '-q:v', '4', target])
  } else fail(`media.json: unknown kind ${item.kind}`)
  console.log(`media: ${item.file}, ${mb(statSync(target).size)}`)
}

function fail(message) {
  console.error(`media: ${message}`)
  process.exit(1)
}
