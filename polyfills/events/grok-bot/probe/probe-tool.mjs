import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export const batchFormat = /^[a-f0-9]{32}\.e1-e1$/;

export function probeTools(batch, receipt, versionHeader, log) {
    const mcp = new McpServer({ name: 'grok-events-probe', version: '0.1.0' });
    mcp.registerTool('read_batch', {
        description: 'Read the synthetic test batch supplied by the webhook and report its receipt.',
        inputSchema: { batch: z.string().regex(batchFormat) },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, ({ batch: requested }) => {
        if (requested !== batch) return { isError: true, content: [{ type: 'text', text: 'Unknown test batch.' }] };
        const version = versionHeader;
        const protocolVersion = /^\d{4}-\d{2}-\d{2}$/.test(version) ? version : null;
        log(JSON.stringify({ at: new Date().toISOString(), stage: 'read_batch', batch, receipt, protocolVersion }));
        return { content: [{ type: 'text', text: JSON.stringify({ batch, receipt }) }] };
    });
    return mcp;
}
