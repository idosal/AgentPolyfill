// The rule for asking a rate limiter, on its own (it needs no Workers runtime).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowed, networkKey, senderKey, WORKERS_SENDER } from '../src/limits.ts';

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

test('with limits required, a missing or broken limiter refuses the request', async () => {
    assert.equal(await allowed(undefined, 'k', true), 'down');
    assert.equal(await allowed(broken, 'k', true), 'down');
});

test('a sender is an IPv4 address, or an IPv6 /64: every address in one /64 is one sender', () => {
    assert.equal(senderKey('203.0.113.9'), '203.0.113.9');
    assert.equal(senderKey('::ffff:203.0.113.9'), '203.0.113.9', 'IPv4 written as IPv6 is the IPv4 address');
    const one = senderKey('2001:db8:1:2::1');
    for (const ip of ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:0DB8:0001:0002:0:0:0:9', '[2001:db8:1:2::5]']) assert.equal(senderKey(ip), one, ip);
    assert.notEqual(senderKey('2001:db8:1:3::1'), one, 'the next /64 is another sender');
    assert.equal(senderKey('2a06:98c0:3600::103'), WORKERS_SENDER);
    assert.equal(senderKey(''), 'unknown');
});

test("a sender's network, for the ceiling on new mailboxes: an IPv6 address's /48, an IPv4 address itself", () => {
    assert.equal(networkKey('2001:db8:a:1::1'), '2001:db8:a::/48');
    assert.equal(networkKey('2001:db8:a:ffff:1:2:3:4'), '2001:db8:a::/48');
    assert.equal(networkKey('2001:0db8:000a:0001:0000:0000:0000:0001'), '2001:db8:a::/48');
    assert.notEqual(networkKey('2001:db8:b:1::1'), networkKey('2001:db8:a:1::1'));
    assert.equal(networkKey('198.51.100.7'), '198.51.100.7');
    assert.equal(networkKey('::ffff:198.51.100.7'), '198.51.100.7');
    assert.equal(networkKey('unknown'), 'unknown');
});
