// The plugin's one tool, read_resource_link, apart from the MCP plumbing: which
// session is asking, whether the link may be read (core), the question for a
// cross-server read, the read through Codex, and what the model gets back.

import { contentsOf, decide, present, type Block } from '../../core/src/links.ts';
import { oneLine } from '../../core/src/untrusted.ts';
import type { Reader } from './appserver.ts';
import { readNotes } from './notes.ts';

/** The person's answer to a question, or why there was none. */
export type Asked = { yes: boolean } | { unavailable: string };
export type Ask = (message: string) => Promise<Asked>;
export type Answer = { content: Block[]; isError?: boolean };

export type Session = { thread?: string; session?: string };

export class App {
    private readonly o: { state: string; reader: Reader; log?: (line: string) => void };
    constructor(o: { state: string; reader: Reader; log?: (line: string) => void }) {
        this.o = o;
    }

    private log(line: string) {
        this.o.log?.(line);
    }

    async readResourceLink(args: unknown, session: Session, ask: Ask): Promise<Answer> {
        const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
        const server = typeof a.server === 'string' ? a.server.trim() : '';
        const uri = typeof a.uri === 'string' ? a.uri.trim() : '';
        if (!server || !uri) return fail('read_resource_link needs `server` (the MCP server, by its name in Codex\'s config) and `uri` (the link\'s URI).');
        const ids = [...new Set([session.thread, session.session].filter((x): x is string => typeof x === 'string'))];
        if (!ids.length) return fail('Codex did not say which session this call is from, so the links noted for it cannot be found. Nothing is read.');
        const noted = ids.flatMap((id) => readNotes(this.o.state, id));
        if (!noted.length)
            return fail(
                `No tool has returned a resource_link in this session, as far as the plugin has seen, so ${oneLine(uri, 300)} is not read from ${oneLine(server, 80)}. This tool reads only resources a tool linked to; a resource a server lists can be read with Codex's own read_mcp_resource. If a tool did return this link, the plugin's hook has not run: Codex runs it only once the user trusts it (the "Hooks need review" question when Codex starts, or /hooks).`,
            );
        const d = decide(noted, server, uri);
        if (d.kind === 'refuse') {
            this.log(`refused ${uri} from ${server}: ${d.reason}`);
            return fail(d.reason);
        }
        if (d.kind === 'ask') {
            const answer = await ask(d.question);
            if (!('yes' in answer) || !answer.yes) {
                const why = 'yes' in answer ? 'The user did not allow it (or Codex declined the question, as it does in codex exec)' : `The user could not be asked (${answer.unavailable})`;
                this.log(`cross-server read of ${uri} from ${server}: ${'yes' in answer ? 'no' : answer.unavailable}`);
                return fail(`${why}, so ${oneLine(uri, 300)} is not read from ${oneLine(server, 80)}: the link came from ${oneLine(d.link.server, 80)}, a different server.`);
            }
            this.log(`cross-server read of ${uri} from ${server}: the user said yes`);
        }
        const r = await this.o.reader.read(d.from, uri, session.thread);
        if ('error' in r) {
            this.log(`read of ${uri} from ${d.from} failed: ${r.error}`);
            return fail(`Codex could not read ${oneLine(uri, 300)} from the MCP server ${oneLine(d.from, 80)}: ${r.error}`);
        }
        const contents = contentsOf(r.contents);
        if (!contents) return fail(`The MCP server ${oneLine(d.from, 80)} answered the read of ${oneLine(uri, 300)} with something that is not a resources/read result.`);
        this.log(`read ${uri} from ${d.from} through ${r.via}: ${contents.length} content(s)`);
        return { content: present(d.from, contents) };
    }
}

const fail = (text: string): Answer => ({ content: [{ type: 'text', text }], isError: true });
