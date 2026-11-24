// A Streamable HTTP front for the hand-written stdio fixtures (the Events and
// Skills fixture servers of the Claude Code forms), behind a bearer token.
//
// Each HTTP session (Mcp-Session-Id), and the stateless 2026-07-28 traffic, gets
// a fixture process of its own; a request is written to it and its answer sent
// back as JSON. Requests without `Authorization: Bearer <token>` get a 401. Every
// request is logged: its method, whether it carried the token, its session, and
// its `Mcp-*` routing headers. Nothing here shares code with the polyfills.
//
//   node http-fixture.ts <fixture.ts> <port|0> <log file>     (env: FIXTURE_TOKEN, and the fixture's own)
//
// With FIXTURE_OAUTH=1 there is no fixed token: the server is an OAuth-protected
// resource (RFC 9728) with its own small authorization server (RFC 8414, dynamic
// registration, PKCE), which approves every authorization request at once and
// issues tokens it then accepts. That stands in for a sign-in the host does.
//
// Prints `listening <port>` when ready.

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [fixture, portArg, logFile] = process.argv.slice(2);
if (!fixture || !logFile) throw new Error('usage: http-fixture.ts <fixture.ts> <port> <log>');
const TOKEN = process.env.FIXTURE_TOKEN ?? '';
const OAUTH = process.env.FIXTURE_OAUTH === '1';
/** Tokens the authorization server issued. */
const issued = new Set<string>();
const codes = new Map<string, { challenge: string; redirect: string }>();
let base = '';

type Json = Record<string, unknown>;
type Child = { proc: ChildProcess; waiting: Map<string | number, (m: Json) => void>; buf: string };
const children = new Map<string, Child>();

const childFor = (key: string): Child => {
    let c = children.get(key);
    if (c) return c;
    const proc = spawn(process.execPath, ['--no-warnings', fixture], { stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
    c = { proc, waiting: new Map(), buf: '' };
    const child = c;
    proc.stdout!.on('data', (d: Buffer) => {
        child.buf += d.toString('utf8');
        let nl: number;
        while ((nl = child.buf.indexOf('\n')) >= 0) {
            const line = child.buf.slice(0, nl);
            child.buf = child.buf.slice(nl + 1);
            try {
                const m = JSON.parse(line) as Json;
                const id = m.id as string | number | undefined;
                if (id !== undefined && ('result' in m || 'error' in m)) {
                    child.waiting.get(id)?.(m);
                    child.waiting.delete(id);
                }
            } catch {
                // not a message
            }
        }
    });
    children.set(key, c);
    return c;
};

/** The authorization server and the resource's metadata. Answers what it serves; false for anything else. */
function oauth(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: string): boolean {
    const url = new URL(req.url ?? '/', base);
    const json = (status: number, v: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['mcp'] }), true;
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server') || url.pathname.startsWith('/.well-known/openid-configuration'))
        return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true, scopes_supported: ['mcp'] }), true;
    if (url.pathname === '/register' && req.method === 'POST') {
        const meta = JSON.parse(body || '{}') as Json;
        return json(201, { ...meta, client_id: `client-${randomBytes(4).toString('hex')}`, token_endpoint_auth_method: 'none' }), true;
    }
    if (url.pathname === '/authorize') {
        const redirect = url.searchParams.get('redirect_uri') ?? '';
        const code = randomBytes(8).toString('hex');
        codes.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', redirect });
        const to = new URL(redirect);
        to.searchParams.set('code', code);
        to.searchParams.set('state', url.searchParams.get('state') ?? '');
        to.searchParams.set('iss', base);
        res.writeHead(302, { location: to.toString() }).end();
        return true;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(body);
        if (form.get('grant_type') === 'authorization_code') {
            const c = codes.get(form.get('code') ?? '');
            const verifier = form.get('code_verifier') ?? '';
            if (!c || createHash('sha256').update(verifier).digest('base64url') !== c.challenge) return json(400, { error: 'invalid_grant' }), true;
            codes.delete(form.get('code')!);
        } else if (form.get('grant_type') !== 'refresh_token') return json(400, { error: 'unsupported_grant_type' }), true;
        const token = randomBytes(16).toString('hex');
        issued.add(token);
        return json(200, { access_token: token, token_type: 'Bearer', expires_in: 3600, refresh_token: randomBytes(16).toString('hex'), scope: 'mcp' }), true;
    }
    return false;
}

const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString('utf8')));
    req.on('end', () => {
        if (OAUTH && oauth(req, res, body)) return;
        if (req.method !== 'POST') {
            res.writeHead(405).end();
            return;
        }
        let m: Json;
        try {
            m = JSON.parse(body) as Json;
        } catch {
            res.writeHead(400).end();
            return;
        }
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        const auth = OAUTH ? bearer !== undefined && issued.has(bearer) : req.headers.authorization === `Bearer ${TOKEN}`;
        const p = (m.params ?? {}) as Json;
        const client = ((p.clientInfo as Json | undefined)?.name ?? ((p._meta as Json | undefined)?.['io.modelcontextprotocol/clientInfo'] as Json | undefined)?.name ?? null) as string | null;
        const routing = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith('mcp-') && k !== 'mcp-session-id'));
        let session = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
        appendFileSync(logFile, JSON.stringify({ t: Date.now(), method: m.method, auth, session: session ?? null, client, routing }) + '\n');
        if ((TOKEN || OAUTH) && !auth) {
            const challenge = OAUTH ? { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="mcp"` } : {};
            res.writeHead(401, { 'content-type': 'application/json', ...challenge }).end(JSON.stringify({ error: 'unauthorized' }));
            return;
        }
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (m.method === 'initialize') {
            session = randomUUID();
            headers['mcp-session-id'] = session;
        }
        const child = childFor(session ?? 'stateless');
        if (m.id === undefined) {
            child.proc.stdin!.write(JSON.stringify(m) + '\n');
            res.writeHead(202).end();
            return;
        }
        const timer = setTimeout(() => {
            child.waiting.delete(m.id as string | number);
            res.writeHead(504).end();
        }, 15_000);
        child.waiting.set(m.id as string | number, (answer) => {
            clearTimeout(timer);
            res.writeHead(200, headers).end(JSON.stringify(answer));
        });
        child.proc.stdin!.write(JSON.stringify(m) + '\n');
    });
});

server.listen(Number(portArg ?? 0), '127.0.0.1', () => {
    const a = server.address();
    const port = typeof a === 'object' && a ? a.port : 0;
    base = `http://127.0.0.1:${port}`;
    process.stdout.write(`listening ${port}\n`);
});
const stop = () => {
    for (const c of children.values()) c.proc.kill();
    process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
