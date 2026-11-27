import { setTimeout as delay } from 'node:timers/promises';
import { EventsConnection, type Occurrence } from '../../core/src/events-client.ts';

export async function nextOccurrence(url: string, source: string, name: string, signal: AbortSignal): Promise<Occurrence | undefined> {
    const wire = new EventsConnection(source, { url });
    const stop = () => { void wire.close(); };
    signal.addEventListener('abort', stop, { once: true });
    try {
        signal.throwIfAborted();
        await wire.connect(10000);
        signal.throwIfAborted();
        if (!(await wire.list()).some(e => e.name === name && e.delivery.includes('poll'))) throw Error('This source does not advertise this event for polling.');
        const started = Date.now();
        let cursor: string | null = null;
        // Ignore replayed occurrences older than this watch, including on the initial poll.
        while (!signal.aborted) {
            const page = await wire.poll({ name, arguments: {}, cursor, maxEvents: 1 });
            signal.throwIfAborted();
            const match = page.events.find(e => e.name === name && e.eventId && Date.parse(e.timestamp) >= started);
            if (match) return match;
            if (typeof page.cursor !== 'string' || !page.cursor) throw Error('No usable cursor from publisher.');
            cursor = page.cursor;
            await delay(Math.min(2147483647, Math.max(1000, page.nextPollMs ?? 5000)), undefined, { signal });
        }
    } finally {
        signal.removeEventListener('abort', stop);
        await wire.close();
    }
}
