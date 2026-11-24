// The rule for asking a rate limiter, on its own (it needs no Workers runtime).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowed } from '../src/limits.ts';

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
