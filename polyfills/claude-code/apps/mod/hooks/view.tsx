// Client module for mcp-apps-cli: the input layer laid over one MCP App
// view's picture (an Image or a Raster drawn by the hooks module). It draws
// nothing itself, so the picture shows through, and sends the person's
// clicks and keys back to the hooks module.
//
// A post can replace an undelivered one in the same frame, so every post
// carries all events the hooks module has not acknowledged yet (`ack`
// arrives with the next props), and the hooks module skips any it has seen.

import type { ClientKeyEvent, ClientModule, ClientPointerEvent, JsonValue } from 'claude-code'

type Props = { id: string; v: number; ack: number; status: string }
type Pending = { seq: number; kind: 'pointer' | 'key' } & Record<string, unknown>
/** `cols`: the width last posted (-1: none yet). */
type Queue = { seq: number; ack: number; v: number; cols: number; events: Pending[] }
type State = { started: true }

const queues = new Map<string, Queue>()

const View: ClientModule<Props, State> = (props, surface) => {
  const { Box } = surface.elements

  let queue = queues.get(props.id)
  if (!queue) {
    queue = { seq: 0, ack: 0, v: -1, cols: -1, events: [] }
    queues.set(props.id, queue)
  }
  const q = queue
  q.ack = Math.max(q.ack, props.ack)
  q.v = props.v
  q.events = q.events.filter((event) => event.seq > q.ack)

  if (surface.state === undefined) {
    surface.setState({ started: true })
    // Pointer and key events are plain data; their optional fields are only
    // ever absent, never undefined, so the post is JSON as typed.
    const flush = () => {
      // One column spare: the terminal keeps its last column free.
      const cols = Math.max(0, surface.columns - 1)
      q.cols = cols
      surface.post({ id: props.id, v: q.v, ack: q.ack, cols, events: q.events } as unknown as JsonValue)
    }
    // Every post is a hook call: the timer posts only what's still owed, events
    // not yet acknowledged or a new width, not 16 times a second at rest.
    surface.every(60, () => {
      if (q.events.length > 0 || Math.max(0, surface.columns - 1) !== q.cols) flush()
    })
    surface.onPointer((event: ClientPointerEvent) => {
      const isHover = event.type === 'move' && !event.button
      if (isHover) {
        // Only the latest hover position matters.
        q.events = q.events.filter((e) => !(e.kind === 'pointer' && e.type === 'move' && !e.button))
      }
      if (event.type === 'enter' || event.type === 'leave') return
      q.events.push({ seq: ++q.seq, kind: 'pointer', ...event })
      // Moves with a button held all count (a drawing's path), but they go
      // with the next 60 ms post, not one post each: every post is a hook
      // call, and a drag's ate into how often Claude Code paints the picture.
      if (event.type === 'move' && event.button) return
      flush()
    })
    surface.onKey((event: ClientKeyEvent) => {
      q.events.push({ seq: ++q.seq, kind: 'key', ...event })
      flush()
    })
  }

  return Box({ width: surface.columns, height: surface.rows })
}

export default View
