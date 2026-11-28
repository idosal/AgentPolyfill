#!/usr/bin/env node
// A Tasks server for the tests, over stdio, on protocol revision 2026-07-28, written by hand from the
// ext-tasks specification (it shares no code with the client). Each tool is one behaviour the client
// must handle. It records every request it gets in FIXTURE_LOG (one JSON line each).
//
//   echo            answers at once with a plain CallToolResult (no task); over HTTP it repeats the
//                   request's Authorization header, as a careless server might
//   ask2            a task that asks two questions, one after the other (keys k1, then k2)
//   slow            a task that completes after FIXTURE_TASK_MS
//   fail            a task that fails with a JSON-RPC error
//   ask             a task that asks for a name (input_required, an elicitation), then greets
//   confirm         a task that asks a question with an empty form, then reports the answer
//   sample          a task that asks for sampling, and waits
//   long            a task that only ends when cancelled
//   vanish          a task the server forgets after the first tasks/get (then -32602)
//   morph           tasks/get describes a different task than the one asked about
//   relapse         completes, then claims to be working again
//   bad_create      a CreateTaskResult with no taskId
//
// FIXTURE_LEGACY=1: a server on the 2025 revisions only (no server/discover), advertising the extension
// at initialize, where it isn't defined. FIXTURE_NO_TASKS=1: the extension isn't advertised. FIXTURE_OLD_FORM=1: only the 2025-11-25 form's
// top-level `tasks` capability is advertised.
//
// `--http <port file>`: serves Streamable HTTP on 127.0.0.1 (a port of its own, written to that file)
// instead of stdio, answering each POST with JSON, and records the `Mcp-Method`, `Mcp-Name`,
// `Authorization` and `X-Helper` headers each request came with.

import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const EXT = 'io.modelcontextprotocol/tasks';
const LOG = process.env.FIXTURE_LOG;
const TASK_MS = Number(process.env.FIXTURE_TASK_MS ?? 600);
const POLL_MS = Number(process.env.FIXTURE_POLL_MS ?? 200);
const tasks = new Map();
const now = () => new Date().toISOString();
let send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const log = (m, headers) => LOG && appendFileSync(LOG, JSON.stringify({ at: Date.now(), method: m.method, params: m.params, ...(headers ? { headers } : {}) }) + '\n');

const TOOLS = ['echo', 'slow', 'fail', 'ask', 'ask2', 'confirm', 'sample', 'long', 'vanish', 'morph', 'relapse', 'bad_create'].map((name) => ({ name, description: `fixture: ${name}`, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }));

function caps() {
    const c = { tools: {} };
    if (process.env.FIXTURE_OLD_FORM === '1') c.tasks = { list: {}, cancel: {}, requests: { tools: { call: {} } } };
    else if (process.env.FIXTURE_NO_TASKS !== '1') c.extensions = { [EXT]: {} };
    return c;
}

function declared(params) {
    const cc = params?._meta?.['io.modelcontextprotocol/clientCapabilities'];
    return !!cc?.extensions && EXT in cc.extensions;
}

function view(t) {
    const base = { taskId: t.id, status: t.status, createdAt: t.createdAt, lastUpdatedAt: t.lastUpdatedAt, ttlMs: 60000, pollIntervalMs: POLL_MS };
    if (t.statusMessage) base.statusMessage = t.statusMessage;
    if (t.status === 'input_required') base.inputRequests = t.inputRequests;
    if (t.status === 'completed') base.result = t.result;
    if (t.status === 'failed') base.error = t.error;
    return base;
}

function set(t, status, extra = {}) {
    Object.assign(t, { status, lastUpdatedAt: now() }, extra);
}

