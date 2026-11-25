// For the Antigravity forms' tests: a temporary HOME (never the person's own
// ~/.gemini), the built server on stdio as Antigravity runs a plugin's MCP
// server, and its hook run as Antigravity runs a plugin's command hook (stdin
// JSON in, stdout JSON out, exit code read). The MCP client and the local web
// are the Codex form's (../../codex/test/harness.ts).

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after } from 'node:test'
import { startServer } from '../../codex/test/harness'

export { localWeb, sleep } from '../../codex/test/harness'

/** A HOME of its own for one test, removed when the test file ends. */
export function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'antigravity-polyfill-test-'))
  after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** The server as Antigravity starts a plugin's server: node, stdio, the plugin's HOME. */
export function antigravityServer(serverFile: string, home: string, env: Record<string, string> = {}) {
  // Antigravity documents no MCP elicitation: the client offers none.
  const s = startServer(serverFile, { env: { HOME: home, ...env }, elicitation: false, protocol: '2025-11-25' })
  after(() => s.stop())
  return s
}

export type HookRun = { status: number | null; out: Record<string, any>; stderr: string }

/**
 * The hook as Antigravity runs it: `node ./dist/server.mjs --hook` with the
 * plugin folder as its working directory, the PreToolUse input on stdin.
 */
export function runHook(serverFile: string, home: string, input: Record<string, unknown>, env: Record<string, string> = {}): HookRun {
  const r = spawnSync(process.execPath, ['./dist/server.mjs', '--hook'], {
    cwd: dirname(dirname(serverFile)),
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: home, ...env },
    timeout: 30_000,
  })
  let out: Record<string, any> = {}
  try {
    out = JSON.parse(r.stdout)
  } catch {}
  return { status: r.status, out, stderr: r.stderr }
}

/** A PreToolUse input, as hooks.md shows one. */
export const preToolUse = (name: string, args: Record<string, unknown>, conversationId = 'ec33ebf9-0cba-4100-8142-c61503f6c587') => ({
  hookEventName: 'PreToolUse',
  toolCall: { name, args },
  stepIdx: 3,
  conversationId,
  workspacePaths: ['/workspace/project'],
  transcriptPath: `~/.gemini/antigravity/brain/${conversationId}/.system_generated/logs/transcript.jsonl`,
  artifactDirectoryPath: `~/.gemini/antigravity/brain/${conversationId}`,
  modelName: 'gemini-test',
  lastUserInput: 'add it',
})

/**
 * Antigravity's matcher, as hooks.md describes it: a regular expression that
 * must match the whole tool name ("run_command" matches exactly run_command).
 */
export const matches = (matcher: string, name: string) => matcher === '' || matcher === '*' || new RegExp(`^(?:${matcher})$`).test(name)
