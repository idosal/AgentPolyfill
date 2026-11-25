// The session's wake count across processes: one that takes over a session's
// watches (the first window closed) carries on from the count and the pause the
// first one saved, not from what it read when it opened.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PiSession } from '../src/session.ts';
import { temp } from './pi-rpc.ts';

test('a process that takes over the watches inherits the saved pause', async () => {
    const base = temp('mcp-events-session-');
    const make = () => new PiSession('takeover-session', { base, connections: new Map(), unavailable: () => [], send: () => {}, log: () => {}, env: { MCP_EVENTS_WAKES_PER_HOUR: '1', MCP_EVENTS_WAKE_GAP_S: '0' } });
    // The standby opens first, and reads an empty count.
    const standby = make();
    const first = make();
    assert.equal(first.start(), true);
    first.budget.woke(['w-1']);
    first.budget.pause();
    await first.stop();
    // The standby takes over: past the hour's wakes, and paused until the user writes.
    assert.equal(standby.start(), true);
    assert.equal(standby.budget.paused, true);
    assert.equal(standby.budget.gate(['w-1']).kind, 'paused');
    await standby.stop();
});
