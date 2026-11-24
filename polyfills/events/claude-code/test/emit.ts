// Appends one event to a fixture upstream file.
//   node --no-warnings test/emit.ts <upstream.jsonl> <event-name> '<data json>' [eventId]
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const [file, name, data, id] = process.argv.slice(2);
if (!file || !name) {
    console.error('usage: emit.ts <upstream.jsonl> <event-name> <data-json> [eventId]');
    process.exit(2);
}
const event = { eventId: id ?? `evt_${randomUUID().slice(0, 8)}`, name, timestamp: new Date().toISOString(), data: JSON.parse(data ?? '{}') };
appendFileSync(file, JSON.stringify(event) + '\n');
console.log(event.eventId);
