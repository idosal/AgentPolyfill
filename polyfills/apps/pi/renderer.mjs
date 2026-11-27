// Each opened result owns a renderer and its single read-only MCP connection.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const helper = fileURLToPath(new URL('../claude-code/mod/helper/helper.mjs', import.meta.url));

// Pi's built-in MCP adapter exposes the original CallToolResult in the outer
// AgentToolResult.structuredContent. Its outer content is the model-facing preview.
export function originalMcpResult(result) {
    const wrapped = result.structuredContent;
    const mcp = Array.isArray(wrapped?.content) ? wrapped : result;
    return { content: mcp.content, structuredContent: mcp.structuredContent, isError: mcp.isError };
}

export async function openRenderer({ server, config, tool, input, result, cwd, cols, rows, onFrame, onImage, onTool, allowTool, confirmOpen, signal }) {
    const child = spawn(process.execPath, [helper, '--pi', '--cwd', cwd], {
        cwd, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, MCP_APPS_CLI_TRANSPORT: 'tcp', MCP_APPS_CLI_MODE: onImage ? 'image' : 'cells', MCP_APPS_CLI_IMAGE_FILES: '0', MCP_APPS_CLI_STRIPS: '0', MCP_APPS_CLI_STORAGE_DIR: 'off', MCP_APPS_CLI_LINES: '1' }
    });
    const close = () => child.kill();
    signal?.addEventListener('abort', close, { once: true });
    if (signal?.aborted) close();
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ server, config }));
    const ready = Promise.withResolvers();
    const closed = Promise.withResolvers();
    const lines = createInterface({ input: child.stdout });
    child.once('error', ready.reject);
    child.once('close', () => {
        ready.reject(new Error('Apps renderer exited. Check the renderer installation.'));
        closed.resolve();
        signal?.removeEventListener('abort', close);
        lines.close();
    });
    const viewId = randomUUID();
    async function post(route, body) {
        const { url, token } = await ready.promise;
        const response = await fetch(url + route, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-mcp-apps-cli-token': token },
            body: JSON.stringify({ viewId, ...body }), signal: AbortSignal.timeout(20000)
        });
        const answer = await response.json();
        if (!response.ok || !answer.ok) throw new Error(answer.error ?? 'Renderer request failed');
        return answer;
    }
    let definitions = {};
    let pendingTool;
    async function answer(m) {
        const { name, arguments: args = {} } = m.params ?? {};
        if (m.method === 'ui/allow-tool') {
            pendingTool = undefined;
            const normalize = value => value.replace(/[^A-Za-z0-9_]/g, '_');
            const known = typeof name === 'string' && Object.hasOwn(definitions, name) &&
                Object.keys(definitions).filter(other => normalize(other) === normalize(name)).length === 1;
            const allow = known && !m.params?.appOnly && Boolean(await allowTool?.(name, args));
            if (allow) pendingTool = JSON.stringify([name, args]);
            return { allow };
        }
        if (m.method === 'tools/call' && pendingTool === JSON.stringify([name, args]) && onTool) {
            pendingTool = undefined;
            return onTool(name, args);
        }
        throw Error('This Pi view does not grant this request.');
    }
    lines.on('line', line => {
        let m;
        try { m = JSON.parse(line); } catch { return; }
        if (m.type === 'ready') ready.resolve(m);
        if (m.viewId !== viewId) return;
        if (m.type === 'frame' && m.image?.png) onImage?.(m.image.png, { cols: m.image.cols, rows: m.image.rows });
        if (m.type === 'frame' && m.frame) onFrame(m.frame.styled ?? m.frame.lines ?? [], m.frame.cols);
        if (m.type === 'request') {
            void answer(m).then(result => ({ result }), error => ({ error: error.message }))
                .then(reply => post('/reply', { id: m.id, gen: m.gen, ...reply })).catch(() => {});
        }
    });
    let timeout = setTimeout(close, 30000);
    try {
        const discovery = await post('/discover', { server });
        definitions = discovery.definitions;
        if (!Object.hasOwn(discovery.tools, tool)) throw new Error('This tool has no MCP App.');
        const { csp } = await post('/pi/review', { server, toolName: tool });
        clearTimeout(timeout); // The person controls how long they spend reviewing.
        if (!await confirmOpen?.(csp) || signal?.aborted) {
            close();
            return undefined;
        }
        timeout = setTimeout(close, 30000);
        await post('/open', { server, toolName: tool, toolInput: input, toolResult: result,
            serverTools: Boolean(onTool && allowTool), mode: onImage ? 'image' : 'cells', cols, maxRows: rows, userAgent: 'Pi (AgentPolyfill)' });
        // Preserve the order of a physical gesture across separate HTTP requests.
        let queued = Promise.resolve();
        function enqueue(route, body) {
            const next = queued.then(() => { if (!signal?.aborted) return post(route, body); });
            queued = next.catch(() => {});
            return next;
        }
        return { close, closed: closed.promise, input: event => enqueue('/input', { event }),
            resize: (cols, maxRows) => enqueue('/resize', { cols, maxRows }) };
    } catch (err) {
        close();
        throw err;
    } finally { clearTimeout(timeout); }
}
