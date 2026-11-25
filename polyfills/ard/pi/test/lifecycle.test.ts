import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import extension, { install, addTool } from '../src/index'
import { mockSession, context, addArgs } from '../../../server-cards/pi/test/harness'

test('stand-down: the actual factory registers nothing when disabled', () => {
  const old = process.env.ARD_DISCOVERY_DISABLED
  const names: string[] = []
  process.env.ARD_DISCOVERY_DISABLED = '1'
  try {
    extension({ registerTool: (tool: { name: string }) => names.push(tool.name), on: () => { throw new Error('disabled factory should do nothing') } } as unknown as ExtensionAPI)
    assert.deepEqual(names, [])
  } finally {
    if (old === undefined) delete process.env.ARD_DISCOVERY_DISABLED
    else process.env.ARD_DISCOVERY_DISABLED = old
  }
})

test('a session_start clears previously shown cards, including resume and fork', async () => {
  const s = mockSession(), c = context()
  const definitions: any[] = []
  const handlers: Record<string, () => void> = {}
  let current: typeof s.session | undefined
  const pi = { ...s.pi, registerTool: (tool: unknown) => definitions.push(tool), on: (event: string, handler: () => void) => { handlers[event] = handler } } as unknown as ExtensionAPI
  install(pi, 'ARD_DISCOVERY_DISABLED', session => {
    current = session
    return [addTool(session, 'ard_discover', 'ard_discover')]
  }, { PI_CODING_AGENT_DIR: s.dir })
  current!.discovered.set([...s.session.discovered.keys()][0]!, [...s.session.discovered.values()][0]!)
  assert.equal(current!.discovered.size, 1)
  handlers.session_start!()
  assert.equal(current!.discovered.size, 0)
  const result = await definitions[0].execute('id', addArgs, undefined, undefined, c.ctx)
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /was shown in this session/)
  assert.equal(c.questions.length, 0)
})
