// The part of the mcp-events test harness (test/harness.ts in the polyfill's source) this run uses.
// Types only; the harness itself is loaded from MCP_EVENTS_PLUGIN at run time.

type World = { dir: string; config: string; state: string; project: string };
type Plugin = { instructions(): string; call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>; stop(): Promise<void> };
type Monitor = { lines: string[]; stop(): void; kill(): void };

export declare function temp(prefix?: string): string;
export declare function sleep(ms: number): Promise<void>;
export declare function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs?: number, what?: string): Promise<T>;
export declare function startPlugin(w: World, session?: string, extra?: Record<string, string | undefined>): Promise<Plugin>;
export declare function startMonitor(w: World, session?: string): Monitor;
