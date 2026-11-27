import { copyToClipboard, getPackageDir, VERSION } from '@earendil-works/pi-coding-agent';
import type { TextContent, ImageContent } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { getCapabilities, parseKey, truncateToWidth, type OverlayHandle, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { piRunsMcp, readPiEntries } from '../../events/pi/src/pi-config.ts';
import type { nativeBridge } from './native.mjs';
import { protectModelCatalog } from './visibility.mjs';
import { reviewMessage } from './policy.mjs';
import { AppSurface } from './surface.ts';
import { randomUUID } from 'node:crypto';
import { hostActions, reviewText } from './actions.mjs';
import { openRenderer, originalMcpResult } from './renderer.mjs';

type ChatContent = string | (TextContent | ImageContent)[];
type ReviewedImage = ImageContent & {cells:[string,string,string][][]};

function displayError(error: unknown) {
    try { return reviewText(error instanceof Error ? error.message : 'Pi could not complete the app request.'); }
    catch { return 'Pi could not safely display the app error.'; }
}

export default function apps(pi: ExtensionAPI) {
    if (process.env.MCP_APPS_OFF === '1') return;
    let bridge: ReturnType<typeof protectModelCatalog>;
    try { bridge = protectModelCatalog(getPackageDir(), VERSION); }
    catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown Pi build.';
        pi.on('session_start', (_event, ctx) => ctx.ui.notify('MCP Apps disabled. ' + reason, 'warning'));
        return;
    }
    const snapshot = (server: string, ctx: ExtensionContext) => {
        if (!piRunsMcp(pi.getCommands())) return;
        const entry = readPiEntries({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted(), registered: pi.getMcpServers() }).entries.get(server);
        if (entry && entry.config.enabled !== false) return entry;
    };
    let recent: { server: string; tool: string; input: unknown; result: unknown; config: string; session: string; native: NonNullable<ReturnType<typeof nativeBridge.take>> } | undefined;
    let controller: AbortController | undefined;
    const remember = (native: NonNullable<ReturnType<typeof nativeBridge.take>>, ctx: ExtensionContext) => {
        const config = snapshot(native.server, ctx);
        if (!config || !native.matchesConfig(config.config, ctx.isProjectTrusted())) return;
        recent = {server:native.server, tool:native.name, native, input:native.args, result:native.result,
            config:JSON.stringify(config), session:ctx.sessionManager.getSessionId()};
    };
    pi.on('session_start', (_event, ctx) => {
        bridge.interactive = ctx.mode === 'tui';
        bridge.started = (receipt: NonNullable<ReturnType<typeof nativeBridge.take>>) => remember(receipt, ctx);
    });
    pi.on('session_shutdown', () => { bridge.interactive = false; bridge.started = undefined; recent = undefined; controller?.abort(); });
    pi.on('context', (event, ctx) => {
        const latest = new Map<string, {server:string; content:ChatContent}>();
        for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type !== 'custom' || entry.customType !== 'mcp-app-context') continue;
            const value = entry.data as {view:string; text:ChatContent; server:string};
            if (value.text.length) latest.set(value.view, {server:value.server,content:value.text});
            else latest.delete(value.view);
        }
        if (latest.size) return {messages:[...event.messages, ...Array.from(latest.values(), value => ({
            role:'custom' as const, customType:'mcp-app-context', display:false, timestamp:Date.now(),
            content:[{type:'text' as const, text:'Reviewed MCP App context from ' + JSON.stringify(value.server)},
                ...(typeof value.content === 'string' ? [{type:'text' as const,text:value.content}] :
                    value.content.map(block => block.type === 'image' && !ctx.model?.input.includes('image')
                        ? {type:'text' as const, text:'[Reviewed image omitted because this model accepts text only.]'} : block))]
        }))]};
    });
    pi.on('tool_result', (event, ctx) => {
        if (ctx.mode !== 'tui') return;
        const source = pi.getAllTools().find(item => item.name === event.toolName)?.sourceInfo.path;
        if (source !== 'builtin:mcp') return;
        const content = (event.structuredContent as {content?: unknown} | undefined)?.content;
        if (bridge.lookup(content)?.nested) return; // Its executor consumes the receipt.
        const native = bridge.take(content);
        const { server, tool } = event.details as { server?: string; tool?: string } ?? {};
        if (native && native.server === server && native.name === tool) {
            if (recent?.native !== native) remember(native, ctx);
        }
    });
    async function open(ctx: ExtensionContext, nested?: ExtensionToolContext, signal?: AbortSignal) {
        const item = recent;
        if (ctx.mode !== 'tui' || !item || !item.native.current() || item.session !== ctx.sessionManager.getSessionId()) {
            ctx.ui.notify('Run an MCP tool with an app in this Pi terminal session first.', 'info'); return;
        }
        const config = snapshot(item.server, ctx);
        if (!config || JSON.stringify(config) !== item.config) {
            ctx.ui.notify('The server configuration changed. Run the tool again.', 'warning'); return;
        }
        const source = JSON.stringify({ server: item.server, tool: item.tool });
        if (source.length > 1000 || /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(source)) return;
        if (!await ctx.ui.confirm('Inspect MCP App?', 'Connect to this server to read its app and review the access it requests? ' + source)) return;
        if (JSON.stringify(snapshot(item.server, ctx)) !== item.config || recent !== item) return;
        controller?.abort();
        const active = controller = new AbortController();
        const abort = () => active.abort();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) active.abort();
        try {
            await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
                const protocol = getCapabilities().images;
                const maxRows = () => Math.max(4, tui.terminal.rows - 5);
                let cols = Math.max(20, tui.terminal.columns - 2), height = maxRows();
                const surface = new AppSurface(protocol, event => { void renderer.then(r => r?.input(event)).catch(() => {}); });
                let closed = false;
                const finish = () => { if (!closed) { closed = true; overlay?.hide(); done(); } };
                type Mode = 'inline' | 'fullscreen' | 'pip';
                let inspecting = false;
                let mode: Mode = 'inline', overlay: OverlayHandle | undefined;
                let theme = ctx.ui.theme.appearance;
                const counts = new Map<string, number>();
                const logs: string[] = [];
                const valid = () => !active.signal.aborted && item.native.current() &&
                    item.session === ctx.sessionManager.getSessionId() && JSON.stringify(snapshot(item.server, ctx)) === item.config;
                const actions = hostActions({
                    confirm: async (title: string, body: string) => {
                        if (!valid() || inspecting) return false;
                        const was = overlay;
                        was?.setHidden(true);
                        try { return await ctx.ui.confirm(title, body, {signal:active.signal}) && valid(); }
                        finally { if (overlay === was && !closed) was?.setHidden(false); }
                    },
                    copy: copyToClipboard,
                    inspectImage: async (image: ReviewedImage) => {
                        if (!valid() || inspecting || !ctx.model?.input.includes('image')) return false;
                        const preview = new AppSurface(protocol, () => {});
                        if (protocol) preview.setImage(image.data, {cols:image.cells[0].length, rows:image.cells.length});
                        else preview.setCells(image.cells, image.cells[0].length);
                        const consent = await ctx.ui.custom<boolean>((screen, _theme, _keys, done) => {
                            const abort = () => done(false);
                            active.signal.addEventListener('abort', abort, {once:true});
                            return {render:width => ['Image from ' + JSON.stringify(item.server),
                                ...preview.render(width, Math.max(1,screen.terminal.rows - 6)), 'Y to include this image · N or Esc to decline'],
                                handleInput(data) {
                                    const key = parseKey(data);
                                    if (key === 'y') done(true);
                                    if (key === 'n' || key === 'escape' || key === 'ctrl+c') done(false);
                                }, invalidate:() => preview.invalidate(),
                                dispose:() => active.signal.removeEventListener('abort', abort)};
                        }, {overlay:true, overlayOptions:{width:'90%',maxHeight:'95%'}});
                        return consent && valid();
                    },
                    send: (text: ChatContent) => pi.sendUserMessage(text, {deliverAs:'followUp', expandPromptTemplates:false}),
                    setContext: (text: ChatContent) => pi.appendEntry('mcp-app-context', {view:item.session + '/' + viewId, server:item.server, text}),
                    display: async (requested: Mode) => {
                        if (!valid() || requested === mode || !['inline','fullscreen','pip'].includes(requested)) return mode;
                        if (requested === 'pip' && (tui.terminal.columns < 48 || tui.terminal.rows < 16)) return mode;
                        overlay?.hide(); overlay = undefined;
                        mode = requested;
                        if (mode !== 'inline') overlay = tui.showOverlay(component, mode === 'pip'
                            ? {width:'60%', maxHeight:'55%', anchor:'bottom-right'} : {width:'100%', maxHeight:'100%', anchor:'top-left'});
                        tui.requestRender();
                        const r = await renderer;
                        await r?.resize(cols, height, mode);
                        return mode;
                    }
                });
                const viewId = randomUUID();
                // The renderer only needs the origin for network policy. Pi owns all credentials.
                const policyConfig = typeof config.config.url === 'string' ? {url:(() => {
                    try { return new URL(config.config.url as string).origin; } catch { return 'https://unresolved.invalid'; }
                })()} : {command:'stdio'};
                const renderer = openRenderer({ ...item, config:policyConfig, native:item.native, theme, kittyGraphics:protocol === 'kitty', modes:true, images:ctx.model?.input.includes('image'), isCurrent:valid,
                    hover:tui.mode === 'fullscreen', onRequest: actions.request,
                    onLog: (line: string) => { logs.push(line); if (logs.length > 50) logs.shift(); },
                    audit: (method: string) => {
                        const key = /^[a-zA-Z][a-zA-Z0-9_/-]{0,79}$/.test(method) && (counts.has(method) || counts.size < 64)
                            ? method : '(other)';
                        counts.set(key, (counts.get(key) ?? 0) + 1);
                    }, cwd: ctx.cwd, cols, rows: height, signal: active.signal,
                    confirmOpen: async (csp: Record<string, string[]>, review: {hash:string;clipboard:boolean;warnings:string[]}) => {
                        pi.appendEntry('mcp-app-policy', {server:item.server, tool:item.tool, hash:review.hash, csp});
                        const hashes = (key:string) => (process.env[key] ?? '').split(',').map(s => s.trim()).filter(Boolean);
                        const allowed = hashes('PI_MCP_APPS_ALLOW_HASHES');
                        if (hashes('PI_MCP_APPS_DENY_HASHES').includes(review.hash) || (allowed.length && !allowed.includes(review.hash))) {
                            throw Error('This version of the app is blocked by your resource hash policy.');
                        }
                        if (active.signal.aborted) return false;
                        const accepted = await ctx.ui.confirm('Open MCP App?', reviewMessage(item.server, item.tool, csp, review), {signal:active.signal});
                        return accepted && !active.signal.aborted && recent === item &&
                            item.session === ctx.sessionManager.getSessionId() && JSON.stringify(snapshot(item.server, ctx)) === item.config;
                    },
                    allowTool: async (name: string, args: Record<string, unknown>) => {
                        return valid() && actions.approve('Call this MCP tool?', JSON.stringify({server:item.server, tool:name, arguments:args}, null, 2));
                    },
                    onTool: nested ? async (name: string, args: Record<string, unknown>) => {
                        if (!valid()) throw Error('The original Pi session changed.');
                        const callable = nested.tools.find(tool => tool.label === item.server + '/' + name);
                        const target = pi.getAllTools().find(tool => tool.sourceInfo.path === 'builtin:mcp' &&
                            tool.namespace?.aliases?.includes(item.server) &&
                            tool.name === callable?.name);
                        if (!target || target.exposure === 'hidden' || !nested.tools.some(tool => tool.name === target.name)) throw Error('Pi does not expose this tool.');
                        if (JSON.stringify(snapshot(item.server, ctx)) !== item.config) throw Error('The server configuration changed.');
                        const response = await nested.executeTool(target.name, args, { signal: active.signal });
                        const result = bridge.take((response.result.structuredContent as {content?:unknown} | undefined)?.content)?.result ?? originalMcpResult(response.result);
                        return { ...result, isError: response.isError || result.isError };
                    } : undefined,
                    onImage: protocol ? (png: string, grid: { cols: number; rows: number }) => {
                        surface.setImage(png, grid); tui.requestRender();
                    } : undefined,
                    onFrame: (frame: [string, string, string][][], frameCols: number) => {
                        surface.setCells(frame, frameCols); tui.requestRender();
                    } });
                void renderer.then(r => r ? r.closed.then(finish) : finish(), e => {
                    ctx.ui.notify(displayError(e), 'error'); finish();
                });
                async function inspectView(showLogs: boolean) {
                    if (inspecting || !valid()) return;
                    inspecting = true;
                    const was = overlay;
                    was?.setHidden(true);
                    try {
                        if (showLogs) {
                            await ctx.ui.select('App log · most recent first', logs.length ? logs.slice().reverse() : ['No messages yet'], {signal:active.signal});
                            return;
                        }
                        const r = await renderer;
                        const catalog = (await r?.viewTools())?.tools ?? [];
                        const names: string[] = catalog.map((tool: {name:string}) => reviewText(tool.name));
                        if (!names.length) { ctx.ui.notify('This view offers no tools.', 'info'); return; }
                        const name = await ctx.ui.select('Run a tool provided by this app', names, {signal:active.signal});
                        if (!name || !valid()) return;
                        const definition = catalog.find((tool: {name:string}) => tool.name === name);
                        const input = await ctx.ui.input('Arguments for ' + name, reviewText(JSON.stringify(definition.inputSchema)), {signal:active.signal});
                        if (input === undefined || !valid()) return;
                        const args = JSON.parse(input || '{}');
                        if (!args || Array.isArray(args) || typeof args !== 'object') throw Error('Expected a JSON object.');
                        const reply = await r?.callViewTool(name, args);
                        ctx.ui.notify(reviewText(JSON.stringify(reply?.result)), 'info');
                    } catch (e) { ctx.ui.notify(displayError(e), 'warning'); }
                    finally { inspecting = false; if (was === overlay && !closed) was?.setHidden(false); }
                }
                const component = {
                    invalidate: () => surface.invalidate(),
                    render(width: number) {
                        if (ctx.ui.theme.appearance !== theme) { theme = ctx.ui.theme.appearance; void renderer.then(r => r?.theme(theme)).catch(() => {}); }
                        const nextCols = Math.min(240, Math.max(20, width - 2)), nextHeight = Math.min(80, mode === 'pip' ? Math.max(4, Math.floor(tui.terminal.rows * .55) - 1) : mode === 'fullscreen' ? tui.terminal.rows - 1 : maxRows());
                        if (nextCols !== cols || nextHeight !== height) {
                            cols = nextCols; height = nextHeight;
                            void renderer.then(r => r?.resize(nextCols, nextHeight, mode)).catch(() => {});
                        }
                        const hint = tui.mode === 'fullscreen' ? 'Click or drag · Tab to focus · Enter to activate · Ctrl+G app tools · Esc to close'
                            : 'Tab to focus · Enter to activate · Ctrl+G app tools · Esc to close';
                        return [...surface.render(width, height), truncateToWidth(hint, width)];
                    },
                    handleMouse: (event: TuiMouseEvent) => surface.handleMouse(event),
                    handleInput(data: string) {
                        const key = parseKey(data);
                        if (key === 'ctrl+g' || key === 'ctrl+l') { void inspectView(key === 'ctrl+l'); return; }
                        if (key === 'escape' || key === 'ctrl+c') { active.abort(); finish(); return; }
                        if (!key) return;
                        const parts = key.split('+');
                        const base = parts.pop() || '+';
                        const mapped = base === 'enter' ? 'return' : base === 'space' ? ' ' : base;
                        void renderer.then(r => r?.input({ kind: 'key', key: mapped,
                            shift: parts.includes('shift'), ctrl: parts.includes('ctrl'), meta: parts.includes('alt') })).catch(() => {});
                    } };
                return { ...component, render: (width: number) => overlay ? [] : component.render(width),
                    dispose: () => {
                        overlay?.hide(); active.abort();
                        if (counts.size && item.session === ctx.sessionManager.getSessionId()) pi.appendEntry('mcp-app-rpc', {
                            server:item.server, tool:item.tool, methods:Object.fromEntries(counts)
                        });
                    } };
            });
        } finally { signal?.removeEventListener('abort', abort); active.abort(); if (controller === active) controller = undefined; }
    }
    pi.registerCommand('mcp-app', {
        description: 'Open the most recent MCP tool result in an interactive view',
        handler: (_args, ctx) => open(ctx)
    });
    let registered = false;
    pi.on('session_start', (_event, ctx) => {
        if (ctx.mode !== 'tui' || registered) return;
        registered = true;
        pi.registerTool({
            name: 'open_mcp_app', label: 'Open MCP App',
            description: 'Offer to open the most recent MCP tool result in an interactive view for the user.',
            parameters: { type: 'object', properties: {}, additionalProperties: false } as never,
            reachesTools: () => 'all', executionMode: 'sequential',
            async execute(_id, _args, signal, _update, ctx) {
                await open(ctx, ctx, signal);
                return { content: [{ type: 'text', text: 'The MCP App viewer is closed.' }], details: {} };
            }
        });
    });
}
