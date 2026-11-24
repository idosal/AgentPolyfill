// Earthquakes, from the USGS real-time GeoJSON summary feed for the past hour
// (https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php), which USGS regenerates every minute.
// Worldwide that is about ten a day of magnitude 4 or more, and a few an hour of any size.

import { ArgError, num, object } from '../args.ts';
import type { Snapshot } from '../snapshot.ts';
import type { Source } from '../source.ts';
import { iso } from '../text.ts';

const FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson';
const HOUR = 3_600_000;
/** USGS often publishes an event minutes after it happens: what the feed shows is complete back to here. */
const SAFETY = 15 * 60_000;

type Args = { minMagnitude: number; near?: { lat: number; lon: number; radiusKm: number } };

function km(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const r = Math.PI / 180;
    const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

type Feature = { id?: unknown; properties?: Record<string, unknown>; geometry?: { coordinates?: unknown } };

export const usgsEarthquake: Source<Args> = {
    name: 'usgs.earthquake',
    k: 'eq',
    description:
        'An earthquake recorded by the US Geological Survey, anywhere in the world, at or above a magnitude (`minMagnitude`, default 2.5), optionally only within `radiusKm` of a point (`latitude`, `longitude`). ' +
        'Use it for "tell me if there is an earthquake near Tokyo", "watch for magnitude 5+ quakes". Worldwide there are a few an hour of any size (use minMagnitude 0 to see one soon), about ten a day of 4 or more. ' +
        'Checked about every 60 seconds; a quake usually arrives within a few minutes of USGS publishing it. An event carries numbers and a link: read the place name with the read_event_text tool.',
    inputSchema: {
        type: 'object',
        properties: {
            minMagnitude: { type: 'number', minimum: -1, maximum: 10, default: 2.5, description: 'Smallest magnitude to report.' },
            latitude: { type: 'number', minimum: -90, maximum: 90, description: 'With longitude and radiusKm: only near this point.' },
            longitude: { type: 'number', minimum: -180, maximum: 180 },
            radiusKm: { type: 'number', minimum: 1, maximum: 20000, description: 'Distance from the point, in kilometres.' }
        },
        additionalProperties: false
    },
    payloadSchema: {
        type: 'object',
        properties: {
            id: { type: 'string', pattern: '^[a-z0-9]{2,40}$', description: 'USGS event id. The place name: read_event_text.' },
            magnitude: { type: 'number' },
            time: { type: 'string', format: 'date-time', description: 'When it happened.' },
            latitude: { type: 'number' },
            longitude: { type: 'number' },
            depthKm: { type: 'number' },
            distanceKm: { type: 'number', description: 'From the point given, when one was.' },
            tsunami: { type: 'boolean', description: 'USGS flagged it for tsunami information.' },
            status: { type: 'string', enum: ['automatic', 'reviewed'] },
            url: { type: 'string', format: 'uri' }
        },
        required: ['id', 'magnitude', 'time', 'latitude', 'longitude', 'url'],
        additionalProperties: false
    },
    nextPollMs: 60_000,
    parse(raw) {
        const o = object(raw, ['minMagnitude', 'latitude', 'longitude', 'radiusKm']);
        const minMagnitude = num(o, 'minMagnitude', -1, 10, 'a magnitude') ?? 2.5;
        const lat = num(o, 'latitude', -90, 90, 'degrees north');
        const lon = num(o, 'longitude', -180, 180, 'degrees east');
        const radiusKm = num(o, 'radiusKm', 1, 20000, 'kilometres');
        const given = [lat, lon, radiusKm].filter((x) => x !== undefined).length;
        if (given !== 0 && given !== 3) throw new ArgError('give latitude, longitude and radiusKm together, or none of them', { argument: 'radiusKm' });
        return { minMagnitude, ...(given === 3 ? { near: { lat: lat!, lon: lon!, radiusKm: radiusKm! } } : {}) };
    },
    load: (_a, l) => l.json(FEED, 55),
    snapshot(body, a, now): Snapshot {
        const fc = body as { type?: unknown; metadata?: { generated?: unknown }; features?: unknown };
        if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) throw new Error('not a GeoJSON feed');
        const generated = typeof fc.metadata?.generated === 'number' ? fc.metadata.generated : now;
        const items = [];
        for (const f of fc.features as Feature[]) {
            const p = f.properties ?? {};
            const c = Array.isArray(f.geometry?.coordinates) ? (f.geometry!.coordinates as unknown[]) : [];
            const [lon, lat, depth] = c as number[];
            if (typeof f.id !== 'string' || !/^[a-z0-9]{2,40}$/.test(f.id) || typeof p.mag !== 'number' || typeof p.time !== 'number' || p.type !== 'earthquake') continue;
            if (typeof lat !== 'number' || typeof lon !== 'number') continue;
            if (p.mag < a.minMagnitude) continue;
            const d = a.near ? km(a.near.lat, a.near.lon, lat, lon) : undefined;
            if (d !== undefined && d > a.near!.radiusKm) continue;
            items.push({
                id: f.id,
                ts: p.time,
                occurrence: {
                    eventId: f.id,
                    name: 'usgs.earthquake',
                    timestamp: iso(p.time),
                    data: {
                        id: f.id,
                        magnitude: Math.round(p.mag * 100) / 100,
                        time: iso(p.time),
                        latitude: lat,
                        longitude: lon,
                        ...(typeof depth === 'number' ? { depthKm: Math.round(depth * 10) / 10 } : {}),
                        ...(d !== undefined ? { distanceKm: Math.round(d) } : {}),
                        tsunami: p.tsunami === 1,
                        ...(p.status === 'automatic' || p.status === 'reviewed' ? { status: p.status } : {}),
                        url: `https://earthquake.usgs.gov/earthquakes/eventpage/${f.id}`
                    }
                }
            });
        }
        // The feed covers the past hour by the time an event happened; allow for USGS publishing late.
        // The watermark is when the feed was generated: the subscription has seen everything up to then.
        return { items, covers: generated - HOUR + SAFETY, watermark: generated };
    },
    notFound: () => 'the USGS feed is not available'
};
