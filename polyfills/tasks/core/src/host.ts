type Json = Record<string, unknown>;

export type ToolSpec = { name: string; title?: string; description: string; inputSchema: Json; annotations?: Json };
/** A tool's answer: text of this plugin's own, then content blocks a server sent (shown as data). */
export type ToolAnswer = { text: string; content?: Json[]; isError?: boolean };
/** What the person did with a form, as the host reported it, or why nobody could be asked. */
export type FormAnswer = { action: 'accept' | 'decline' | 'cancel'; content?: Json } | { unavailable: string };
/** Puts a form to the person through the host. */
export type AskForm = (message: string, requestedSchema: Json, kind: 'start' | 'confirm' | 'input', originalSchema?: Json) => Promise<FormAnswer>;
export type CallContext = { ask: AskForm; meta: Json; /** The MCP revision used to express titled choices. */ revision: string; signal?: AbortSignal; toolAllowed?: (server: string, tool: string) => boolean };
