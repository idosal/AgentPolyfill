// A scripted OpenAI-compatible chat-completions endpoint for CI: it lets Copilot CLI load the
// extension with no sign-in (COPILOT_OFFLINE=true, COPILOT_PROVIDER_BASE_URL pointing here). It
// stands in for the model, nothing more: the last user message decides each reply.
//   "CALL <tool> <json>"                one tool call; "CALL a {..} ;; CALL b {..}" calls them in turn
//   after the last tool result          "RESULT: <the result's first 2000 characters>"
//   a message with "[mcp-events]"       get_event for the first event id in it (the wake), else "WOKEN: ..."
//   anything else                       FAKE_DEFAULT_CALLS (the same CALL form) if set, else "OK"
// Every request is logged to FAKE_MODEL_LOG (what Copilot sent the model: tools, messages).
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const LOG = process.env.FAKE_MODEL_LOG;
const log = (o) => LOG && appendFileSync(LOG, JSON.stringify(o) + '\n');
let n = 0;
createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
  log({ url: req.url, method: req.method, model: j.model, tools: (j.tools || []).map((t) => t.function?.name), msgs: (j.messages || []).map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 1500) : m.content, tool_calls: m.tool_calls })) });
  if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'fake', object: 'model' }] })); }
  const msgs = j.messages || [];
  const last = msgs[msgs.length - 1] || {};
  const text = (m) => typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => p.text || '').join('') : '';
  let reply = { content: 'OK' };
  const lastUserIdx = msgs.map((m) => m.role).lastIndexOf('user');
  const userText = (m) => { const t = text(m); return /CALL \S+/.test(t) || /\[mcp-events\]/.test(t) || !process.env.FAKE_DEFAULT_CALLS ? t : process.env.FAKE_DEFAULT_CALLS; };
  const calls = lastUserIdx >= 0 ? userText(msgs[lastUserIdx]).split(' ;; ').map((c) => /CALL (\S+)(?: (\{.*\}))?/s.exec(c)).filter(Boolean) : [];
  const done = msgs.slice(lastUserIdx + 1).filter((m) => m.role === 'tool').length;
  if (last.role === 'tool' && calls.length > 1 && done < calls.length) { const c = calls[done]; reply = { tool_calls: [{ index: 0, id: 'call_' + (++n), type: 'function', function: { name: c[1], arguments: c[2] || '{}' } }] }; }
  else if (last.role === 'tool') reply = { content: 'RESULT: ' + text(last).slice(0, 2000) };
  else {
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const m = /CALL (\S+)(?: (\{.*?\}))?(?: ;; |$)/s.exec(lastUser ? userText(lastUser) : '');
    if (m) reply = { tool_calls: [{ index: 0, id: 'call_' + (++n), type: 'function', function: { name: m[1], arguments: m[2] || '{}' } }] };
    else if (lastUser && /\[mcp-events\]/.test(text(lastUser))) {
      const id = /\b(e\d+)\b/.exec(text(lastUser));
      reply = id ? { tool_calls: [{ index: 0, id: 'call_' + (++n), type: 'function', function: { name: 'get_event', arguments: JSON.stringify({ id: id[1] }) } }] } : { content: 'WOKEN: ' + text(lastUser).slice(0, 300) };
    }
  }
  log({ reply });
  const id = 'chatcmpl-' + (++n);
  if (j.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish) => res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: j.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }] }) + '\n\n');
    chunk({ role: 'assistant' });
    if (reply.tool_calls) chunk({ tool_calls: reply.tool_calls }); else chunk({ content: reply.content });
    chunk({}, reply.tool_calls ? 'tool_calls' : 'stop');
    res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: j.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, object: 'chat.completion', created: 0, model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: reply.content ?? null, tool_calls: reply.tool_calls?.map(({ index, ...t }) => t) }, finish_reason: reply.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  }
}).listen(Number(process.env.PORT || 18555), '127.0.0.1');