function create(tool, args) {
    const t = { id: randomBytes(16).toString('base64url'), tool, args, status: 'working', createdAt: now(), lastUpdatedAt: now(), gets: 0, keyN: 0 };
    tasks.set(t.id, t);
    const later = (fn) => setTimeout(fn, TASK_MS);
    if (tool === 'slow' || tool === 'relapse') later(() => set(t, 'completed', { result: { content: [{ type: 'text', text: `done: ${args.text ?? ''}` }], isError: false } }));
    if (tool === 'fail') later(() => set(t, 'failed', { error: { code: -32603, message: 'the fixture failed on purpose' }, statusMessage: 'it failed' }));
    if (tool === 'ask2') later(() => set(t, 'input_required', { inputRequests: { k1: { method: 'elicitation/create', params: { mode: 'form', message: 'First name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } } } }));
    if (tool === 'ask') later(() => {
        const field = { type: 'string', title: 'Your name' };
        if (process.env.FIXTURE_PATTERN_FORM === '1') field.pattern = '^[A-Z]+$';
        const requestedSchema = { type: 'object', properties: { name: field }, required: ['name'] };
        set(t, 'input_required', { inputRequests: { [`k${++t.keyN}`]: {
            method: 'elicitation/create', params: { mode: 'form', message: 'What is your name?', requestedSchema }
        } } });
    });
    if (tool === 'confirm') later(() => set(t, 'input_required', { inputRequests: { c1: { method: 'elicitation/create', params: { mode: 'form', message: 'Go ahead?', requestedSchema: { type: 'object', properties: {} } } } } }));
    if (tool === 'sample') later(() => set(t, 'input_required', { inputRequests: { s1: { method: 'sampling/createMessage', params: { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }], maxTokens: 10 } } } }));
    return t;
}

function handle(m, headers) {
    log(m, headers);
    const { id, method, params = {} } = m;
    if (id === undefined) return;
    const ok = (result) => send({ id, result: { resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fixture-tasks', version: '1.0.0' } }, ...result } });
    const err = (code, message) => send({ id, error: { code, message } });
    if (method === 'server/discover' && process.env.FIXTURE_LEGACY === '1') return err(-32601, 'Method not found');
    if (method === 'server/discover') return ok({ supportedVersions: ['2026-07-28'], capabilities: caps(), ttlMs: 0, cacheScope: 'private' });
    if (method === 'initialize') return send({ id, result: { protocolVersion: '2025-11-25', capabilities: process.env.FIXTURE_LEGACY === '1' ? { tools: {}, extensions: { [EXT]: {} } } : caps(), serverInfo: { name: 'fixture-tasks', version: '1.0.0' } } });
    if (method === 'tools/list' && process.env.FIXTURE_LEGACY === '1') return send({ id, result: { tools: TOOLS } });
    if (method === 'tools/list') return ok({ tools: TOOLS, ttlMs: 0, cacheScope: 'private' });
    if (method === 'tools/call') {
        const name = params.name;
        const args = params.arguments ?? {};
        if (name === 'echo' || !declared(params) || process.env.FIXTURE_NO_TASKS === '1') return ok({ content: [{ type: 'text', text: `echo: ${args.text ?? ''}${headers?.authorization ? ` (you sent ${headers.authorization})` : ''}` }], isError: false });
        if (name === 'bad_create') return send({ id, result: { resultType: 'task', status: 'working', createdAt: now(), lastUpdatedAt: now(), ttlMs: null } });
        const t = create(name, args);
        return send({ id, result: { resultType: 'task', ...view(t) } });
    }
    if (method.startsWith('tasks/')) {
        if (!declared(params)) return send({ id, error: { code: -32021, message: 'Missing required client capability', data: { requiredCapabilities: { extensions: { [EXT]: {} } } } } });
        const t = tasks.get(params.taskId);
        if (!t) return err(-32602, 'Failed to retrieve task: Task not found');
        if (method === 'tasks/get') {
            t.gets++;
            if (t.tool === 'vanish' && t.gets > 1) {
                tasks.delete(t.id);
                return err(-32602, 'Failed to retrieve task: Task not found');
            }
            if (t.tool === 'morph') return ok({ ...view(t), taskId: 'someone-elses-task' });
            if (t.tool === 'relapse' && t.status === 'completed' && t.gets > 3) return ok({ ...view(t), status: 'working', result: undefined });
            return ok(view(t));
        }
        if (method === 'tasks/update') {
            const responses = params.inputResponses ?? {};
            if (t.status === 'input_required') {
                for (const [key, r] of Object.entries(responses)) {
                    if (!t.inputRequests?.[key]) continue; // not outstanding: ignored
                    if (t.tool === 'ask2') {
                        (t.answers ??= {})[key] = r;
                        if (key === 'k1') setTimeout(() => set(t, 'input_required', { inputRequests: { k2: { method: 'elicitation/create', params: { mode: 'form', message: 'Last name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } } } }), TASK_MS);
                        else setTimeout(() => set(t, 'completed', { result: { content: [{ type: 'text', text: `Hello, ${t.answers.k1.content?.name} ${t.answers.k2.content?.name}!` }], isError: false } }), TASK_MS);
                        set(t, 'working', { inputRequests: undefined });
                        continue;
                    }
                    if (t.tool === 'ask') set(t, 'working', { inputRequests: undefined, answer: r });
                    if (t.tool === 'confirm') set(t, 'working', { inputRequests: undefined, answer: r });
                }
                if (t.status === 'working' && t.tool !== 'ask2') setTimeout(() => set(t, 'completed', { result: { content: [{ type: 'text', text: t.tool === 'ask' ? (t.answer.action === 'accept' ? `Hello, ${t.answer.content?.name}!` : `no name (${t.answer.action})`) : `answer: ${t.answer.action}` }], isError: false } }), TASK_MS);
            }
            return ok({});
        }
        if (method === 'tasks/cancel') {
            if (!['completed', 'failed', 'cancelled'].includes(t.status)) set(t, 'cancelled');
            return ok({});
        }
    }
    if (method === 'ping') return ok({});
    return err(-32601, 'Method not found');
}

const at = process.argv.indexOf('--http');
if (at > 0) {
    const portFile = process.argv[at + 1];
    const server = createServer((req, res) => {
        if (req.method !== 'POST') {
            res.writeHead(405).end();
            return;
        }
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
            let m;
            try {
                m = JSON.parse(body);
            } catch {
                res.writeHead(400).end();
                return;
            }
            let answered = false;
            send = (out) => {
                answered = true;
                res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', ...out }));
            };
            handle(m, { 'mcp-method': req.headers['mcp-method'] ?? null, 'mcp-name': req.headers['mcp-name'] ?? null, authorization: req.headers.authorization ?? null, 'x-helper': req.headers['x-helper'] ?? null });
            if (!answered) res.writeHead(202).end();
        });
    });
    server.listen(0, '127.0.0.1', () => writeFileSync(portFile, String(server.address().port)));
} else {
createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    try {
        handle(JSON.parse(line));
    } catch {
        // ignore
    }
});
process.stdin.on('end', () => process.exit(0));
}
