// A Hermes form helper's line to its plugin: newline-delimited JSON-RPC 2.0 over the
// helper's standard input and output, requests both ways.
//
// The plugin (Python, inside the Hermes gateway; tools/hermes/shared/_helper.py) starts the
// helper and asks it things (`initialize`, `call`, ...); the helper may ask the plugin things
// back (the Events helper's `wake`). Shared by the Hermes forms, which bundle it.

import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';

type Json = Record<string, unknown>;
export type Handler = (method: string, params: Json) => Promise<unknown>;

const MAX_LINE = 4 * 1024 * 1024;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export class RpcError extends Error {
    readonly code: number;
    constructor(code: number, message: string) {
        super(message);
        this.code = code;
    }
}

export class Bridge {
    #id = 0;
    #waiting = new Map<number, { done: (v: unknown) => void; fail: (e: Error) => void; timer: NodeJS.Timeout }>();
    #closed = false;
    readonly #output: Writable;
    onClose: () => void = () => {};

    constructor(handler: Handler, input: Readable = process.stdin, output: Writable = process.stdout, log: (s: string) => void = () => {}) {
        this.#output = output;
        output.on('error', () => this.#close());
        const lines = createInterface({ input, crlfDelay: Infinity });
        lines.on('line', (line) => {
            if (line.length > MAX_LINE) return log('a line from the plugin was too long and was dropped');
            let m: unknown;
            try {
                m = JSON.parse(line);
            } catch {
                return log('a line from the plugin was not JSON and was dropped');
            }
            if (!isObject(m)) return;
            if (typeof m.method === 'string') {
                const id = m.id;
                const answer = (body: Json) => (id === undefined ? undefined : this.#send({ id, ...body }));
                handler(m.method, isObject(m.params) ? m.params : {}).then(
                    (result) => answer({ result: result ?? null }),
                    (e: unknown) => answer({ error: { code: e instanceof RpcError ? e.code : -32603, message: e instanceof Error ? e.message : String(e) } })
                );
                return;
            }
            if (typeof m.id === 'number') {
                const w = this.#waiting.get(m.id);
                if (!w) return;
                this.#waiting.delete(m.id);
                clearTimeout(w.timer);
                if (isObject(m.error)) w.fail(new RpcError(Number(m.error.code ?? -32603), String(m.error.message ?? 'error')));
                else w.done(m.result);
            }
        });
        lines.on('close', () => this.#close());
    }

    /** Asks the plugin something. Rejects when it answers with an error, does not answer in time, or is gone. */
    request(method: string, params: Json, timeoutMs = 30000): Promise<unknown> {
        if (this.#closed) return Promise.reject(new Error('the plugin is gone'));
        const id = ++this.#id;
        return new Promise((done, fail) => {
            const timer = setTimeout(() => {
                this.#waiting.delete(id);
                fail(new Error(`the plugin did not answer ${method} in time`));
            }, timeoutMs);
            timer.unref?.();
            this.#waiting.set(id, { done, fail, timer });
            this.#send({ id, method, params });
        });
    }

    #send(m: Json): void {
        if (this.#closed) return;
        try {
            this.#output.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
        } catch {
            this.#close();
        }
    }

    #close(): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const w of this.#waiting.values()) {
            clearTimeout(w.timer);
            w.fail(new Error('the plugin is gone'));
        }
        this.#waiting.clear();
        this.onClose();
    }
}
