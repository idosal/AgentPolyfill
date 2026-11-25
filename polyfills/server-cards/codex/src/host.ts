// What the shared modules need from Codex: its name, the protocol revisions it
// negotiates, the network, a store and the codex command.

import { appendFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { host } from '../../claude-code/mod/hooks/configure'
import type { Store } from '../../claude-code/mod/hooks/http'
import { codexRunner } from './codex'
import { nodeFetch } from './fetch'
import type { SessionDeps } from './tools'

/**
 * Protocol revisions Codex 0.170.0 negotiates as an MCP client: it asks for
 * 2025-06-18 in `initialize`, and its rmcp
 * client accepts the revisions before it. 2026-07-28 is behind the
 * `mcp_2026_07_28` feature, under development and off.
 */
export const CODEX_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

export const useCodexHost = () => {
  host.name = 'Codex'
  host.protocolVersions = CODEX_PROTOCOL_VERSIONS
}

/** The cache, for this server process (one Codex session): at most 40 entries, as the store the shared cache expects. */
export const memoryStore = (): Store => {
  const mem = new Map<string, unknown>()
  return {
    get: async k => mem.get(k),
    set: async (k, v) => void mem.set(k, JSON.parse(JSON.stringify(v))),
    delete: async k => void mem.delete(k),
    keys: async () => [...mem.keys()],
  }
}

export const codexDeps = (env: NodeJS.ProcessEnv = process.env, userAgent = 'agentpolyfill-codex'): SessionDeps => ({
  fetch: nodeFetch({ userAgent }),
  store: memoryStore(),
  now: () => Date.now(),
  run: codexRunner(env),
  env,
})

/** True when this module is the program node started. */
export const isMain = (url: string) => {
  try {
    return !!process.argv[1] && realpathSync(fileURLToPath(url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

/** Lines to stderr; with MCP_SERVER_CARDS_LOG (a file path, for development) to that file too. */
export const logger = (name: string, env: NodeJS.ProcessEnv, file = env.MCP_SERVER_CARDS_LOG) => (line: string) => {
  const text = `${new Date().toISOString()} [${name}] ${line}\n`
  process.stderr.write(text)
  if (file)
    try {
      appendFileSync(file, text)
    } catch {}
}
