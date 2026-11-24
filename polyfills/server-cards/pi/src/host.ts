import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { host } from '../../claude-code/mod/hooks/configure'
import { memoryStore } from '../../codex/src/host'
import { nodeFetch } from '../../codex/src/fetch'
import { runningPiCli, type PiAPI } from './pi'
import { Session, shownText, type SessionDeps, type Tool } from './tools'

// Pi 1.6.0's pi-mcp protocol/types.js. The RPC tests also inspect initialize.
export const PI_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
export function usePiHost() {
  host.name = 'Pi'
  host.protocolVersions = PI_PROTOCOL_VERSIONS
}
export const piDeps = (pi: PiAPI, env: NodeJS.ProcessEnv = process.env): SessionDeps => ({
  pi, env, cli: runningPiCli(), store: memoryStore(), now: () => Date.now(),
  fetch: nodeFetch({ userAgent: 'AgentPolyfill/0.1.0 (Pi)' }),
})

export function install(pi: ExtensionAPI, disabled: string, makeTools: (session: Session) => Tool[], env = process.env) {
  if (/^(1|true|on|yes)$/i.test(env[disabled] ?? '')) return
  usePiHost()
  let session = new Session(piDeps(pi, env))
  let tools = makeTools(session)
  pi.on('session_start', () => {
    // A new, resumed or forked session must show its own cards before adding.
    session = new Session(piDeps(pi, env))
    tools = makeTools(session)
  })
  for (const spec of tools) {
    pi.registerTool({
      name: spec.name,
      label: spec.name === 'add_mcp_server' ? 'Add MCP server' : spec.name === 'ard_search' ? 'Search ARD registry' : 'Discover MCP servers',
      description: spec.description,
      parameters: spec.inputSchema as never, // Pi accepts a plain JSON Schema.
      annotations: spec.annotations,
      executionMode: 'sequential',
      async execute(_id, params, signal, _onUpdate, ctx) {
        try {
          if (signal?.aborted) return { content: [{ type: 'text', text: 'The tool call was cancelled.' }], details: {}, isError: true }
          const r = await tools.find(t => t.name === spec.name)!.run(params as Record<string, unknown>, ctx, signal)
          return { content: [{ type: 'text', text: shownText(r.text) }], details: {}, ...(r.isError ? { isError: true } : {}) }
        } catch {
          return { content: [{ type: 'text', text: 'The request could not finish. No configuration was intentionally replaced; check Pi before retrying an addition.' }], details: {}, isError: true }
        }
      },
    })
  }
}
