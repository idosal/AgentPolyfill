// The Tasks extension's wire shapes, as SEP-2663 and the ext-tasks specification at revision
// 2026-07-28 define them, and the checks a client makes on what a server sends. Rule ids (C1…) are
// those of ../docs/client-rules.md.

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
/** The extension is defined only on this protocol revision and later (SEP-2663, Backward Compatibility). */
export const FIRST_REVISION = '2026-07-28';
/** The methods a task is driven with. Over Streamable HTTP each carries `Mcp-Name: <taskId>` (C16). */
export const TASK_METHODS = new Set(['tasks/get', 'tasks/update', 'tasks/cancel']);
/** The requests that may be answered with a task in this revision ("Supported Methods"). */
export const TASK_AUGMENTABLE = new Set(['tools/call']);

export type TaskStatus = 'working' | 'input_required' | 'completed' | 'cancelled' | 'failed';
export const STATUSES: readonly TaskStatus[] = ['working', 'input_required', 'completed', 'cancelled', 'failed'];
export const TERMINAL = new Set<TaskStatus>(['completed', 'cancelled', 'failed']);

type Json = Record<string, unknown>;
export type InputRequest = { method: string; params: Json };

/** A task as the server last described it (`Task`, with the fields of its status: `DetailedTask`). */
export type TaskState = {
    taskId: string;
    status: TaskStatus;
    statusMessage?: string;
    createdAt: string;
    lastUpdatedAt: string;
    ttlMs: number | null;
    pollIntervalMs?: number;
    inputRequests?: Record<string, InputRequest>;
    result?: Json;
    error?: Json;
};

/** What `tools/call` came back as (C1): a plain result, a task, or something this client refuses. */
export type CallOutcome =
    | { kind: 'result'; result: Json }
    | { kind: 'task'; task: TaskState }
    | { kind: 'input_required' }
    | { kind: 'invalid'; why: string };

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDate = (v: unknown) => typeof v === 'string' && v.length <= 64 && !Number.isNaN(Date.parse(v));
const isMs = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * A task id this client can carry: in an `Mcp-Name` header (visible ASCII) and in its store. The
 * specification puts no limit on a task id; one outside this is refused, and the README says so.
 */
export const TASK_ID = /^[\x21-\x7e]{1,512}$/;

/** A tool name as MCP allows them (1 to 128 of letters, digits, `_`, `-`, `.`, `/`). */
export const TOOL_NAME = /^[A-Za-z0-9_.\-/]{1,128}$/;

/**
 * Reads a `Task` (in a `CreateTaskResult`, a `tasks/get` result, or a `notifications/tasks`
 * notification) and checks the fields its status requires. Returns why it is refused otherwise.
 */
export function readTask(r: unknown): TaskState | { invalid: string } {
    if (!isObject(r)) return { invalid: 'the answer is not an object' };
    if (typeof r.taskId !== 'string' || !TASK_ID.test(r.taskId)) return { invalid: 'its taskId is missing or is not one this client can carry' };
    if (typeof r.status !== 'string' || !(STATUSES as readonly string[]).includes(r.status)) return { invalid: 'its status is not one the specification defines' };
    if (!isDate(r.createdAt) || !isDate(r.lastUpdatedAt)) return { invalid: 'createdAt or lastUpdatedAt is missing or not a date' };
    if (!(r.ttlMs === null || isMs(r.ttlMs))) return { invalid: 'ttlMs is missing, or neither null nor a whole number of milliseconds' };
    if (r.pollIntervalMs !== undefined && !isMs(r.pollIntervalMs)) return { invalid: 'pollIntervalMs is not a whole number of milliseconds' };
    if (r.statusMessage !== undefined && typeof r.statusMessage !== 'string') return { invalid: 'statusMessage is not text' };
    const status = r.status as TaskStatus;
    const out: TaskState = {
        taskId: r.taskId,
        status,
        createdAt: r.createdAt as string,
        lastUpdatedAt: r.lastUpdatedAt as string,
        ttlMs: r.ttlMs as number | null,
        ...(r.pollIntervalMs !== undefined ? { pollIntervalMs: r.pollIntervalMs as number } : {}),
        ...(typeof r.statusMessage === 'string' ? { statusMessage: r.statusMessage } : {})
    };
    if (status === 'input_required') {
        if (!isObject(r.inputRequests)) return { invalid: 'an input_required task carries no inputRequests' };
        const requests: Record<string, InputRequest> = {};
        for (const [key, v] of Object.entries(r.inputRequests)) {
            if (!isObject(v) || typeof v.method !== 'string') return { invalid: 'an entry of inputRequests is not a request' };
            if (key.length > 256) return { invalid: 'an inputRequests key is too long' };
            requests[key] = { method: v.method, params: isObject(v.params) ? v.params : {} };
        }
        out.inputRequests = requests;
    }
    if (status === 'completed') {
        if (!isObject(r.result)) return { invalid: 'a completed task carries no result' };
        out.result = r.result;
    }
    if (status === 'failed') {
        if (!isObject(r.error)) return { invalid: 'a failed task carries no error' };
        out.error = r.error;
    }
    return out;
}

/**
 * Classifies the answer to a request this client made with the extension declared. `tools/call`
 * may come back as a plain result or as a task (C1); a task for any other request is invalid (C2).
 */
export function classify(method: string, r: unknown): CallOutcome {
    if (!isObject(r)) return { kind: 'invalid', why: 'the answer is not an object' };
    const type = r.resultType;
    if (type === 'task') {
        if (!TASK_AUGMENTABLE.has(method)) return { kind: 'invalid', why: `a task came back for ${method}, which can't be answered with one` };
        const t = readTask(r);
        return 'invalid' in t ? { kind: 'invalid', why: `the task it returned is not valid: ${t.invalid}` } : { kind: 'task', task: t };
    }
    if (type === 'input_required') return { kind: 'input_required' };
    if (type !== undefined && type !== 'complete') return { kind: 'invalid', why: 'its resultType is not one this client knows' };
    return { kind: 'result', result: r };
}

/**
 * The answer to `tasks/get`: a task whose `resultType` is "complete", for the task asked about.
 * A task whose id changed, or that left a terminal status, is refused (the state diagram).
 */
export function readGetResult(asked: string, r: unknown, previous?: TaskStatus): TaskState | { invalid: string } {
    if (!isObject(r)) return { invalid: 'the answer is not an object' };
    if (r.resultType !== undefined && r.resultType !== 'complete') return { invalid: 'its resultType is not "complete"' };
    const t = readTask(r);
    if ('invalid' in t) return t;
    if (t.taskId !== asked) return { invalid: 'it describes a different task than the one asked about' };
    if (previous && TERMINAL.has(previous) && t.status !== previous) return { invalid: `the task was ${previous} and is now ${t.status}, which the specification does not allow` };
    return t;
}

/** The answers SEP-2663 lets a client give (`InputResponse`): only results, never an error. */
export type InputResponse = Json;
