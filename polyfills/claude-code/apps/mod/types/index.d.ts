/** JSON data, as $.state holds it. */
export type SavedJson = string | number | boolean | null | SavedJson[] | { [key: string]: SavedJson }

/**
 * A view as kept across a reload of the plugin's code ($.state, the session's):
 * enough to draw its header and open it again from its call (and its store).
 */
export type SavedView = {
  id: string
  server: string
  tool: string
  mode: 'cells' | 'image'
  /** Live when the code reloaded: it opens again as soon as it's in sight. */
  status: 'live' | 'closed'
  call?: {
    id: string
    server: string
    tool: string
    input?: { [key: string]: SavedJson }
    /** Left out when too big to keep (see saveViews). */
    result?: SavedJson
    cancelled?: string
    allowed?: boolean
    theme: string
  }
  alt?: string
  title?: string
  touched?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'mcp-apps-cli': { views: { version: 1; views: SavedView[] } }
  }
}
