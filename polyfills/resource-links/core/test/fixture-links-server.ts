// A small MCP server, written by hand over stdio, whose tools return
// `resource_link` content blocks (MCP 2025-06-18 and later, "Tools > Tool
// Result > Resource Links"). It shares no code with the polyfill, so the
// polyfill is tested against something it did not write, and it is the server
// behind the host probes in ../probe.
//
// Each linked resource holds a marker (a word that appears nowhere else), so a
// test or a probe can tell whether the linked contents reached the model.
//
// None of the linked resources is in resources/list except `listed.txt`: the
// spec says linked resources need not be listed.
//
// Env:
//   FIXTURE_NAME   what the server calls itself and the URI authority it serves (default "docs")
//   FIXTURE_PEER   the authority of another fixture, linked by `peer_link` (default "other")
//   FIXTURE_LOG    append one JSON line per message received (optional)
//   FIXTURE_BIG    size in bytes of `big.txt` (default 3 MiB)
//   FIXTURE_REV    the protocol revision to answer with (default: the client's, if known)

import { appendFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { deflateSync } from 'node:zlib';

type Json = Record<string, unknown>;
const NAME = process.env.FIXTURE_NAME || 'docs';
const PEER = process.env.FIXTURE_PEER || 'other';
const LOG = process.env.FIXTURE_LOG;
const BIG = Number(process.env.FIXTURE_BIG || 3 * 1024 * 1024);
const REVISIONS = ['2025-06-18', '2025-11-25'];
const send = (m: Json) => process.stdout.write(JSON.stringify(m) + '\n');

// A PNG drawn here: the left half blue, the right half yellow.
function crc32(buf: Buffer): number {
    let c = ~0;
    for (const b of buf) {
        c ^= b;
        for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
export function twoColourPng(w = 256, h = 128): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // RGB
    const rows: Buffer[] = [];
    for (let y = 0; y < h; y++) {
        const row = Buffer.alloc(1 + w * 3);
        for (let x = 0; x < w; x++) row.set(x < w / 2 ? [0x1f, 0x4f, 0xff] : [0xff, 0xd8, 0x00], 1 + x * 3);
        rows.push(row);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(Buffer.concat(rows))),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

const base = `fixture://${NAME}`;
type Res = { text?: string; blob?: string; mimeType: string; name: string; title?: string; description?: string; annotations?: Json };
const RESOURCES: Record<string, Res> = {
    [`${base}/report.txt`]: {
        name: 'report.txt',
        title: 'Quarterly report',
        description: 'The full text of the report the tool summarised',
        mimeType: 'text/plain',
        text: `Quarterly report (${NAME}).\nThe secret word for this report is MARKER-TEXT-${NAME.toUpperCase()}-OCTARINE.\nRevenue rose 12 percent.\n`,
    },
    [`${base}/chart.png`]: {
        name: 'chart.png',
        title: 'Revenue chart',
        description: 'A chart of the report, as a PNG image',
        mimeType: 'image/png',
        blob: twoColourPng().toString('base64'),
    },
    [`${base}/data.bin`]: {
        name: 'data.bin',
        description: 'Raw export of the figures',
        mimeType: 'application/octet-stream',
        blob: Buffer.from(Array.from({ length: 256 }, (_, i) => i)).toString('base64'),
    },
    [`${base}/private.txt`]: {
        name: 'private.txt',
        description: 'Notes meant for the user, not the model',
        mimeType: 'text/plain',
        annotations: { audience: ['user'] },
        text: `Private notes (${NAME}). MARKER-PRIVATE-${NAME.toUpperCase()}-UMBER.\n`,
    },
    [`${base}/big.txt`]: {
        name: 'big.txt',
        description: 'A very large text resource',
        mimeType: 'text/plain',
        text: `MARKER-BIG-${NAME.toUpperCase()} ` + 'x'.repeat(Math.max(0, BIG - 20)),
    },
    [`${base}/note.txt`]: {
        name: 'note.txt',
        description: `A note that only the ${NAME} server serves`,
        mimeType: 'text/plain',
        text: `A note from ${NAME}. MARKER-NOTE-${NAME.toUpperCase()}-VIRIDIAN.\n`,
    },
    [`${base}/listed.txt`]: { name: 'listed.txt', mimeType: 'text/plain', text: `Listed (${NAME}).\n` },
};

const link = (uri: string, extra: Json = {}): Json => {
    const r = RESOURCES[uri];
    const size = r ? Buffer.byteLength(r.text ?? '') || Buffer.from(r.blob ?? '', 'base64').length : undefined;
    return {
        type: 'resource_link',
        uri,
        name: r?.name ?? uri.split('/').pop(),
        ...(r?.title ? { title: r.title } : {}),
        ...(r?.description ? { description: r.description } : {}),
        ...(r?.mimeType ? { mimeType: r.mimeType } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(r?.annotations ? { annotations: r.annotations } : {}),
        ...extra,
    };
};

const TOOLS: Record<string, { description: string; content: () => Json[] }> = {
    text_link: { description: 'Summarise the quarterly report. Returns a link to its full text.', content: () => [{ type: 'text', text: 'The report is ready. Its full text is linked.' }, link(`${base}/report.txt`)] },
    image_link: { description: 'Draw the revenue chart. Returns a link to a PNG.', content: () => [{ type: 'text', text: 'The chart is ready.' }, link(`${base}/chart.png`)] },
    binary_link: { description: 'Export the raw figures. Returns a link to a binary file.', content: () => [{ type: 'text', text: 'The export is ready.' }, link(`${base}/data.bin`)] },
    user_only_link: { description: 'Prepare notes for the user. Returns a link meant for the user only.', content: () => [{ type: 'text', text: 'The notes are ready.' }, link(`${base}/private.txt`)] },
    big_link: { description: 'Return a link to a very large text resource.', content: () => [{ type: 'text', text: 'The dump is ready.' }, link(`${base}/big.txt`)] },
    peer_link: {
        description: `Return a link to a note that another server (${PEER}) serves, not this one.`,
        content: () => [
            { type: 'text', text: `The note is on the ${PEER} server.` },
            { type: 'resource_link', uri: `fixture://${PEER}/note.txt`, name: 'note.txt', description: `A note that only the ${PEER} server serves`, mimeType: 'text/plain' },
        ],
    },
    missing_link: { description: 'Return a link to a resource that does not exist.', content: () => [{ type: 'text', text: 'Linked.' }, { type: 'resource_link', uri: `${base}/gone.txt`, name: 'gone.txt', mimeType: 'text/plain' }] },
    image_inline: { description: 'Draw the revenue chart and return the image itself (for comparison with a link).', content: () => [{ type: 'image', data: RESOURCES[`${base}/chart.png`].blob, mimeType: 'image/png' }] },
    embedded_image: {
        description: 'Return the chart embedded in the result as a resource (for comparison with a link).',
        content: () => [{ type: 'resource', resource: { uri: `${base}/chart.png`, mimeType: 'image/png', blob: RESOURCES[`${base}/chart.png`].blob } }],
    },
    embedded: {
        description: 'Return the report embedded in the result (for comparison with a link).',
        content: () => {
            const r = RESOURCES[`${base}/report.txt`];
            return [{ type: 'resource', resource: { uri: `${base}/report.txt`, mimeType: r.mimeType, text: r.text } }];
        },
    },
};

function handle(m: Json): void {
    if (LOG) appendFileSync(LOG, JSON.stringify({ at: Date.now(), server: NAME, method: m.method, params: m.params }) + '\n');
    const id = m.id as string | number | undefined;
    const p = (m.params ?? {}) as Json;
    const reply = (result: Json) => id !== undefined && send({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
    switch (m.method) {
        case 'initialize': {
            const asked = typeof p.protocolVersion === 'string' ? p.protocolVersion : '';
            const rev = process.env.FIXTURE_REV || (REVISIONS.includes(asked) ? asked : REVISIONS[REVISIONS.length - 1]);
            return void reply({ protocolVersion: rev, capabilities: { tools: {}, resources: {} }, serverInfo: { name: NAME, version: '1.0.0' } });
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
            return;
        case 'ping':
            return void reply({});
        case 'tools/list':
            return void reply({ tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } })) });
        case 'tools/call': {
            const t = TOOLS[String(p.name)];
            if (!t) return void fail(-32602, `Unknown tool: ${String(p.name)}`);
            return void reply({ content: t.content() });
        }
        case 'resources/list':
            return void reply({ resources: [{ uri: `${base}/listed.txt`, name: 'listed.txt', mimeType: 'text/plain' }] });
        case 'resources/templates/list':
            return void reply({ resourceTemplates: [] });
        case 'resources/read': {
            const uri = String(p.uri);
            const r = RESOURCES[uri];
            if (!r) return void fail(-32002, 'Resource not found');
            return void reply({ contents: [{ uri, mimeType: r.mimeType, ...(r.text !== undefined ? { text: r.text } : { blob: r.blob }) }] });
        }
        default:
            if (id !== undefined) fail(-32601, 'Method not found');
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    createInterface({ input: process.stdin }).on('line', (line) => {
        if (!line.trim()) return;
        let m: Json;
        try {
            m = JSON.parse(line) as Json;
        } catch {
            return;
        }
        handle(m);
    });
}
