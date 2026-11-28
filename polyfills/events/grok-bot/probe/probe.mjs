import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { batchFormat, probeTools } from './probe-tool.mjs';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { destination } from '../src/routine.mjs';

const digest = value => createHash('sha256').update(value).digest();

export function createProbe({ token, origin, log = console.log }) {
    if (!token || !/^[\x21-\x7e]{32,256}$/.test(token)) throw Error('Supply a random connector key of at least 32 characters.');
    if (!origin || !origin.startsWith('https://') || new URL(origin).origin !== origin)
        throw Error('Set the public HTTPS origin without a path or trailing slash.');
    const expected = digest('Bearer ' + token);
    const batch = randomBytes(16).toString('hex') + '.e1-e1';
    const receipt = randomBytes(16).toString('hex');
    const server = createServer(async (req, res) => {
        if (req.url !== '/mcp') return res.writeHead(404).end();
        if (req.headers.origin !== undefined && req.headers.origin !== origin) return res.writeHead(403).end();
        if (!timingSafeEqual(expected, digest(req.headers.authorization ?? '')))
            return res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
        if (req.method !== 'POST') return res.writeHead(405, { allow: 'POST' }).end();

        const mcp = probeTools(batch, receipt, req.headers['mcp-protocol-version'], log);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.once('close', () => { void mcp.close().catch(() => {}); });
        try {
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
        } catch {
            if (!res.headersSent) res.writeHead(500);
            res.end();
        }
    });
    return { batch, server };
}

async function main() {
    const [cmd, batch, ...extra] = process.argv.slice(2);
    if (cmd === 'wake' && batchFormat.test(batch) && !extra.length) {
        await destination(process.env).send(batch);
        console.log('Grok accepted the wake. Compare the routine report with the server read receipt.');
        return;
    }
    if (cmd !== 'serve' || batch !== undefined) throw Error('Use serve or wake BATCH.');
    const port = Number(process.env.PORT ?? 8787);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error('Invalid PORT.');
    const probe = createProbe({ token: process.env.GROK_PROBE_KEY, origin: process.env.GROK_PROBE_ORIGIN });
    probe.server.listen(port, '127.0.0.1', () => console.log('Ready. Test batch ' + probe.batch));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
