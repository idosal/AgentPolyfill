// The two web pages: the front page, and a demo button's private page.

import { SOURCES } from './events.ts';

/** Per-address, per-minute limits for each route (src/index.ts uses the same numbers). */
export const ROUTE_LIMITS = { mcp: 240, press: 20, page: 60 } as const;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `
:root{--bg:#fbfaf7;--fg:#1d1c1a;--muted:#5f5b53;--line:#e4e0d6;--card:#ffffff;--accent:#c2410c;--accent-fg:#fff;--code:#f2efe8}
@media (prefers-color-scheme:dark){:root{--bg:#141311;--fg:#ece9e2;--muted:#a39e93;--line:#2c2a26;--card:#1c1b18;--accent:#fb923c;--accent-fg:#1a0d05;--code:#23211d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:46rem;margin:0 auto;padding:2.5rem 1rem 4rem}
h1{font-size:1.9rem;line-height:1.2;margin:0 0 .4rem;letter-spacing:-.01em}
h2{font-size:1.05rem;margin:2.2rem 0 .6rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
p{margin:.5rem 0}
a{color:var(--accent)}
.lede{font-size:1.12rem;color:var(--muted);margin-bottom:1.4rem}
code,pre{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
code{background:var(--code);padding:.1em .35em;border-radius:4px}
.cmd{display:flex;gap:.5rem;align-items:flex-start;margin:.6rem 0}
.cmd pre{flex:1;min-width:0;margin:0;background:var(--code);border:1px solid var(--line);border-radius:8px;padding:.7rem .85rem;white-space:pre-wrap;overflow-wrap:anywhere}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:.45rem .8rem}
button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
ol.asks{padding-left:1.2rem}ol.asks li{margin:.35rem 0}
table{width:100%;border-collapse:collapse;font-size:.95rem}
th,td{text-align:left;vertical-align:top;padding:.5rem .4rem;border-top:1px solid var(--line)}
th{font-weight:600;white-space:nowrap}
.note{border-left:3px solid var(--accent);padding:.2rem .9rem;color:var(--muted)}
footer{margin-top:3rem;color:var(--muted);font-size:.9rem}
.press{display:block;width:100%;max-width:22rem;margin:1.5rem auto;padding:1.6rem 1rem;font-size:1.6rem;font-weight:700;border:0;border-radius:18px;background:var(--accent);color:var(--accent-fg);box-shadow:0 6px 0 rgba(0,0,0,.25);transition:transform .06s}
.press:active{transform:translateY(4px);box-shadow:0 2px 0 rgba(0,0,0,.25)}
.press:disabled{opacity:.6;cursor:default}
.field{display:flex;flex-direction:column;gap:.3rem;max-width:22rem;margin:0 auto}
input[type=text]{font:inherit;padding:.55rem .7rem;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
.status{text-align:center;min-height:1.6rem;margin:.5rem 0;color:var(--muted)}
`;

function page(title: string, body: string, nonce: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main><script nonce="${nonce}">
for (const b of document.querySelectorAll('[data-copy]')) b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1500); } catch {} });
</script></body></html>`;
}

const copyable = (id: string, text: string) => `<div class="cmd"><pre id="${id}">${esc(text)}</pre><button type="button" data-copy="${id}" aria-label="Copy">Copy</button></div>`;

export function frontPage(origin: string, source: string, nonce: string): string {
    const add = `claude mcp add --transport http feeds ${origin}/mcp`;
    const code = (t: string) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>');
    const rows = SOURCES.map((s) => `<tr><th><code>${esc(s.name)}</code></th><td>${code(s.description.split('. Use it')[0]!.split('. Get a page')[0]!)}.</td></tr>`).join('');
    return page(
        'event-feeds',
        `<h1>event-feeds</h1>
<p class="lede">A public MCP server that offers <strong>events</strong>: things your agent can watch, so that it wakes up and acts when they happen. It implements the server side of the MCP Events extension (<a href="https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md">SEP-3415</a>).</p>

<h2>Add it</h2>
<p>In Claude Code, with the <code>mcp-events</code> polyfill from <a href="${esc(source)}">AgentPolyfill</a> installed (Claude Code does not have Events built in yet):</p>
${copyable('add', add)}
<p>Any client that speaks MCP Events (protocol revision 2026-07-28) can use <code>${esc(origin)}/mcp</code> the same way. No sign-in.</p>

<h2>Then ask Claude</h2>
<ol class="asks">
<li>“Give me a demo button and tell me what I typed when I press it.”</li>
<li>“Tell me when someone comments on the Show HN for AgentPolyfill.”</li>
<li>“Watch npm for a new version of wrangler and tell me what changed.”</li>
</ol>
<p>Or open <a href="/b/new">a button page</a> yourself: it gives you a private channel to watch.</p>

