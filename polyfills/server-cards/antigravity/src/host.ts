// What the shared modules need from Antigravity: its name, the protocol
// revisions it negotiates, and the network. Kept apart from main.ts, which
// starts the server when it is the program node runs, so the ARD form can
// import this.

import { host } from '../../claude-code/mod/hooks/configure'
import type { Run } from '../../codex/src/codex'
import { nodeFetch } from '../../codex/src/fetch'
import { memoryStore } from '../../codex/src/host'
import type { SessionDeps } from '../../codex/src/tools'

/**
 * Protocol revisions Antigravity negotiates as an MCP client. Not documented
 * (unverified); its App advertises the MCP Apps extension under
 * `capabilities.extensions`, which needs 2025-11-25. Used only to skip a
 * remote whose card lists none of these.
 */
export const ANTIGRAVITY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

export const useAntigravityHost = () => {
  host.name = 'Antigravity'
  host.protocolVersions = ANTIGRAVITY_PROTOCOL_VERSIONS
}

/** Antigravity's form needs no command of the host's: a stand-in so the shared Deps type holds. */
const noRun: Run = async () => ({ failure: 'not used in the Antigravity form' })

export const antigravityDeps = (env: NodeJS.ProcessEnv, userAgent: string): SessionDeps => ({
  fetch: nodeFetch({ userAgent }),
  store: memoryStore(),
  now: () => Date.now(),
  run: noRun,
  env,
})
