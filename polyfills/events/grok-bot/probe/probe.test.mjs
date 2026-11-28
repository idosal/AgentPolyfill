import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createProbe } from './probe.mjs';
import { destination } from '../src/routine.mjs';

test('an authenticated connector can read the batch carried by the wake and return an independent receipt', async t => {
    const token = randomBytes(32).toString('hex');
    const logs = [];
    const { batch, server } = createProbe({ token, origin: 'https://probe.example', log: line => logs.push(JSON.parse(line)) });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = new URL('http://127.0.0.1:' + server.address().port + '/mcp');
    const headers = { authorization: 'Bearer ' + token };
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://other.example' } })).status, 403);
    assert.equal((await fetch(new URL('/hooks/test', url), { headers })).status, 404);
    assert.equal((await fetch(url, { headers })).status, 405);

    let wake;
    await destination({ GROK_ROUTINE_URL: 'https://routine.example/test', GROK_ROUTINE_KEY: 'test' },
        async (_url, request) => { wake = JSON.parse(request.body); return new Response(null, { status: 200 }); }).send(batch);
    assert.deepEqual(wake, { source: 'mcp-events', batch });
    const client = new Client({ name: 'probe-test', version: '1' });
    try {
        await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
        assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['read_batch']);
        assert.equal((await client.callTool({ name: 'read_batch', arguments: { batch: '0'.repeat(32) + '.e1-e1' } })).isError, true);
        assert.equal(logs.length, 0);
        const result = await client.callTool({ name: 'read_batch', arguments: { batch: wake.batch } });
        const payload = JSON.parse(result.content[0].text);
        assert.equal(payload.batch, batch);
        assert.match(payload.receipt, /^[a-f0-9]{32}$/);
        assert.equal(logs.length, 1);
        assert.equal(logs[0].receipt, payload.receipt);
        assert.equal(logs[0].stage, 'read_batch');
        assert.ok(!JSON.stringify(wake).includes(payload.receipt));
    } finally { await client.close(); }
});
