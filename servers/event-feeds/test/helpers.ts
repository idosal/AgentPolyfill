// Test helpers: recorded upstream responses (test/fixtures, recorded 2026-11-24) served by a fake
// loader, so that no test makes a live call.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Loaded, Loader } from '../src/source.ts';

const dir = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const fixtureText = (name: string) => readFileSync(dir + name, 'utf8');
export const fixtureJson = <T = unknown>(name: string): T => JSON.parse(fixtureText(name)) as T;

/** A loader whose answers are set per URL prefix; it records every URL asked for. */
export function fakeLoader(routes: Record<string, unknown | (() => Loaded)>, presses: Record<string, unknown> = {}) {
    const asked: string[] = [];
    const answer = (url: string): Loaded => {
        asked.push(url);
        const key = Object.keys(routes).find((k) => url.startsWith(k));
        if (key === undefined) return { ok: false, why: 'unavailable' };
        const v = routes[key];
        return typeof v === 'function' ? (v as () => Loaded)() : { ok: true, body: v };
    };
    const loader: Loader = {
        json: async (url) => answer(url),
        text: async (url) => answer(url),
        presses: async (ch) => (ch in presses ? { ok: true, body: presses[ch] } : { ok: false, why: 'not_found' })
    };
    return { loader, asked };
}

export type Hit = { objectID: string; created_at_i: number; [k: string]: unknown };
/** An Algolia page made of some of the recorded hits (newest first, as Algolia sorts). */
export const algoliaPage = (hits: Hit[]) => ({ hits: [...hits].sort((a, b) => b.created_at_i - a.created_at_i) });

export const decode = (cursor: string) => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
