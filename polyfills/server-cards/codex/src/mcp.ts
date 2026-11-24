// A small MCP server over stdio (newline-delimited JSON-RPC 2.0): initialize,
// ping, tools/list, tools/call, and one request of its own, elicitation/create,
// which asks the person a question through the client. No SDK, so the plugin
// carries no third-party code.

import type { Readable, Writable } from 'node:stream'

/** Revisions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

export type Elicited = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }

export type CallContext = {
  /** The client said it can show a form (MCP elicitation, form mode). */
  canElicit: boolean
  /** Ask the person, through the client's form. Rejects if the client fails. */
  elicit: (message: string, requestedSchema: Record<string, unknown>) => Promise<Elicited>
  /** The call's `_meta`, as the client sent it. */
  meta: Record<string, unknown>
  /** The protocol revision negotiated with the client. */
  protocol: string
}

export type ToolResult = { text: string; isError?: boolean }

export type Tool = {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
  run: (args: Record<string, unknown>, ctx: CallContext) => Promise<ToolResult>
}

export type ServerOptions = {
  name: string
  version: string
  instructions?: string
  tools: Tool[]
  input?: Readable
  output?: Writable
  /** How long a question to the person may stay open. */
  elicitTimeoutMs?: number
  log?: (line: string) => void
}

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any; result?: any; error?: any }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Whether the client's capabilities include form-mode elicitation. */
export const offersForm = (caps: unknown): boolean => {
  if (!isObject(caps) || !isObject(caps.elicitation)) return false
  const e = caps.elicitation
  // 2025-11-25: { form: {}, url: {} }; an empty object means form, as in earlier revisions.
  return Object.keys(e).length === 0 || isObject(e.form) || (e.form === undefined && e.url === undefined)
}

export function serve(opts: ServerOptions) {
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  const log = opts.log ?? (() => {})
  const tools = new Map(opts.tools.map(t => [t.name, t]))
  let clientCaps: unknown = undefined
  let protocol = PROTOCOL_VERSIONS[0]!
  let nextId = 1
  const pending = new Map<string | number, { resolve: (m: Message) => void; timer: NodeJS.Timeout }>()

  const send = (m: Message) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
  const reply = (id: Message['id'], result: unknown) => send({ id, result })
  const fail = (id: Message['id'], code: number, message: string) => send({ id, error: { code, message } })

  const request = (method: string, params: unknown, timeoutMs: number) =>
    new Promise<Message>((resolve, reject) => {
      const id = `s${nextId++}`
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`no answer to ${method} within ${Math.round(timeoutMs / 1000)} s`))
      }, timeoutMs)
      pending.set(id, { resolve, timer })
      send({ id, method, params })
    })

  const elicit = async (message: string, requestedSchema: Record<string, unknown>): Promise<Elicited> => {
    // `mode` is a field from 2025-11-25 on; earlier revisions have form mode only.
    const params = { ...(protocol >= '2025-11-25' ? { mode: 'form' } : {}), message, requestedSchema }
    const m = await request('elicitation/create', params, opts.elicitTimeoutMs ?? 10 * 60_000)
    log(`elicitation answered: ${m.error ? 'error' : String(m.result?.action)}`)
    if (m.error) throw new Error(`the client could not ask: ${String(m.error.message ?? m.error.code)}`)
    const r = m.result
    const action = isObject(r) && (r.action === 'accept' || r.action === 'decline' || r.action === 'cancel') ? r.action : 'cancel'
    return { action, content: isObject(r) && isObject(r.content) ? r.content : undefined }
  }

  const handle = async (m: Message) => {
    // A response to a request of ours.
    if (m.method === undefined && m.id !== undefined && m.id !== null) {
      const p = pending.get(m.id)
      if (p) {
        clearTimeout(p.timer)
        pending.delete(m.id)
        p.resolve(m)
      }
      return
    }
    const isRequest = m.id !== undefined && m.id !== null
    switch (m.method) {
      case 'initialize': {
        clientCaps = m.params?.capabilities
        const asked = String(m.params?.protocolVersion ?? '')
        protocol = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0]!
        log(`initialize: client ${JSON.stringify(m.params?.clientInfo ?? {})} protocol ${asked}; elicitation ${JSON.stringify(isObject(clientCaps) ? clientCaps.elicitation : undefined)}`)
        return reply(m.id, {
          protocolVersion: protocol,
          capabilities: { tools: {} },
          serverInfo: { name: opts.name, version: opts.version },
          ...(opts.instructions ? { instructions: opts.instructions } : {}),
        })
      }
      case 'ping':
        return isRequest ? reply(m.id, {}) : undefined
      case 'tools/list':
        return reply(m.id, {
          tools: opts.tools.map(t => ({
            name: t.name,
            ...(t.title ? { title: t.title } : {}),
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.annotations ? { annotations: t.annotations } : {}),
          })),
        })
      case 'tools/call': {
        const tool = tools.get(String(m.params?.name ?? ''))
        if (!tool) return fail(m.id, -32602, `Unknown tool: ${String(m.params?.name ?? '')}`)
        const args = isObject(m.params?.arguments) ? m.params.arguments : {}
        const meta = isObject(m.params?._meta) ? m.params._meta : {}
        log(`tools/call ${tool.name}`)
        let result: ToolResult
        try {
          result = await tool.run(args, { canElicit: offersForm(clientCaps), elicit, meta, protocol })
        } catch (err) {
          result = { text: `${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true }
        }
        return reply(m.id, { content: [{ type: 'text', text: result.text }], isError: result.isError === true })
      }
      default:
        if (isRequest) return fail(m.id, -32601, `Method not found: ${String(m.method)}`)
        return // notifications: initialized, cancelled, roots changed and so on
    }
  }

  let buffer = ''
  input.setEncoding?.('utf8')
  input.on('data', (chunk: string) => {
    buffer += chunk
    let i: number
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim()
      buffer = buffer.slice(i + 1)
      if (!line) continue
      let m: Message
      try {
        m = JSON.parse(line)
      } catch {
        send({ id: null, error: { code: -32700, message: 'Parse error' } })
        continue
      }
      void handle(m).catch(err => log(`error: ${err instanceof Error ? err.stack : String(err)}`))
    }
  })
  input.on('end', () => {
    for (const p of pending.values()) clearTimeout(p.timer)
  })
  return { protocol: () => protocol }
}
