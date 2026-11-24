// Server text in the polyfill's own words: one line, bounded, no control or direction characters.

// C0 and C1 controls, line and paragraph separators, zero-width and bidirectional controls.
const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]+', 'g');

/** One line of at most `max` characters, for quoting server text (a URI, a name, an error). */
export function oneLine(s: unknown, max = 200): string {
    const t = String(s ?? '')
        .replace(UNSAFE, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** An error as one line, for the model or the log. */
export function describeError(e: unknown): string {
    return oneLine(e instanceof Error ? e.message : e, 300);
}
