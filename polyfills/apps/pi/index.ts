import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { getCapabilities, Image, parseKey, truncateToWidth } from '@earendil-works/pi-tui';
import { parseEntry, piRunsMcp, readPiEntries } from '../../events/pi/src/pi-config.ts';
import { openRenderer } from './renderer.mjs';

export default function apps(pi: ExtensionAPI) {
    if (process.env.MCP_APPS_OFF === '1') return;
    const snapshot = (server: string, ctx: ExtensionContext) => {
        if (!piRunsMcp(pi.getCommands())) return;
        const entry = readPiEntries({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted(), registered: pi.getMcpServers() }).entries.get(server);
        if (!entry) return;
        const config = parseEntry(server, entry.config, { cwd: ctx.cwd, env: process.env, runCommand: () => undefined });
        if (config && !('skip' in config)) return config;
    };
    let recent: { server: string; tool: string; input: unknown; result: unknown; config: string; session: string } | undefined;
    let controller: AbortController | undefined;
    pi.on('session_shutdown', () => { recent = undefined; controller?.abort(); });
    pi.on('tool_result', (event, ctx) => {
        if (!ctx.hasUI || event.isError) return;
        const source = pi.getAllTools().find(item => item.name === event.toolName)?.sourceInfo.path;
        if (source !== 'builtin:mcp') return;
        const { server, tool } = event.details as { server?: string; tool?: string } ?? {};
        if (!server || !tool) return;
        const config = snapshot(server, ctx);
        recent = config ? { server, tool, input: event.input, result: { content: event.content, structuredContent: event.structuredContent },
            config: JSON.stringify(config), session: ctx.sessionManager.getSessionId() } : undefined;
    });
    async function open(ctx: ExtensionContext, nested?: ExtensionToolContext, signal?: AbortSignal) {
        const item = recent;
        if (!ctx.hasUI || !item || item.session !== ctx.sessionManager.getSessionId()) {
            ctx.ui.notify('Run an MCP tool with an app in this session first.', 'info'); return;
        }
        const config = snapshot(item.server, ctx);
        if (!config || JSON.stringify(config) !== item.config) {
            ctx.ui.notify('The server configuration changed. Run the tool again.', 'warning'); return;
        }
        const source = JSON.stringify({ server: item.server, tool: item.tool });
        if (source.length > 1000 || /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(source)) return;
        if (!await ctx.ui.confirm('Open MCP App?', 'Share this tool’s original input and result with its app? ' + source)) return;
        if (JSON.stringify(snapshot(item.server, ctx)) !== item.config || recent !== item) return;
        controller?.abort();
        const active = controller = new AbortController();
        const abort = () => active.abort();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) active.abort();
        try {
            await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
                let rows: string[] = ['Opening MCP App…'];
                let picture: Image | undefined;
                let closed = false;
                const finish = () => { if (!closed) { closed = true; done(); } };
                const renderer = openRenderer({ ...item, config, cwd: ctx.cwd, cols: Math.max(20, tui.terminal.columns - 2),
                    rows: Math.max(4, tui.terminal.rows - 5), signal: active.signal,
                    allowTool: nested ? async (name: string, args: Record<string, unknown>) => {
                        if (!nested || active.signal.aborted || JSON.stringify(snapshot(item.server, ctx)) !== item.config) return false;
                        const description = JSON.stringify({ server: item.server, tool: name, arguments: args }, null, 2);
                        if (description.length > 3000 || /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(description)) return false;
                        return (await ctx.ui.select(description, ['Decline', 'Call tool'])) === 'Call tool' && !active.signal.aborted;
                    } : undefined,
                    async onTool(name: string, args: Record<string, unknown>) {
                        if (!nested || active.signal.aborted) throw Error('Use the open_mcp_app tool to allow nested Pi tool calls.');
                        const target = pi.getAllTools().find(tool => tool.sourceInfo.path === 'builtin:mcp' &&
                            tool.namespace?.aliases?.includes(item.server) &&
                            tool.name === 'mcp__' + item.server.replace(/[^a-zA-Z0-9_]/g, '_') + '__' + name.replace(/[^a-zA-Z0-9_]/g, '_'));
                        if (!target || target.exposure === 'hidden' || !nested.tools.some(tool => tool.name === target.name)) throw Error('Pi does not expose this tool.');
                        if (JSON.stringify(snapshot(item.server, ctx)) !== item.config) throw Error('The server configuration changed.');
                        const response = await nested.executeTool(target.name, args, { signal: active.signal });
                        return { content: response.result.content, structuredContent: response.result.structuredContent, isError: response.isError };
                    },
                    onImage: getCapabilities().images ? (png: string) => {
                        picture = new Image(png, 'image/png', { fallbackColor: text => text }, {
                            imageId: picture?.getImageId(), maxHeightCells: Math.max(4, tui.terminal.rows - 5)
                        });
                        tui.requestRender();
                    } : undefined,
                    onFrame: (frame: [string, string, string][][]) => {
                        rows = frame.map(line => line.map(([text, fg, bg]) => {
                            const color = (hex: string, code: number) => /^#[a-f0-9]{6}$/i.test(hex)
                                ? '\x1b[' + code + ';2;' + hex.slice(1).match(/../g)!.map(x => parseInt(x,16)).join(';') + 'm' : '';
                            return color(fg,38) + color(bg,48) + text.replace(/[\x00-\x1f\x7f-\x9f]/g,'') + '\x1b[0m';
                        }).join('')); tui.requestRender();
                    } });
                void renderer.then(r => r.closed.then(finish), e => { ctx.ui.notify(String(e.message), 'error'); finish(); });
                return { invalidate() {}, render: width => [...(picture?.render(width) ?? rows.map(line => truncateToWidth(line, width))),
                        truncateToWidth('Tab to focus · Enter to activate · Esc to close', width)],
                    handleInput(data) {
                        const key = parseKey(data);
                        if (key === 'escape' || key === 'ctrl+c') { active.abort(); finish(); return; }
                        if (!key) return;
                        const parts = key.split('+');
                        const base = parts.pop() || '+';
                        const mapped = base === 'enter' ? 'return' : base === 'space' ? ' ' : base;
                        void renderer.then(r => r.input({ kind: 'key', key: mapped,
                            shift: parts.includes('shift'), ctrl: parts.includes('ctrl'), meta: parts.includes('alt') })).catch(() => {});
                    } };
            });
        } finally { signal?.removeEventListener('abort', abort); active.abort(); if (controller === active) controller = undefined; }
    }
    pi.registerCommand('mcp-app', {
        description: 'Open the most recent MCP tool result in an interactive view',
        handler: (_args, ctx) => open(ctx)
    });
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
}
