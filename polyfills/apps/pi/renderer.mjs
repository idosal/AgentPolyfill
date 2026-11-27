// Each opened result owns one renderer. In Pi, server operations stay in the originating session.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const helper = fileURLToPath(new URL('../claude-code/mod/helper/helper.mjs', import.meta.url));

// The root Pi package installs without npm dependencies. Check the renderer
// from its own module location before the session negotiates Apps support.
export function rendererSetupMessage() {
    const resolve = createRequire(helper).resolve;
    try {
        resolve('@modelcontextprotocol/sdk/client/index.js');
        resolve('playwright-core');
        return undefined;
    } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error;
        return `To enable MCP Apps, open ${dirname(helper)}, run npm ci --omit=dev --ignore-scripts, then restart Pi.`;
    }
}

// Pi's built-in MCP adapter exposes the original CallToolResult in the outer
// AgentToolResult.structuredContent. Its outer content is the model-facing preview.
export function originalMcpResult(result) {
    const wrapped = result.structuredContent;
    const mcp = Array.isArray(wrapped?.content) ? wrapped : result;
    return { content: mcp.content, structuredContent: mcp.structuredContent, isError: mcp.isError };
}

/** @param {any} options */
export async function openRenderer({ server, config, tool, input, result, cwd, cols, rows, onFrame, onImage, onTool, allowTool, confirmOpen, signal, native, kittyGraphics = false, onRequest = undefined, theme = undefined, modes = undefined, images = false, hover = false, audit = undefined, onLog = undefined, isCurrent = () => true }) {
    const runtimeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        /^(PATH|HOME|USERPROFILE|TMP|TEMP|TMPDIR|LANG|LC_.*|TZ|TERM|COLORTERM|COLORFGBG|DISPLAY|WAYLAND_DISPLAY|XDG_(RUNTIME|CONFIG|CACHE)_HOME|XDG_RUNTIME_DIR|SYSTEMROOT|WINDIR|LOCALAPPDATA|APPDATA|PROGRAMFILES.*|PROGRAMDATA|MCP_APPS_CLI_.*)$/i.test(key)));
    const child = spawn(process.execPath, [helper, '--pi', '--cwd', cwd], {
        cwd, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...runtimeEnv, MCP_APPS_CLI_TRANSPORT: 'tcp', MCP_APPS_CLI_MODE: onImage ? 'image' : 'cells', MCP_APPS_CLI_IMAGE_FILES: '0', MCP_APPS_CLI_STRIPS: '0', MCP_APPS_CLI_STORAGE_DIR: 'off', MCP_APPS_CLI_LINES: '1' }
    });
    const close = () => child.kill();
    signal?.addEventListener('abort', close, { once: true });
    if (signal?.aborted) close();
    if (process.env.MCP_APPS_CLI_DEBUG) child.stderr.pipe(process.stderr);
    else child.stderr.resume();
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({server, config}));
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
    async function answer(m) {
        if (signal?.aborted || !isCurrent() || !native.current()) throw Error('The Pi view has closed or the server changed.');
        const { name, arguments: args = {} } = m.params ?? {};
        if (m.method.startsWith('resources/') || m.method === 'prompts/list' || m.method === 'tools/list') return native.resource(m.method, m.params ?? {}, signal);
        if (m.method === 'tools/call') {
            const record = native.definition(name);
            const visibility = record?._meta?.ui?.visibility ?? ['model','app'];
            if (!record || !Array.isArray(visibility) || !visibility.includes('app') || !(await allowTool?.(name, args))) {
                throw Error('The requested app tool was unavailable or declined.');
            }
            if (signal?.aborted) throw Error('The Pi view closed.');
            return native.toolCall(record, args, signal, onTool);
        }
        if (onRequest) return onRequest(m.method, m.params ?? {});
        throw Error('This Pi view does not grant this request.');
    }
    lines.on('line', line => {
        let m;
        try { m = JSON.parse(line); } catch { return; }
        if (m.type === 'ready') ready.resolve(m);
        if (m.viewId !== viewId) return;
        if (m.type === 'frame' && m.image?.png) onImage?.(m.image.png, { cols: m.image.cols, rows: m.image.rows });
        if (m.type === 'frame' && m.frame) onFrame(m.frame.styled ?? m.frame.lines ?? [], m.frame.cols);
        if (m.type === 'notify' && m.method === 'ui/request-teardown') close();
        if (m.type === 'notify' && m.method === 'ui/audit') audit?.(m.params.method);
        if (m.type === 'notify' && m.method === 'log') onLog?.(m.params.text);
        if (m.type === 'request') {
            void answer(m).then(result => ({ result }), error => ({ error: error.message }))
                .then(reply => post('/reply', { id: m.id, gen: m.gen, ...reply })).catch(() => {});
        }
    });
    let timeout = setTimeout(close, 30000);
    try {
        const definition = native.tool;
        const uri = definition._meta?.ui?.resourceUri ?? definition._meta?.['ui/resourceUri'];
        const read = await native.resource('resources/read', {uri}, signal);
        const resource = read.contents.find(part => part.uri === uri);
        const { csp, hash, clipboard, warnings } = await post('/pi/review', { server, toolName:tool, definition, resource });
        clearTimeout(timeout); // The person controls how long they spend reviewing.
        if (!await confirmOpen?.(csp, {hash, clipboard, warnings}) || signal?.aborted) {
            close();
            return undefined;
        }
        timeout = setTimeout(close, 30000);
        if (!isCurrent() || !native.current()) throw Error('The original Pi connection changed.');
        const openingResult = native.result ?? result;
        await post('/open', { server, toolName: tool, toolInput: input, toolResult: openingResult,
            serverTools: Boolean(allowTool), resources: native.hasResources, actions: Boolean(onRequest), clipboard: Boolean(onRequest && clipboard),
            changes:native.changes, prompts:native.hasPrompts,
            fullscreen: Boolean(modes), pip: Boolean(modes), kittyGraphics, images, hover, theme, mode: onImage ? 'image' : 'cells', cols, maxRows: rows, userAgent: 'Pi (AgentPolyfill)' });
        // Preserve the order of a physical gesture across separate HTTP requests.
        let queued = Promise.resolve();
        function enqueue(route, body) {
            const next = queued.then(() => { if (!signal?.aborted) return post(route, body); });
            queued = next.catch(() => {});
            return next;
        }
        if (!openingResult && native.outcome) {
            void native.outcome.then(outcome => {
                if (!isCurrent() || !native.current() || signal?.aborted) return;
                return outcome.result ? enqueue('/result', {result:outcome.result}) : enqueue('/cancel', {reason:outcome.cancelled});
            }).catch(() => {});
        }
        const unsubscribe = native.subscribe?.(kind => { void enqueue('/pi/change', {kind}).catch(() => {}); }, close);
        if (unsubscribe) void closed.promise.then(unsubscribe);
        return { close, viewTools: () => enqueue('/pi/view-tools', {}),
            callViewTool: (name, args) => enqueue('/pi/view-tool', {name, args}), closed: closed.promise, input: event => enqueue('/input', { event }),
            theme: theme => enqueue('/theme', {theme}),
            resize: (cols, maxRows, display) => enqueue('/resize', { cols, maxRows, display }) };
    } catch (err) {
        close();
        throw err;
    } finally { clearTimeout(timeout); }
}
