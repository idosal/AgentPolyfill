// How many new mailboxes this relay has opened in the current hour: one object for the whole
// relay, asked only when a mailbox is opened for the first time. It exists so that a relay anyone
// may use has a ceiling on what it can be made to store, whoever is asking and from wherever.
//
// It keeps a count for the hour, and a count per sender under a hash salted with a value made for
// that hour. Both are deleted when the hour is over.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index.ts';

/** `all`: the relay has opened as many as it will this hour. `sender`: this sender has. */
export type Admission = 'yes' | 'all' | 'sender';

const HOUR_MS = 3600 * 1000;

export class Registry extends DurableObject<Env> {
    /** Counts one new mailbox for this hour, if both ceilings allow it. A ceiling of 0 is no ceiling. */
    async admit(sender: string, most: number, mostPerSender: number): Promise<Admission> {
        const sql = this.ctx.storage.sql;
        sql.exec(`
            CREATE TABLE IF NOT EXISTS hours (hour INTEGER PRIMARY KEY, salt TEXT NOT NULL, n INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS senders (hour INTEGER NOT NULL, who TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (hour, who));
        `);
        const hour = Math.floor(Date.now() / HOUR_MS);
        sql.exec('DELETE FROM hours WHERE hour <> ?', hour);
        sql.exec('DELETE FROM senders WHERE hour <> ?', hour);
        let row = sql.exec<{ salt: string; n: number }>('SELECT salt, n FROM hours WHERE hour = ?', hour).toArray()[0];
        if (!row) {
            row = { salt: crypto.randomUUID(), n: 0 };
            sql.exec('INSERT INTO hours (hour, salt, n) VALUES (?, ?, 0)', hour, row.salt);
        }
        if (most > 0 && row.n >= most) return 'all';
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${row.salt}\n${sender}`)));
        const who = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
        // Read again after the wait above: another request may have been counted meanwhile.
        const total = sql.exec<{ n: number }>('SELECT n FROM hours WHERE hour = ?', hour).toArray()[0]?.n ?? 0;
        if (most > 0 && total >= most) return 'all';
        const mine = sql.exec<{ n: number }>('SELECT n FROM senders WHERE hour = ? AND who = ?', hour, who).toArray()[0]?.n ?? 0;
        if (mostPerSender > 0 && mine >= mostPerSender) return 'sender';
        sql.exec('UPDATE hours SET n = n + 1 WHERE hour = ?', hour);
        sql.exec('INSERT INTO senders (hour, who, n) VALUES (?, ?, 1) ON CONFLICT (hour, who) DO UPDATE SET n = n + 1', hour, who);
        return 'yes';
    }
}
