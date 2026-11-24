// Starts hookdeck/mcp-events-outpost-demo's MCP server against its own mock Outpost (test/mock-outpost.ts),
// offline, the way its end-to-end test does. Run with that checkout's tsx:
//   node <checkout>/node_modules/tsx/dist/cli.mjs launch-outpost.mts <checkout>
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2]!;
const { MockOutpost } = await import(pathToFileURL(join(root, 'test', 'mock-outpost.ts')).href);
const { createApp } = await import(pathToFileURL(join(root, 'src', 'server', 'app.ts')).href);
const outpost = new MockOutpost();
await outpost.start();
const HOUR = 3600 * 1000;
const app = createApp(
    { port: 0, tokens: new Map([['tok-alice', 'alice']]), outpost: { baseUrl: outpost.baseUrl, apiKey: outpost.apiKey }, defaultTtlMs: HOUR, maxTtlMs: 2 * HOUR, minTtlMs: 60 * 1000, tenantsFile: null, tenantPrefix: 'mcp_' },
    { log: (m: string) => console.error(`[outpost-demo] ${m}`) }
);
const port = await app.listen(0);
console.log(JSON.stringify({ mcp: `http://localhost:${port}/mcp`, store: `http://localhost:${port}` }));
