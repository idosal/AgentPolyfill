// SEP-3415, "Streamable HTTP: Routing Headers".
//
// Over Streamable HTTP, `events/poll`, `events/stream`, `events/subscribe` and
// `events/unsubscribe` carry the event name in an `Mcp-Name` header, and each
// subscription argument whose `inputSchema` property is annotated `x-mcp-header`
// in an `Mcp-Param-{Name}` header, so that intermediaries can route without
// reading the body. The rules are the transport's own (SEP-2243, as for
// `tools/call`); the MCP SDK applies them to tools only, so they are applied to
// events here, the same way.

export const ROUTED_METHODS = new Set(['events/poll', 'events/stream', 'events/subscribe', 'events/unsubscribe']);

/** One annotated argument: where its value is in `arguments`, and the header it is mirrored into. */
export type HeaderDeclaration = { path: string[]; header: string };

/** RFC 9110 `token`: what a header name may be made of. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const TYPES = new Set(['string', 'integer', 'boolean']);
/** Places a schema can hold another schema that is not a plain property: an annotation there is invalid. */
const ELSEWHERE = ['items', 'additionalItems', 'prefixItems', 'contains', 'contentSchema', 'dependencies', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'patternProperties', 'dependentSchemas', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', '$defs', 'definitions'];
const KEYED = new Set(['patternProperties', 'dependentSchemas', 'dependencies', '$defs', 'definitions']);

/**
 * Finds the `x-mcp-header` annotations in an event type's `inputSchema` and checks them against the
 * transport's constraints: only on properties reached through `properties`, a non-empty header
 * token, on a string, integer or boolean, and no two the same but for case. A client must leave an
 * event type whose annotations break them out of what `events/list` returned.
 */
export function scanHeaders(inputSchema: unknown): { declarations: HeaderDeclaration[] } | { invalid: string } {
    const declarations: HeaderDeclaration[] = [];
    const seen = new Set<string>();
    let budget = 5000;
    const visit = (node: unknown, path: string[], reachable: boolean): string | undefined => {
        if (node === null || typeof node !== 'object') return undefined;
        if (--budget < 0) return 'the schema is too large to check';
        const schema = node as Record<string, unknown>;
        if ('x-mcp-header' in schema) {
            const at = path.join('.') || '(the schema itself)';
            const raw = schema['x-mcp-header'];
            if (!reachable || path.length === 0) return `${at}: the annotation is only allowed on a property reached through "properties"`;
            if (typeof raw !== 'string' || !TOKEN.test(raw)) return `${at}: the annotation is not a valid header name`;
            if (typeof schema.type !== 'string' || !TYPES.has(schema.type)) return `${at}: the annotation is only allowed on a string, integer or boolean`;
            if (seen.has(raw.toLowerCase())) return `${at}: the same header is named twice`;
            seen.add(raw.toLowerCase());
            declarations.push({ path, header: raw });
        }
        const properties = schema.properties;
        if (properties !== null && typeof properties === 'object') {
            for (const [key, child] of Object.entries(properties)) {
                const fault = visit(child, [...path, key], reachable);
                if (fault) return fault;
            }
        }
        for (const k of ELSEWHERE) {
            const sub = schema[k];
            if (sub === undefined) continue;
            const branches = Array.isArray(sub) ? sub : sub !== null && typeof sub === 'object' && KEYED.has(k) ? Object.values(sub) : [sub];
            for (const branch of branches) {
                const fault = visit(branch, [...path, `<${k}>`], false);
                if (fault) return fault;
            }
        }
        return undefined;
    };
    const fault = visit(inputSchema, [], true);
    return fault ? { invalid: fault } : { declarations };
}

/**
 * A value as an HTTP header value: as it is when it is printable ASCII (0x20 to 0x7E) with no surrounding space, and
 * otherwise in the transport's Base64 form, `=?base64?<base64 of its UTF-8>?=`.
 */
export function encodeHeaderValue(value: string): string {
    const plain = value.length > 0 && value === value.trim() && !(value.startsWith('=?base64?') && value.endsWith('?=')) && /^[\x20-\x7e]*$/.test(value);
    return plain ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function asText(v: unknown): string | undefined {
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number' && Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v))) return String(v);
    return undefined;
}

/** `Mcp-Param-{Name}` for each annotated argument that has a value. */
export function paramHeaders(declarations: HeaderDeclaration[], args: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    for (const d of declarations) {
        let v: unknown = args;
        for (const key of d.path) v = v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
        const text = v === undefined || v === null ? undefined : asText(v);
        if (text !== undefined) out[`Mcp-Param-${d.header}`] = encodeHeaderValue(text);
    }
    return out;
}

/**
 * The routing headers one outgoing JSON-RPC request needs, from its own body: none unless it is
 * one of the four requests that name an event. `declarationsOf` gives the annotations of an event
 * type, as last listed.
 */
export function routingHeaders(body: unknown, declarationsOf: (event: string) => HeaderDeclaration[] | undefined): Record<string, string> {
    const m = body as { method?: unknown; params?: { name?: unknown; arguments?: unknown } } | null;
    if (!m || typeof m !== 'object' || typeof m.method !== 'string' || !ROUTED_METHODS.has(m.method) || typeof m.params?.name !== 'string') return {};
    return { 'Mcp-Name': encodeHeaderValue(m.params.name), ...paramHeaders(declarationsOf(m.params.name) ?? [], m.params.arguments) };
}
