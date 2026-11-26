import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AskForm } from '../../core/src/host.ts';
import { exact, secrets } from '../../core/src/untrusted.ts';

type Json = Record<string, unknown>;
const object = (x: unknown): x is Json => !!x && typeof x === 'object' && !Array.isArray(x);
const formRules = new Set(['type', 'properties', 'required', 'additionalProperties', '$schema']);
const fieldRules = new Set(['type', 'title', 'description', 'default', 'enum', 'enumNames', 'oneOf', 'anyOf', 'items', 'const', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'uniqueItems']);

function supported(field: unknown, depth = 0): boolean {
    if (!object(field) || depth > 2 || Object.keys(field).some((key) => !fieldRules.has(key))) return false;
    if (!['string', 'integer', 'number', 'boolean', 'array', undefined].includes(field.type as string | undefined)) return false;
    if (field.type === 'array' && !supported(field.items, depth + 1)) return false;
    return ['oneOf', 'anyOf'].every((key) => field[key] === undefined || (Array.isArray(field[key]) && field[key].every((option) => supported(option, depth + 1))));
}

function valid(value: unknown, field: Json): boolean {
    if ('const' in field && value !== field.const) return false;
    if (Array.isArray(field.enum) && !field.enum.includes(value)) return false;
    if (Array.isArray(field.oneOf) && field.oneOf.filter((option) => valid(value, option as Json)).length !== 1) return false;
    if (Array.isArray(field.anyOf) && !field.anyOf.some((option) => valid(value, option as Json))) return false;
    if (field.type === 'boolean') return typeof value === 'boolean';
    const bounded = (n: number, min: unknown, max: unknown) => (typeof min !== 'number' || n >= min) && (typeof max !== 'number' || n <= max);
    if (field.type === 'string') return typeof value === 'string' && bounded([...value].length, field.minLength, field.maxLength);
    if (field.type === 'number' || field.type === 'integer') return typeof value === 'number' && Number.isFinite(value) && (field.type !== 'integer' || Number.isInteger(value)) && bounded(value, field.minimum, field.maximum);
    if (field.type === 'array') return Array.isArray(value) && bounded(value.length, field.minItems, field.maxItems) && (field.uniqueItems !== true || new Set(value.map((x) => JSON.stringify(x))).size === value.length) && value.every((x) => valid(x, field.items as Json));
    return true;
}

async function choose(ctx: ExtensionContext, title: string, text: string, accept: string, signal?: AbortSignal) {
    const cancel = 'Decline';
    const ask = async (heading: string, text: string, yes: string) => {
        const answer = await ctx.ui.select(`${heading}\n${text}`, [cancel, yes], { signal });
        return signal?.aborted || answer === undefined ? 'cancel' : answer === yes ? 'accept' : 'decline';
    };
    if (ctx.mode !== 'tui') return ask(title, text, accept);
    const lines = text.split('\n').flatMap((line) => line.match(/.{1,34}/gu) ?? ['']);
    const pages = Math.ceil(lines.length / 4);
    for (let page = 0; page < pages; page++) {
        const decision = page === pages - 1 ? accept : 'Continue review';
        const heading = `${title} (${page + 1}/${pages})`;
        const answer = await ask(heading, lines.slice(page * 4, page * 4 + 4).join('\n'), decision);
        if (answer !== 'accept') return answer;
    }
    return 'accept';
}

export function askPi(ctx: ExtensionContext, signal?: AbortSignal): AskForm {
    return async (message, schema, kind, originalSchema) => {
        if (!ctx.hasUI || signal?.aborted) return { unavailable: 'Pi has no interactive question in this mode' };
        const requested = originalSchema ?? schema;
        const properties = object(requested.properties) ? requested.properties : {};
        if (kind !== 'start' && (Object.keys(requested).some((key) => !formRules.has(key)) ||
            (requested.additionalProperties !== undefined && typeof requested.additionalProperties !== 'boolean') ||
            (requested.properties !== undefined && !object(requested.properties)) ||
            (requested.required !== undefined && (!Array.isArray(requested.required) ||
                requested.required.some((key) => typeof key !== 'string' || !Object.hasOwn(properties, key)))) ||
            !Object.values(properties).every((field) => supported(field)) || secrets.holds(requested))) {
            return { unavailable: 'the server requested a form Pi cannot represent safely' };
        }
        const title = kind === 'start' ? 'Start MCP task' : 'MCP task input';
        if (kind !== 'input') {
            const action = await choose(ctx, title, secrets.scrub(message), kind === 'start' ? 'Start it' : 'Accept', signal);
            return action === 'accept' ? { action, content: { decision: kind === 'start' ? 'start' : 'accept' } } : { action };
        }
        const displayed = exact(JSON.stringify(schema, null, 2)).text;
        if (displayed.length + message.length > 6000) return { unavailable: 'the form is too long to display' };
        const action = await choose(ctx, title, `${secrets.scrub(message)}\n\nEnter a JSON object using this schema if you continue:\n${displayed}`, 'Enter answer', signal);
        if (action !== 'accept') return { action };
        const input = await ctx.ui.input('Answer for the MCP server (JSON)', '{}', { signal });
        if (signal?.aborted || input === undefined) return { action: 'cancel' };
        let data: unknown;
        try { data = input.length <= 6000 ? JSON.parse(input) : undefined; } catch { data = undefined; }
        const required = Array.isArray(requested.required) ? requested.required : [];
        if (!object(data) || required.some((key) => !Object.hasOwn(data as Json, key)) || Object.entries(data).some(([key, value]) => !Object.hasOwn(properties, key) || !valid(value, properties[key] as Json))) {
            return { unavailable: 'the answer did not match the requested form' };
        }
        return { action: 'accept', content: data };
    };
}
