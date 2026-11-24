#!/usr/bin/env node
// Puts every video and poster the site shows into public/media/, as listed in
// ../media.json. Paths in media.json are relative to the repository's root.
//
//   node scripts/media.mjs            before every build (npm run build does it):
//                                      - copies the recordings already in the
//                                        repository ("copy"), unchanged;
//                                      - makes the files derived from them
//                                        ("derived") if they are not there: the
//                                        Apps GIF as an MP4 (needs ffmpeg), and a
//                                        poster frame for each (committed);
//                                      - makes sure the launch video is there: a
//                                        local file whose SHA-256 matches, or a
//                                        download from the release asset named in
//                                        media.json, checked against that SHA-256.
//   node scripts/media.mjs --optional  the same, but a missing launch video is a
//                                      warning (npm run dev).
//   node scripts/media.mjs launch <master.mp4>
//                                      encodes a new launch video for the web
//                                      (H.264, 30 fps, faststart, no audio), its
//                                      poster and the clips cut from it, and
//                                      records its size, length and SHA-256 in
//                                      media.json. Then upload it as
//                                      the release asset (the command is printed).
//   node scripts/media.mjs derive      rebuilds the derived files (needs ffmpeg).
//   node scripts/media.mjs clips       cuts the clips of the launch video again,
//                                      with their posters, after their start and
//                                      end are changed in media.json.
//
// The launch video stays out of git: it is several MB and may be re-rendered.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

mkdirSync(out, { recursive: true })

const [command, ...rest] = process.argv.slice(2)

if (command === 'launch') await encodeLaunch(rest[0])
else if (command === 'derive') derive()
else if (command === 'clips') for (const clip of manifest.launch.clips ?? []) cutClip(clip, { poster: true })
else await prepare({ optional: command === '--optional' })

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

  if (!(await ensureLaunch(optional))) return
  for (const clip of manifest.launch.clips ?? []) {
    if (existsSync(join(out, clip.file))) continue
    if (!hasFfmpeg()) fail(`public/media/${clip.file} is missing, and cutting it from the launch video needs ffmpeg`)
    cutClip(clip, { poster: false })
  }
}

async function ensureLaunch(optional) {
  const launch = manifest.launch
  const target = join(out, launch.file)
  if (!existsSync(join(out, launch.poster))) fail(`public/media/${launch.poster} is missing; run node scripts/media.mjs launch <master.mp4>`)
  if (existsSync(target)) {
    const actual = sha256(target)
    if (launch.sha256 && actual !== launch.sha256) {
      console.warn(`media: public/media/${launch.file} does not match the SHA-256 in media.json; using the local file`)
    }
    return true
  }
  if (!launch.sha256) return missing(optional, 'media.json has no SHA-256 for it yet')
  try {
    console.log(`media: downloading ${launch.release}`)
    const response = await fetch(launch.release, { redirect: 'follow' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== launch.sha256) throw new Error(`SHA-256 ${actual} is not the one in media.json`)
    writeFileSync(`${target}.part`, bytes)
    renameSync(`${target}.part`, target)
    console.log(`media: ${launch.file}, ${mb(bytes.length)}, checked`)
    return true
  } catch (error) {
    return missing(optional, `the download failed (${error.message})`)
  }
}

function missing(optional, why) {
  const message = `the launch video public/media/${manifest.launch.file} is missing: ${why}. Encode it with "node scripts/media.mjs launch <master.mp4>", or upload the release asset named in media.json.`
  if (optional) console.warn(`media: ${message}`)
  else fail(message)
  return false
}

// A part of the launch video, shown on its own (the Server Cards card). Its
// start and end are seconds of the launch video, set in media.json; change
// them when the launch video is re-rendered.
function cutClip(clip, { poster }) {
  const source = join(out, manifest.launch.file)
  const target = join(out, clip.file)
  ffmpeg([
    '-ss', String(clip.start), '-to', String(clip.end), '-i', source, '-an',
    '-vf', 'scale=1280:-2:flags=lanczos,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-crf', '24', '-movflags', '+faststart', target,
  ])
  if (poster) {
    ffmpeg(['-ss', String(clip.start + clip.posterAt), '-i', source, '-frames:v', '1', '-vf', 'scale=960:-2:flags=lanczos', '-q:v', '4', join(out, clip.poster)])
  }
  console.log(`media: ${clip.file}, ${mb(statSync(target).size)}`)
}

async function encodeLaunch(input) {
  if (!input || !existsSync(input)) fail('usage: node scripts/media.mjs launch <master.mp4>')
  const launch = manifest.launch
  const target = join(out, launch.file)
  const poster = join(out, launch.poster)
  // Terminal footage at 1080p and 30 fps (enough for typing and pointer moves),
  // two-pass to a bitrate that lands the file near 9 MB whatever the length:
  // small enough for a home page, far under the 25 MiB a Workers asset may be.
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
  ffmpeg([...encode, '-pass', '2', '-movflags', '+faststart', `${target}.part.mp4`])
  renameSync(`${target}.part.mp4`, target)
  for (const suffix of ['-0.log', '-0.log.mbtree']) {
    try {
      execFileSync('rm', ['-f', join(out, `.launch-pass${suffix}`)])
    } catch {}
  }
  ffmpeg(['-ss', String(launch.posterAt), '-i', target, '-frames:v', '1', '-vf', 'scale=1280:-2:flags=lanczos', '-q:v', '4', poster])
  const info = probe(target)
  launch.width = info.streams[0].width
  launch.height = info.streams[0].height
  launch.seconds = Math.round(Number(info.format.duration) * 10) / 10
  launch.bytes = statSync(target).size
  launch.sha256 = sha256(target)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  for (const clip of launch.clips ?? []) cutClip(clip, { poster: true })
  const tag = new URL(launch.release).pathname.split('/').at(-2)
  console.log(`media: ${launch.file}, ${launch.width}x${launch.height}, ${launch.seconds} s, ${mb(launch.bytes)}`)
  console.log(`media: poster ${launch.poster} at ${launch.posterAt} s (change posterAt in media.json to pick another frame)`)
  console.log('media: media.json updated. For builds elsewhere, upload the file as the release asset:')
  console.log(`  gh release create ${tag} --repo idosal/AgentPolyfill --title "Site media" --notes "Media for the website" || true`)
  console.log(`  gh release upload ${tag} site/public/media/${launch.file} --repo idosal/AgentPolyfill --clobber`)
}

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function derive() {
  for (const item of manifest.derived) deriveOne(item)
}

function deriveOne(item) {
  const source = join(root, item.from)
  const target = join(out, item.file)
  if (item.kind === 'gif-to-mp4') {
    ffmpeg([
      '-i', source, '-an',
      '-vf', 'fps=12,scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-crf', '22', '-movflags', '+faststart', target,
    ])
  } else if (item.kind === 'poster') {
    ffmpeg(['-ss', String(item.at), '-i', source, '-frames:v', '1', '-vf', 'scale=960:-2:flags=lanczos', '-q:v', '4', target])
  }
  console.log(`media: ${item.file}, ${mb(statSync(target).size)}`)
}

function fail(message) {
  console.error(`media: ${message}`)
  process.exit(1)
}
