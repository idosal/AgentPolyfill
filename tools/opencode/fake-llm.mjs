#!/usr/bin/env node
// A scripted stand-in for a model, for the OpenCode forms' tests: an
// OpenAI-compatible chat completions endpoint on loopback that answers by rule,
// so OpenCode runs real turns (tool calls included) with no model and no key.
//
// On the last message of each request:
// - a user message that contains `CALL <tool> <json>` is answered with that tool
//   call (the JSON is the arguments);
// - a tool result is answered with the text `TOOL RESULT: <its first 400 characters>`;
// - anything else is answered with `ECHO: <its first 200 characters>`.
//
// Every request is appended, as one JSON line, to the log file given as the
// second argument, so a test can read what OpenCode sent the model.
//
//   node fake-llm.mjs <port, 0 for any> [log file]
//
// It prints `fake-llm <port>` once it listens.

import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.argv[2] || 0);
const log = process.argv[3];

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');

function answer(messages) {
    const last = messages.at(-1) ?? {};
    if (last.role === 'tool') return { text: `TOOL RESULT: ${textOf(last.content).slice(0, 400)}` };
    const text = textOf(last.content);
    const m = /CALL (\S+) (\{.*\})/s.exec(text);
    if (m) return { tool: { name: m[1], args: m[2] } };
    return { text: `ECHO: ${text.slice(0, 200)}` };
}

const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    let j = {};
    try {
        j = body ? JSON.parse(body) : {};
    } catch {
        // not JSON: answered as an empty request
    }
    if (log) appendFileSync(log, JSON.stringify({ url: req.url, body: j }) + '\n');
    if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'scripted', object: 'model' }] }));
    }
    const reply = answer(Array.isArray(j.messages) ? j.messages : []);
    const id = `c${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const base = { id, created: Math.floor(Date.now() / 1000), model: 'scripted' };
    const call = reply.tool && { id: `call_${id}`, type: 'function', function: { name: reply.tool.name, arguments: reply.tool.args } };
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    if (!j.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        const message = call ? { role: 'assistant', content: null, tool_calls: [call] } : { role: 'assistant', content: reply.text };
        return res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }], usage }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (o) => res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', ...o })}\n\n`);
    if (call) send({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] }, finish_reason: null }] });
    else send({ choices: [{ index: 0, delta: { role: 'assistant', content: reply.text }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] });
    send({ choices: [], usage });
    res.write('data: [DONE]\n\n');
    res.end();
});

server.listen(port, '127.0.0.1', () => console.log(`fake-llm ${server.address().port}`));
