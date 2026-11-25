// What this relay has opened: one object for the whole relay, asked only when a mailbox is opened
// for the first time and when a mailbox gives its storage back. It exists so that a relay anyone
// may use has a ceiling on what it can be made to store, whoever is asking and from wherever:
//
//   - new mailboxes in the current hour, in all, per sender and per network (see limits.ts);
//   - mailboxes that exist now (`live`), however long ago they were opened. The hourly ceilings
//     bound how fast mailboxes appear; this bounds how many there are, and so what they can hold.
//
// The hour's counts are kept under hashes salted with a value made for that hour, and are deleted
// when the hour is over (by an alarm, so they do not wait for the next new mailbox). A live
// mailbox is kept as the hash of its name, never the name itself.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index.ts';

/** `all`: the relay has opened as many as it will this hour. `sender`, `network`: this sender, or its network, has. `full`: the relay holds as many mailboxes as it will. */
export type Admission = 'yes' | 'all' | 'sender' | 'network' | 'full';

export type Ceilings = { most: number; mostPerSender: number; mostPerNetwork: number; mostLive: number };

const HOUR_MS = 3600 * 1000;

async function hash(text: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    return [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class Registry extends DurableObject<Env> {
    #tables(): SqlStorage {
        const sql = this.ctx.storage.sql;
        sql.exec(`
            CREATE TABLE IF NOT EXISTS hours (hour INTEGER PRIMARY KEY, salt TEXT NOT NULL, n INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS senders (hour INTEGER NOT NULL, who TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (hour, who));
            CREATE TABLE IF NOT EXISTS live (mailbox TEXT PRIMARY KEY);
        `);
        return sql;
    }

    #forgetPastHours(sql: SqlStorage, hour: number): void {
        sql.exec('DELETE FROM hours WHERE hour <> ?', hour);
        sql.exec('DELETE FROM senders WHERE hour <> ?', hour);
    }

    /**
     * Counts one new mailbox, if every ceiling allows it. A ceiling of 0 is no ceiling. `mailbox` is
     * the new mailbox's name, kept (hashed) as live until `release`.
     */
    async admit(sender: string, network: string, mailbox: string, c: Ceilings): Promise<Admission> {
        const sql = this.#tables();
        const hour = Math.floor(Date.now() / HOUR_MS);
        this.#forgetPastHours(sql, hour);
        let row = sql.exec<{ salt: string; n: number }>('SELECT salt, n FROM hours WHERE hour = ?', hour).toArray()[0];
        if (!row) {
            row = { salt: crypto.randomUUID(), n: 0 };
            sql.exec('INSERT INTO hours (hour, salt, n) VALUES (?, ?, 0)', hour, row.salt);
        }
        // The past hour's counts go when it is over, even if no mailbox is opened after it.
        if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm((hour + 1) * HOUR_MS + 1000);
        if (c.most > 0 && row.n >= c.most) return 'all';
        const [who, net, name] = await Promise.all([hash(`${row.salt}\nsender\n${sender}`), hash(`${row.salt}\nnetwork\n${network}`), hash(`mailbox\n${mailbox}`)]);
        // Read again after the waits above: another request may have been counted meanwhile.
        const total = sql.exec<{ n: number }>('SELECT n FROM hours WHERE hour = ?', hour).toArray()[0]?.n ?? 0;
        if (c.most > 0 && total >= c.most) return 'all';
        const count = (k: string) => sql.exec<{ n: number }>('SELECT n FROM senders WHERE hour = ? AND who = ?', hour, k).toArray()[0]?.n ?? 0;
        if (c.mostPerSender > 0 && count(who) >= c.mostPerSender) return 'sender';
        if (c.mostPerNetwork > 0 && count(net) >= c.mostPerNetwork) return 'network';
        const known = sql.exec('SELECT 1 FROM live WHERE mailbox = ?', name).toArray().length > 0;
        if (!known && c.mostLive > 0 && sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM live').one().n >= c.mostLive) return 'full';
        sql.exec('UPDATE hours SET n = n + 1 WHERE hour = ?', hour);
        for (const k of new Set([who, net])) sql.exec('INSERT INTO senders (hour, who, n) VALUES (?, ?, 1) ON CONFLICT (hour, who) DO UPDATE SET n = n + 1', hour, k);
        sql.exec('INSERT INTO live (mailbox) VALUES (?) ON CONFLICT (mailbox) DO NOTHING', name);
        return 'yes';
    }

    /** A mailbox gave its storage back: it no longer counts as live. */
    async release(mailbox: string): Promise<void> {
        this.#tables().exec('DELETE FROM live WHERE mailbox = ?', await hash(`mailbox\n${mailbox}`));
    }

    async alarm(): Promise<void> {
        this.#forgetPastHours(this.#tables(), Math.floor(Date.now() / HOUR_MS));
    }
}
