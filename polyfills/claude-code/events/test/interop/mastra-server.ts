// An MCP server built with Mastra (@mastra/mcp 2.10.0), whose Events support
// is its own implementation of SEP-3415 (not this plugin's, not the fixture's).
// It emits a Mastra event for every line appended to MASTRA_UPSTREAM.
import { MCPServer, defineEvent } from '@mastra/mcp';
import { existsSync, readFileSync, writeFileSync, watchFile } from 'node:fs';
import { z } from 'zod';

const upstream = process.env.MASTRA_UPSTREAM!;
if (!existsSync(upstream)) writeFileSync(upstream, '');

const server = new MCPServer({
    id: 'mastra-tickets',
    name: 'Mastra tickets',
    version: '1.0.0',
    tools: {},
    events: {
        'ticket.created': defineEvent({
            description: 'A ticket was created (Mastra).',
            inputSchema: z.object({ project: z.string().optional() }),
            payloadSchema: z.object({ id: z.string(), project: z.string(), title: z.string() }),
            match: (args: { project?: string }, data: { project: string }) => !args.project || data.project === args.project
        })
    }
});

let seen = readFileSync(upstream, 'utf8').split('\n').filter(Boolean).length;
watchFile(upstream, { interval: 150 }, () => {
    const lines = readFileSync(upstream, 'utf8').split('\n').filter(Boolean);
    for (; seen < lines.length; seen++) void server.events.emit('ticket.created', JSON.parse(lines[seen]!));
});

await server.startStdio();
