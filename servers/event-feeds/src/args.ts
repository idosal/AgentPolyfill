// Subscription arguments are checked here against the same rules the inputSchema states. Anything
// else is refused with InvalidParams (SEP-3415, Error Handling): unknown keys, wrong types, values
// out of range. No argument ever becomes a URL by itself: sources build upstream URLs from checked
// values only.

export class ArgError extends Error {
    data: Record<string, unknown>;
    constructor(message: string, data: Record<string, unknown> = {}) {
        super(message);
        this.data = data;
    }
}

type Raw = Record<string, unknown>;

export function object(raw: unknown, allowed: string[]): Raw {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new ArgError('arguments must be an object');
    const o = raw as Raw;
    const extra = Object.keys(o).filter((k) => !allowed.includes(k));
    if (extra.length) throw new ArgError(`unknown argument${extra.length > 1 ? 's' : ''}: ${extra.slice(0, 5).join(', ')}`, { allowed });
    return o;
}

export function str(o: Raw, key: string, re: RegExp, required: true, hint: string): string;
export function str(o: Raw, key: string, re: RegExp, required: false, hint: string): string | undefined;
export function str(o: Raw, key: string, re: RegExp, required: boolean, hint: string): string | undefined {
    const v = o[key];
    if (v === undefined || v === null) {
        if (required) throw new ArgError(`missing argument "${key}": ${hint}`, { argument: key });
        return undefined;
    }
    if (typeof v !== 'string' || !re.test(v)) throw new ArgError(`argument "${key}" is not valid: ${hint}`, { argument: key });
    return v;
}

export function int(o: Raw, key: string, min: number, max: number, required: boolean, hint: string): number | undefined {
    const v = o[key];
    if (v === undefined || v === null) {
        if (required) throw new ArgError(`missing argument "${key}": ${hint}`, { argument: key });
        return undefined;
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ArgError(`argument "${key}" must be an integer from ${min} to ${max}: ${hint}`, { argument: key });
    return v;
}

export function num(o: Raw, key: string, min: number, max: number, hint: string): number | undefined {
    const v = o[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new ArgError(`argument "${key}" must be a number from ${min} to ${max}: ${hint}`, { argument: key });
    return v;
}

export function oneOf<T extends string>(o: Raw, key: string, values: readonly T[], fallback: T): T {
    const v = o[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) throw new ArgError(`argument "${key}" must be one of: ${values.join(', ')}`, { argument: key });
    return v as T;
}

export function bool(o: Raw, key: string, fallback: boolean): boolean {
    const v = o[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'boolean') throw new ArgError(`argument "${key}" must be true or false`, { argument: key });
    return v;
}
