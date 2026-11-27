// The proxy receives the reviewed HTML over the standard handshake. Its inner
// document is served from a third origin so Chromium applies a response header
// before parsing the first byte of the app.
export function sandboxPage(host, viewUrl, digest, sandbox) {
    function start(host, viewUrl, digest, sandbox) {
        const viewOrigin = new URL(viewUrl).origin;
        const frame = document.querySelector('iframe');
        let loading = false;
        addEventListener('message', async event => {
            const m = event.data;
            if (!m || m.jsonrpc !== '2.0') return;
            const reserved = typeof m.method === 'string' && m.method.startsWith('ui/notifications/sandbox-');
            if (event.source === parent && event.origin === host) {
                if (reserved) {
                    if (m.method !== 'ui/notifications/sandbox-resource-ready' || loading ||
                        typeof m.params?.html !== 'string') return;
                    loading = true;
                    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m.params.html));
                    const hex = Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
                    if (hex !== digest) return;
                    frame.setAttribute('sandbox', sandbox);
                    frame.src = viewUrl;
                } else if (loading) frame.contentWindow.postMessage(m, viewOrigin);
            } else if (event.source === frame.contentWindow && event.origin === viewOrigin && !reserved) {
                // The stable example has one text block; the SDK schema uses an array.
                if (m.method === 'ui/message' && m.params?.content?.type === 'text') {
                    m.params.content = [m.params.content];
                }
                parent.postMessage(m, host);
            }
        });
        parent.postMessage({jsonrpc:'2.0', method:'ui/notifications/sandbox-proxy-ready', params:{}}, host);
    }
    const config = [host, viewUrl, digest, sandbox].map(value => JSON.stringify(value)).join(',');
    return '<!doctype html><meta charset="utf-8"><style>html,body,iframe{margin:0;border:0;width:100%;height:100%;display:block;overflow:hidden}</style><iframe title="MCP App"></iframe><script>(' +
        start.toString() + ')(' + config + ')</script>';
}
