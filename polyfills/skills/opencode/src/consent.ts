// Asking by default. OpenCode's shipped rules allow every action, so a question
// a plugin puts to OpenCode's permission rules reaches the person only if they
// wrote an `ask` rule for it. This makes the plugin's own actions ask unless the
// person said otherwise, the way the other hosts' forms ask:
//
// - An OpenCode `evaluate` hook turns `allow` into `ask` for this plugin's own
//   actions, and for nothing else. A configured `deny` is final and never reaches
//   the hook; an `ask` stays an ask. With nobody present to answer (a schedule's
//   run), OpenCode denies an ask, so nothing goes through unattended.
// - "Allow always" still sticks: the plugin follows OpenCode's own
//   `permission.asked` and `permission.replied` events, and when the person
//   answers one of its requests "Allow always", it keeps the exact patterns that
//   request offered to save, for this project. A later request whose resources
//   are all among them stays allowed. OpenCode's event stream carries every
//   project's permission events to every project's instance of a plugin (seen in
//   2.4.1), so a request counts only when its session belongs to this project.
// - The hook can't tell OpenCode's default `allow` from a rule the person wrote,
//   so an `allow` rule in the configuration doesn't skip the question. The plugin
//   option `askByDefault: false` (or the environment variable the plugin names)
//   leaves the decision to OpenCode's rules alone, as before.

type Json = Record<string, unknown>;
type Registration = { dispose(): Promise<void> };

export type ConsentContext = {
    location: { directory: string; project: { id: string } };
    storage: { get(key: string): Promise<unknown>; set(key: string, value: Json): Promise<void> };
    event: { subscribe(options?: { types?: string[]; signal?: AbortSignal }): AsyncIterable<{ type: string; data?: unknown }> };
    session: { get(input: { sessionID: string }): Promise<unknown> };
    permission: {
        hook(name: 'evaluate', callback: (event: { readonly action: string; readonly resources: readonly string[]; effect: 'allow' | 'ask' | 'deny'; message?: string }) => void | Promise<void>): Promise<Registration>;
    };
};

/** Where the patterns the person allowed always are kept: one entry per project, as OpenCode keeps saved approvals. */
export const alwaysKey = (prefix: string, location: { directory: string; project: { id: string } }) =>
    location.project.id && location.project.id !== 'global' ? `${prefix}/always/project/${location.project.id}` : `${prefix}/always/folder/${location.directory}`;

/** Whether an option or environment value turns asking by default off. */
export const askByDefaultOff = (option: unknown, env: string | undefined) => option === false || /^(0|false|off|no)$/i.test(env ?? '');

/**
 * Makes `actions` ask by default. Returns a cleanup. `prefix` names this plugin's storage; `plugin`
 * names it in the message OpenCode shows with the question.
 */
export async function askByDefault(ctx: ConsentContext, o: { actions: readonly string[]; prefix: string; plugin: string; log: (s: string) => void }): Promise<() => Promise<void>> {
    const key = alwaysKey(o.prefix, ctx.location);
    const actions = new Set(o.actions);
    const kept = new Set<string>();
    try {
        const v = await ctx.storage.get(key);
        if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') kept.add(x);
    } catch {
        // nothing kept yet
    }
    const entry = (action: string, resource: string) => `${action}\n${resource}`;

    /** Whether a session is one of this project's: its own key for "Allow always" is this instance's. */
    const ours = async (sessionID: unknown): Promise<boolean> => {
        if (typeof sessionID !== 'string') return false;
        try {
            const r = (await ctx.session.get({ sessionID })) as { data?: unknown } | undefined;
            const s = (r && typeof r === 'object' && 'data' in r ? r.data : r) as { projectID?: unknown; location?: { directory?: unknown } } | undefined;
            if (!s || typeof s.projectID !== 'string' || typeof s.location?.directory !== 'string') return false;
            return alwaysKey(o.prefix, { directory: s.location.directory, project: { id: s.projectID } }) === key;
        } catch {
            return false;
        }
    };

    // Requests this plugin's actions made, by id, with the patterns each offered to save.
    const offered = new Map<string, { action: string; save: string[] }>();
    const ac = new AbortController();
    void (async () => {
        try {
            for await (const ev of ctx.event.subscribe({ types: ['permission.asked', 'permission.replied'], signal: ac.signal })) {
                const d = (ev.data ?? {}) as { id?: unknown; requestID?: unknown; sessionID?: unknown; action?: unknown; save?: unknown; reply?: unknown };
                if (ev.type === 'permission.asked' && typeof d.id === 'string' && typeof d.action === 'string' && actions.has(d.action) && (await ours(d.sessionID))) {
                    offered.set(d.id, { action: d.action, save: Array.isArray(d.save) ? d.save.filter((x): x is string => typeof x === 'string') : [] });
                    while (offered.size > 500) offered.delete(offered.keys().next().value!);
                }
                if (ev.type === 'permission.replied' && typeof d.requestID === 'string') {
                    const req = offered.get(d.requestID);
                    offered.delete(d.requestID);
                    if (!req || d.reply !== 'always' || !req.save.length) continue;
                    for (const p of req.save) kept.add(entry(req.action, p));
                    try {
                        // Other instances of this project (its other folders) keep to the same list: add to it.
                        const v = await ctx.storage.get(key).catch(() => undefined);
                        if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') kept.add(x);
                        await ctx.storage.set(key, [...kept] as unknown as Json);
                    } catch {
                        o.log('an "Allow always" could not be kept; it is asked about again next time');
                    }
                }
            }
        } catch {
            // the stream ended (the plugin is unloading)
        }
    })();

    const registration = await ctx.permission.hook('evaluate', (event) => {
        if (!actions.has(event.action) || event.effect !== 'allow') return;
        if (event.resources.length && event.resources.every((r) => kept.has(entry(event.action, r)))) return;
        event.effect = 'ask';
        event.message = `${o.plugin} asks before ${event.action} unless you chose "Allow always" for it, or set its option askByDefault to false.`;
    });

    return async () => {
        ac.abort();
        await registration.dispose().catch(() => {});
    };
}
