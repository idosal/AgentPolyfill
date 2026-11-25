import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivate } from '../../../server-cards/antigravity/src/gate.ts';

// Which MCP servers' skills a conversation has loaded, for rule X8. The MCP server records a load
// only after it redeemed the hook's ticket for it; the hook reads it to ask about a resource read
// from any other server. It holds server labels only, by a hash of the conversation id.

const fileOf = (dir: string, conversationId: string) => join(dir, 'held', `${createHash('sha256').update(conversationId).digest('hex')}.json`);

export function heldServers(dir: string, conversationId: string): string[] {
    try {
        const v: unknown = JSON.parse(readFileSync(fileOf(dir, conversationId), 'utf8')).servers;
        return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
    } catch { return []; }
}

export function recordHeld(dir: string, conversationId: string, server: string) {
    if (!conversationId) return;
    const servers = [...new Set([...heldServers(dir, conversationId), server])];
    mkdirSync(join(dir, 'held'), { recursive: true, mode: 0o700 });
    writePrivate(fileOf(dir, conversationId), JSON.stringify({ servers }));
}