<h2>What you can watch</h2>
<table>${rows}</table>

<h2>What this server stores</h2>
<p><strong>Nothing you send is kept, except demo-button presses.</strong> A button channel keeps its presses (a number, a time, and the message typed next to the button, if any) for one hour; then they are deleted. There are no accounts, no request logs and no subscriptions on the server: your client's cursor holds its place in each feed.</p>
<p>Two short-lived things exist only to protect the server and its sources: per-address request counters for rate limits (they last a minute), and copies of the public pages read from Hacker News, npm, GitHub and USGS (a fresh copy for up to two minutes, so many watchers share one read, and the last good copy for up to an hour, to answer with when a source is busy).</p>

<h2>Third-party text</h2>
<p class="note">An event carries only ids, numbers, times and links. The text behind it (a comment, a title, release notes, a place name, a button message) is written by other people. Your agent reads it only when it asks, with the <code>read_event_text</code> tool, as plain, length-capped text. Package versions and release tags in events are short tokens chosen by whoever publishes the package or release.</p>

<h2>Limits</h2>
<p>Per address, per minute: ${ROUTE_LIMITS.mcp} requests to <code>/mcp</code>, ${ROUTE_LIMITS.press} presses and new buttons, ${ROUTE_LIMITS.page} page loads. A button: one press a second, 50 presses, one hour. Each upstream site is read at most 60 to 120 times a minute by the whole service, and at most 10 of those for any one address.</p>

<h2>Who runs it</h2>
<p>Ido Salomon runs it on Cloudflare Workers, as part of <a href="${esc(source)}">AgentPolyfill</a>, to show MCP Events working. The source, its limits and how to run your own copy are in the repository.</p>
<footer>Upstream data: <a href="https://hn.algolia.com/api">HN Search by Algolia</a> and the <a href="https://github.com/HackerNews/API">Hacker News API</a>, the <a href="https://docs.npmjs.com/">npm registry</a>, GitHub release feeds, and the <a href="https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php">USGS earthquake feeds</a>. Not affiliated with any of them.</footer>`,
        nonce
    );
}

export function buttonPage(channel: string, expiresAt: number, nonce: string): string {
    const ask = `Watch the demo.button event on the feeds server with channel ${channel}. When I press it, tell me what I typed.`;
    return page(
        'Demo button · event-feeds',
        `<h1>Your demo button</h1>
<p class="lede">This page is private to whoever has its link. Pressing the button sends an event on this channel only.</p>
<h2>1 · Tell Claude</h2>
${copyable('ask', ask)}
<h2>2 · Press</h2>
<div class="field"><label for="msg">Message (optional, sent with the press)</label><input id="msg" type="text" maxlength="120" autocomplete="off" placeholder="e.g. ship it"></div>
<button class="press" id="press" type="button">Press</button>
<p class="status" id="status" role="status" aria-live="polite"></p>
<h2>About this channel</h2>
<p>Channel <code>${esc(channel)}</code> expires <span id="exp" data-at="${expiresAt}"></span>. Until then it keeps its presses (count, time, message); then they are deleted. <a href="/b/new">New button</a> · <a href="/">About event-feeds</a></p>
<script nonce="${nonce}">
const ch = ${JSON.stringify(channel)};
const st = document.getElementById('status');
const btn = document.getElementById('press');
const exp = document.getElementById('exp');
const at = Number(exp.dataset.at);
const tick = () => { const m = Math.max(0, Math.round((at - Date.now()) / 60000)); exp.textContent = m > 0 ? 'in ' + m + ' minute' + (m === 1 ? '' : 's') : 'now'; };
tick(); setInterval(tick, 30000);
btn.addEventListener('click', async () => {
  btn.disabled = true;
  try {
    const r = await fetch('/api/press', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: ch, message: document.getElementById('msg').value }) });
    const j = await r.json().catch(() => ({}));
    st.textContent = j.ok ? 'Pressed (' + j.press + (j.press === 1 ? ' press' : ' presses') + ' on this channel). A watching session wakes within a few seconds.' : (j.error || 'That did not work. Try again.');
  } catch { st.textContent = 'Could not reach the server. Try again.'; }
  setTimeout(() => (btn.disabled = false), 1000);
});
</script>`,
        nonce
    );
}

export function expiredPage(nonce: string): string {
    return page('Button expired · event-feeds', `<h1>This button has expired</h1><p class="lede">Demo buttons last one hour, and then their presses are deleted.</p><p><a href="/b/new">Get a new button</a> · <a href="/">About event-feeds</a></p>`, nonce);
}
