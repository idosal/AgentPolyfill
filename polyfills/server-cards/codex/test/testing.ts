// `claude-code/testing` for node:test: the `test` and the two matchers the
// shared rule tests use. toEqual, like the Claude Code kit's, ignores object
// properties whose value is undefined.

import assert from 'node:assert/strict'
export { test } from 'node:test'

const strip = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(strip)
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype)
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, strip(x)]))
  return v
}

export const expect = (actual: unknown) => ({
  toBe: (expected: unknown) => assert.ok(Object.is(actual, expected), `expected ${JSON.stringify(actual)} to be ${JSON.stringify(expected)}`),
  toEqual: (expected: unknown) => assert.deepStrictEqual(strip(actual), strip(expected)),
})
