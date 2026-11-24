// The values this mod keeps in $.state: the servers its picker offers under a
// discover_mcp_servers or search_mcp_servers result, by that call's id.

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export type PickState = 'ready' | 'needs-input' | 'adding' | 'added' | 'failed'

export type Pick = {
  /** identifier#remote */
  id: string
  title: string
  /** the URL the server connects to, as the result showed it */
  url: string
  transport: string
  /** the server name it would be added under (a free one is chosen at the press if this is taken) */
  name: string
  /** the headers it would send, as "Name: value"; secrets as ${MCP_…} references */
  headers: string[]
  /** who stands behind it, as one line */
  trust: string
  /** true: confirmed by its publisher; false: not; null: found on the publisher's own domain */
  isConfirmed: boolean | null
  /** the Server Card, as shown */
  card: Json
  remote: number
  fromLocal: boolean
  provenance: string
  state: PickState
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'mcp-server-cards': { picks: Record<string, Pick[]> }
  }
}
