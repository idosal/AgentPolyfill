// What the shared modules need from Copilot: its name, the protocol revisions it negotiates, the
// network, a store and the copilot command.

import { host, HOST_PROTOCOL_VERSIONS } from '../../claude-code/mod/hooks/configure'
import { nodeFetch } from '../../codex/src/fetch'
import { memoryStore } from '../../codex/src/host'
import type { SessionDeps } from '../../codex/src/tools'
import { copilotRunner } from './copilot'

/**
 * Copilot CLI 1.0.115 opens with `server/discover` at 2026-07-28 and falls back to `initialize`
 * at 2025-11-25. The older revisions are the ones its MCP client still
 * accepts, as Claude Code's does; only used to skip a remote that lists none of them.
 */
export const COPILOT_PROTOCOL_VERSIONS = HOST_PROTOCOL_VERSIONS

export const useCopilotHost = () => {
  host.name = 'Copilot'
  host.protocolVersions = COPILOT_PROTOCOL_VERSIONS
}

export const copilotDeps = (env: NodeJS.ProcessEnv = process.env, userAgent = 'agentpolyfill-copilot'): SessionDeps => ({
  fetch: nodeFetch({ userAgent }),
  store: memoryStore(),
  now: () => Date.now(),
  run: copilotRunner(env),
  env,
})
