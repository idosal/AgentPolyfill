import { timingSafeEqual, createHash } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { batchFormat, probeTools } from './probe-tool.mjs';

const hash = text => createHash('sha256').update(text).digest();

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname !== '/mcp' || url.search) return new Response(null, { status: 404 });
        const deadline = Date.parse(env.PROBE_EXPIRES_AT);
        if (!Number.isFinite(deadline) || Date.now() >= deadline) return new Response(null, { status: 410 });
        if (!env.GROK_PROBE_KEY || !batchFormat.test(env.PROBE_BATCH) || !/^[a-f0-9]{32}$/.test(env.PROBE_RECEIPT))
            return new Response(null, { status: 503 });
        const origin = request.headers.get('origin');
        if (origin !== null && origin !== url.origin) return new Response(null, { status: 403 });
        if (!timingSafeEqual(hash(request.headers.get('authorization') ?? ''), hash('Bearer ' + env.GROK_PROBE_KEY)))
            return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
        if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
        const mcp = probeTools(env.PROBE_BATCH, env.PROBE_RECEIPT, request.headers.get('mcp-protocol-version'), console.log);
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await mcp.connect(transport);
        try {
            return await transport.handleRequest(request);
        } finally {
            await mcp.close();
        }
    }
};
