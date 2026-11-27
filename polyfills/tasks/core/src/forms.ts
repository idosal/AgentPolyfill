import { secrets } from './untrusted.ts';

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

export function supportsForm(requested: Json): boolean {
    const properties = object(requested.properties) ? requested.properties : {};
    return Object.keys(requested).every((key) => formRules.has(key)) &&
        (requested.additionalProperties === undefined || typeof requested.additionalProperties === 'boolean') &&
        (requested.properties === undefined || object(requested.properties)) &&
        (requested.required === undefined || (Array.isArray(requested.required) &&
            requested.required.every((key) => typeof key === 'string' && Object.hasOwn(properties, key)))) &&
        Object.values(properties).every((field) => supported(field)) && !secrets.holds(requested);
}

export function validateFormAnswer(data: unknown, requested: Json): Json | undefined {
    const properties = object(requested.properties) ? requested.properties : {};
    const required = Array.isArray(requested.required) ? requested.required : [];
    if (!object(data) || required.some((key) => !Object.hasOwn(data, key)) ||
        Object.entries(data).some(([key, value]) => !Object.hasOwn(properties, key) || !valid(value, properties[key] as Json))) return;
    return data;
}
