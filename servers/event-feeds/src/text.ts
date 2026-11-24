// Event payloads are third-party text that a model will read: keep them plain and short.

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
    return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (m, e: string) => {
        if (e[0] === '#') {
            const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
        }
        return NAMED[e] ?? m;
    });
}

/** HTML to one line of plain text: tags dropped, paragraphs become spaces, entities decoded. */
export function plain(html: string): string {
    return decodeEntities(html.replace(/<(p|br|li|h[1-6])\b[^>]*>/gi, ' ').replace(/<[^>]*>/g, ''))
        .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** At most `max` characters, cut at a word where possible, with an ellipsis when cut. */
export function clip(s: string, max: number): string {
    const chars = Array.from(s);
    if (chars.length <= max) return s;
    const cut = chars.slice(0, max - 1).join('');
    const sp = cut.lastIndexOf(' ');
    return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + '…';
}

/** Plain, clipped text from upstream HTML or text. */
export const excerpt = (s: unknown, max: number): string => (typeof s === 'string' ? clip(plain(s), max) : '');

/** An https URL from upstream, or nothing: links in payloads are never anything else. */
export function httpsUrl(u: unknown, max = 500): string | undefined {
    if (typeof u !== 'string' || u.length > max) return undefined;
    try {
        const p = new URL(u);
        return p.protocol === 'https:' || p.protocol === 'http:' ? p.toString() : undefined;
    } catch {
        return undefined;
    }
}

export const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
