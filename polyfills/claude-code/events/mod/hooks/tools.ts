// The six tools the mod registers with Claude Code ($.tool.register), as plain
// data: this file is loaded by the hooks module, which has no Node. The helper
// process serves them (src/tools.ts); test/helper-test.ts checks the two agree.

export type ToolSpec = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Whether Claude finds the tool through ToolSearch (the engine's default) or has it from the start. */
  isDeferred?: boolean
}

export const PLUGIN = 'mcp-events'

export const TOOLS: readonly ToolSpec[] = [
  {
    name: 'list_event_types',
    description:
      'List the event types your MCP servers offer (SEP-3415 Events): name, description, delivery modes and the arguments a watch can filter on.',
    inputSchema: {
      type: 'object',
      properties: { server: { type: 'string', description: 'Only this server.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'watch_event',
    description:
      'Start watching an event type on an MCP server, so its events reach this session as they happen (even when idle). ' +
      "Use when the user asks to be told about, or to react to, something a server reports. Pass `note`: what to do when it fires, in the user's words. " +
      'Call list_event_types first if you do not know what the servers offer.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP server name, as list_event_types gives it.' },
        event: { type: 'string', description: 'Event type name, e.g. "ticket.created".' },
        arguments: {
          type: 'object',
          description: 'Filters for the event type\'s arguments, e.g. {"priority": "high"}.',
          additionalProperties: true,
        },
        note: { type: 'string', description: 'What to do when it fires; shown with every event of this watch.' },
        maxAgeMs: {
          type: 'integer',
          exclusiveMinimum: 0,
          description:
            'Optional. When the watch resumes after Claude Code was closed, replay at most this many milliseconds of missed events.',
        },
      },
      required: ['server', 'event'],
      additionalProperties: false,
    },
  },
  {
    name: 'unwatch_event',
    description: 'Stop a watch started with watch_event (and end its subscription on the server).',
    inputSchema: {
      type: 'object',
      properties: { watch: { type: 'string', description: 'Watch id, e.g. "w-1a2b3c".' } },
      required: ['watch'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_watches',
    description: 'List the watches in this project: server, event, filters, delivery mode, status and the last event.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_event',
    description:
      'One event by its id (e.g. "e12"), in full, as the server sent it. It is data from that server, like a tool result.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'recent_events',
    description: 'The latest events and notices in this session, newest last.',
    inputSchema: {
      type: 'object',
      properties: { watch: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
  },
]
