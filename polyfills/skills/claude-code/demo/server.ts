// A small MCP server that serves the skills in demo/skills over the MCP Skills
// extension (SEP-2640). Everything about the extension here is the official
// TypeScript SDK's own implementation (`@modelcontextprotocol/server/ext/skills`):
// the entries, digests, `skills/list`, `skills/get`, `resources/read` and
// `resources/directory/read`. None of it is this mod's code, which makes it a
// fair server to try the mod against.
//
//   (no PORT)      stdio
//   PORT           serve Streamable HTTP on 127.0.0.1:PORT/mcp
//   DEMO_TOKEN     with PORT: the bearer token clients must send (required)
//   DEMO_SKILLS    folder of skill folders (default: demo/skills beside this file)
//   DEMO_DELAY_MS  wait this long before serving (to try a server that is slow to start)

import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { loadSkills } from '@modelcontextprotocol/server/ext/skills/node';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const root = process.env.DEMO_SKILLS ?? fileURLToPath(new URL('./skills', import.meta.url));
const skills = await loadSkills(root, { cacheHint: { ttlMs: 60_000, cacheScope: 'private' } });

function build(): McpServer {
    const mcp = new McpServer({ name: 'acme-handbook', version: '1.0.0' });
    skills.attach(mcp);
    return mcp;
}

if (process.env.DEMO_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.DEMO_DELAY_MS)));
const port = process.env.PORT ? Number(process.env.PORT) : undefined;
if (port === undefined) {
    await serveStdio(build);
} else {
    const token = process.env.DEMO_TOKEN;
    if (!token) throw new Error('DEMO_TOKEN is required with PORT');
    const handler = createMcpHandler(build);
    const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
    createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        if (url.pathname !== '/mcp') return void res.writeHead(404).end();
        if (!same(req.headers.authorization ?? '', `Bearer ${token}`)) return void res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
        const response = await handler.fetch(new Request(url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined }));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) for await (const c of response.body) res.write(c);
        res.end();
    }).listen(port, '127.0.0.1', () => console.error(`acme-handbook: http://127.0.0.1:${port}/mcp`));
}
