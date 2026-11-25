// The part of OpenCode's V2 server plugin API (`@opencode/plugin`, 2.4.1) this
// plugin uses, written out so the plugin needs nothing from OpenCode at run
// time. Each shape was checked against the package's own declarations
// (dist/promise/*.d.ts) and against a running OpenCode 2.4.1.

export type Json = Record<string, unknown>;
export type Registration = { dispose(): Promise<void> };

/** An MCP server as OpenCode's configuration holds it (`Mcp.ServerConfig`). */
export type McpServerConfig =
    | { type: 'local'; command: readonly string[]; cwd?: string; environment?: Record<string, string>; disabled?: boolean }
    | { type: 'remote'; url: string; headers?: Record<string, string>; oauth?: unknown; disabled?: boolean };

export type McpStatus = { status: 'connected' | 'pending' | 'disabled' | 'failed' | 'needs_auth' | string };
export type McpServerInfo = { name: string; status: McpStatus | string; title?: string; integrationID?: string };

export type MCPEditor = {
    list(): readonly (readonly [string, McpServerConfig])[];
    get(name: string): McpServerConfig | undefined;
    set(name: string, config: McpServerConfig): void;
    update(name: string, update: (config: McpServerConfig) => void): void;
    remove(name: string): void;
};

/** What a tool's executor is told about the call. */
export type ToolCallContext = { sessionID: string; agent: string; messageID: string; id: string; signal: AbortSignal };
export type ToolResult = { content: string; metadata?: Json };
export type ToolInfo = {
    name: string;
    description: string;
    /** A JSON Schema object. */
    input: Json;
    options?: { namespace?: string; codemode?: boolean };
    execute(input: unknown, context: ToolCallContext): Promise<ToolResult>;
};
export type ToolEditor = {
    namespace(ns: { name: string; description: string }): void;
    add(tool: ToolInfo): void;
};

export type PermissionAssert = {
    sessionID: string;
    agent?: string;
    action: string;
    resources: string[];
    save?: string[];
    metadata?: Json;
    source?: { type: 'tool'; messageID: string; id: string };
};

export type SyntheticInput = {
    sessionID: string;
    text: string;
    description?: string;
    metadata?: Json;
    delivery?: 'steer' | 'queue';
    resume?: boolean;
};

export type SessionPromptHook = { readonly sessionID: string; readonly messageID: string; prompt: { text: string } };

export type Context = {
    app: { version: string };
    location: { directory: string; workspaceID?: string; project: { id: string; directory: string; canonical: string } };
    options: Json;
    mcp: {
        list(): Promise<{ data: McpServerInfo[] }>;
        transform(callback: (editor: MCPEditor) => void): Promise<Registration>;
        reload(): Promise<void>;
    };
    tool: {
        list(): Promise<readonly { id: string }[]>;
        transform(callback: (editor: ToolEditor) => void): Promise<Registration>;
    };
    permission: {
        assert(input: PermissionAssert): Promise<void>;
        hook(name: 'evaluate', callback: (event: { readonly action: string; readonly resources: readonly string[]; effect: 'allow' | 'ask' | 'deny'; message?: string }) => void | Promise<void>): Promise<Registration>;
    };
    /** Durable JSON values, the plugin's own. */
    storage: { get(key: string): Promise<unknown>; set(key: string, value: Record<string, unknown>): Promise<void> };
    event: { subscribe(options?: { types?: string[]; signal?: AbortSignal }): AsyncIterable<{ type: string; data?: unknown }> };
    session: {
        get(input: { sessionID: string }): Promise<unknown>;
        synthetic(input: SyntheticInput): Promise<{ id: string }>;
        hook(name: 'prompt', callback: (event: SessionPromptHook) => void | Promise<void>): Promise<Registration>;
    };
};

export type Plugin = { id: string; setup(ctx: Context): Promise<(() => Promise<void> | void) | void> };
