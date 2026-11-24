// The rule for asking a rate limiter, on its own (it needs no Workers runtime).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowed, senderKey } from '../src/limits.ts';

const answers = (success: boolean) => ({ limit: async () => ({ success }) });
const broken = { limit: async () => { throw new Error('the limiter is down'); } };

test('a limiter that answers is believed', async () => {
    assert.equal(await allowed(answers(true), 'k', true), 'yes');
    assert.equal(await allowed(answers(false), 'k', false), 'no');
});

test('with no limits required, a missing or broken limiter lets the request through', async () => {
    assert.equal(await allowed(undefined, 'k', false), 'yes');
    assert.equal(await allowed(broken, 'k', false), 'yes');
});

test('a sender is counted by its IPv4 address, or by the /64 its IPv6 address is in', () => {
    assert.equal(senderKey('203.0.113.9'), '203.0.113.9');
    assert.equal(senderKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
    assert.equal(senderKey('2001:DB8:1:2:ffff:ffff:ffff:9'), '2001:db8:1:2::/64', 'any address in the /64, any case');
    assert.notEqual(senderKey('2001:db8:1:3::1'), senderKey('2001:db8:1:2::1'), 'another /64 is another sender');
    assert.equal(senderKey('::ffff:203.0.113.9'), '203.0.113.9', 'an IPv4-mapped address is its IPv4 address');
    assert.equal(senderKey('0:0:0:0:0:ffff:192.0.2.1'), '192.0.2.1');
    assert.equal(senderKey(null), 'unknown');
});

test('with limits required, a missing or broken limiter refuses the request', async () => {
    assert.equal(await allowed(undefined, 'k', true), 'down');
    assert.equal(await allowed(broken, 'k', true), 'down');
});
