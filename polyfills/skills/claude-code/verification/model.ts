// A model of the mod's skill gate, and a checker that explores every state of it to a bound.
//
// This is the same state machine as skillGate.qnt and SkillGate.tla, written so that it runs here
// with nothing to install: `node verification/model.ts` explores every reachable state
// breadth-first, checks each invariant in every state and on every step, and prints a shortest
// trace to the first violation. It is a hand-written explorer, not TLC; TLC checks SkillGate.tla
// (verification/check.mjs, which also checks that TLC reaches as many states of the gate as this
// does). They are kept in step by hand: each action and invariant here has the same name there. docs/verification.md says what each part stands for
// in the code, and what this does and does not show.
//
// Modelled:
//   - a server that serves a skill and changes its entry, its SKILL.md and a supporting file at any
//     moment, each separately (a server that is inconsistent, stale, or hostile), and a second
//     server that Claude Code can read resources from;
//   - the helper: the registry (entries from listings and skills/get, possibly stale), the entry a
//     loaded skill is held under, verification of every read against the entry it is read under;
//   - the hooks module: the permission check of load_skill (a kept approval bound to the manifest
//     hash and the server's location; else the person is asked; else, with nobody to ask, Claude
//     Code's own rules decide), the run that loads exactly the approved set or nothing, the record
//     of the skills the conversation acts on and whether each was approved, the gate on every other
//     tool call, the read-back of that record after a resume;
//   - the approvals kept across sessions, given in this session or in another one;
//   - helper restarts, Claude Code restarts (a resume, with the server at the same or another
//     location, with or without a person), clearing the conversation, forgetting approvals, and a
//     load_skill call that reached the tool with no permission check (another mod's $.tool.call);
//   - the person disabling the skill and enabling it again, at any moment, in this session or
//     another (the list is the mod's store, shared by every session), and the skill's listing line
//     entering the model's context (the skill listing, list_skills).
//
// Bound: VERSIONS versions of each part of the skill (default 3), 2 locations of its server, a
// skill with a manifest and a "dynamic" one; and, separately, every combination of the facts that
// decide whether a server is used at all.

type V = number;
type Opt<T> = T | null;
type Approval = 'A' | 'U';
type How = 'fresh' | 'stored' | 'none';
/**
 * A load call whose permission check has run (state.pending in register.ts): what it settled.
 * `forV`/`forL`: the version and location the person's approval covers, given in this check
 * (`fresh`) or kept from before (`stored`); nothing for a load nobody approved.
 */
type Pend = { hash: Opt<V>; approved: boolean; isNew: boolean; how: How; forV: Opt<V>; forL: number };

export type State = {
    srvEntry: V;
    srvBody: V;
    srvFile: V;
    loc: number;
    registry: Opt<V>;
    /** The entry the loaded skill is held under, and whether that load was approved. */
    held: Opt<{ v: V; approved: boolean }>;
    store: Opt<{ v: V; l: number }>;
    pend: Opt<Pend>;
    present: boolean;
    /** The hooks module's record of the skill the conversation acts on (state.acting / loadedHere). */
    acting: Opt<Approval>;
    /** The conversation itself: any load of the skill in it, any unapproved one, and the approval line of the latest. */
    convoAny: boolean;
    convoU: boolean;
    convoLast: Opt<Approval>;
    /** The person has disabled the skill: the list in the mod's store, keyed by server and URI. */
    off: boolean;
};

export type Options = {
    /** The skill is "dynamic": no digests, it cannot be content-bound. */
    dynamic: boolean;
    /** The fixed rule: a skill loaded unapproved stays unapproved until the conversation is cleared. Off: 0.3.0's rule, where the latest load decides. */
    sticky: boolean;
    /** A resume may miss the load when it reads the conversation back (the documented limit). */
    lossyReadback: boolean;
    versions: number;
    /** A model with one protection taken out, to show the invariants catch its absence. */
    mutant?: Mutant;
};

/** Each takes out one protection the code has. Every one must be caught: see test/model-test.ts. */
export const MUTANTS = ['no-expect', 'no-location', 'no-verify', 'no-retry-check', 'no-gate', 'no-cross-read-gate', 'keep-dynamic', 'trust-repo-when-inherited', 'no-disable-at-run', 'run-trusts-check', 'no-disable-at-read', 'listing-ignores-disabled', 'disable-ends-window'] as const;
export type Mutant = (typeof MUTANTS)[number];

const LOCS = [0, 1];

export function initial(o: Options): State[] {
    const out: State[] = [];
    for (const present of [true, false]) for (const loc of LOCS) out.push({ srvEntry: 0, srvBody: 0, srvFile: 0, loc, registry: null, held: null, store: null, pend: null, present, acting: null, convoAny: false, convoU: false, convoLast: null, off: false });
    return o.versions > 0 ? out : [];
}

/** What a step did that an invariant is about. */
export type Event =
    | { kind: 'content'; what: 'SKILL.md' | 'file'; v: V; against: V; l: number; approved: boolean; forV: Opt<V>; forL: number; how: How }
    | { kind: 'run'; tool: 'act' | 'read-own' | 'read-other'; unapprovedInContext: boolean; skillInContext: boolean; personYes: boolean }
    | { kind: 'kept'; v: V; l: number; yesV: Opt<V>; yesL: number }
    /** The skill's line (its name, description, server, URI) entered the model's context. */
    | { kind: 'offer' };

type Step = { name: string; next: State; events: Event[] };

/** Read-back of the conversation after a resume (actingSkills in register.ts). */
const readBack = (st: State, o: Options): Opt<Approval> => (!st.convoAny ? null : o.sticky ? (st.convoU ? 'U' : 'A') : st.convoLast);

export function steps(st: State, o: Options): Step[] {
    const out: Step[] = [];
    const push = (name: string, next: State, ...events: Event[]) => out.push({ name, next, events });
    const VS = [...Array(o.versions).keys()];

    // ---- ServerSetEntry / ServerSetBody / ServerSetFile: the server changes one part of its skill.
    for (const v of VS) {
        if (st.srvEntry !== v) push(`ServerSetEntry(${v})`, { ...st, srvEntry: v });
        if (st.srvBody !== v) push(`ServerSetBody(${v})`, { ...st, srvBody: v });
        if (st.srvFile !== v) push(`ServerSetFile(${v})`, { ...st, srvFile: v });
    }

    // ---- List: skills/list puts the server's current entry in the registry.
    if (st.registry !== st.srvEntry) push('List', { ...st, registry: st.srvEntry });

    // ---- Check: the permission check of a load_skill call (tool.check in register.ts, App.entry).
    // A skill the person disabled is refused there, before anything else: nothing changes.
    if (st.pend === null && !st.off) {
        // SkillsHost.entry(): a loaded skill is asked about afresh (skills/get); otherwise the registry's entry, or skills/get.
        const e: V = st.held !== null ? st.srvEntry : (st.registry ?? st.srvEntry);
        const base = { ...st, registry: e };
        const hash: Opt<V> = o.dynamic ? null : e;
        if (hash !== null && st.store !== null && st.store.v === hash && (st.store.l === st.loc || o.mutant === 'no-location')) {
            push('Check:kept-yes', { ...base, pend: { hash, approved: true, isNew: false, how: 'stored', forV: st.store.v, forL: st.store.l } });
        } else if (st.present) {
            // The person is shown this entry (version e) at this location, and answers.
            push('Check:person-yes', { ...base, pend: { hash, approved: true, isNew: true, how: 'fresh', forV: o.dynamic ? null : e, forL: st.loc } });
            push('Check:person-no', base);
        } else {
            // Nobody to ask: Claude Code's own rules decide; allowed, the skill loads unapproved.
            push('Check:rules-allow', { ...base, pend: { hash, approved: false, isNew: false, how: 'none', forV: null, forL: st.loc } });
            push('Check:rules-deny', base);
        }
    }

    // ---- Run: the load (serve() in register.ts, SkillsHost.load()). Unchecked: a load_skill call that
    // reached the tool with no permission check (another mod's): approved by nobody.
    const run = (name: string, p: Pend) => {
        let next: State = { ...st, pend: null };
        // A skill disabled since the check (or never checked) is refused when the call runs: the
        // store is read again there. Refused unchecked, nothing changes.
        if (st.off && o.mutant !== 'no-disable-at-run' && !(o.mutant === 'run-trusts-check' && name === 'Run')) return name === 'Run' ? push(`${name}:disabled`, next) : undefined;
        const expect = o.mutant === 'no-expect' ? null : p.hash;
        const known = st.held !== null && expect === null ? null : st.registry;
        let listed: V;
        if (known !== null) listed = known;
        else {
            listed = st.srvEntry;
            next = { ...next, registry: listed };
        }
        if (expect !== null && listed !== expect) return push(`${name}:changed-since-approval`, next);
        const verifies = (entry: V) => o.dynamic || st.srvBody === entry || o.mutant === 'no-verify';
        if (!verifies(listed)) {
            if (known === null) return push(`${name}:verification-failed`, next);
            // A listed entry may be stale: it is read once more with skills/get, and the load tried from that.
            listed = st.srvEntry;
            next = { ...next, registry: listed };
            if (expect !== null && listed !== expect && o.mutant !== 'no-retry-check') return push(`${name}:changed-since-approval`, next);
            if (!verifies(listed)) return push(`${name}:verification-failed`, next);
        }
        const mark: Approval = p.approved ? 'A' : 'U';
        next = { ...next, held: { v: listed, approved: p.approved }, acting: o.sticky && st.acting === 'U' ? 'U' : mark, convoAny: true, convoU: next.convoU || !p.approved, convoLast: o.sticky ? null : mark };
        const events: Event[] = [{ kind: 'content', what: 'SKILL.md', v: o.dynamic ? st.srvBody : listed, against: listed, l: st.loc, approved: p.approved, forV: p.forV, forL: p.forL, how: p.how }];
        // A yes just given is kept, bound to the set it was given for. A dynamic skill's is for this load alone.
        if (p.approved && p.isNew && ((expect !== null && listed === expect) || (o.mutant === 'keep-dynamic' && o.dynamic))) {
            next = { ...next, store: { v: listed, l: st.loc } };
            events.push({ kind: 'kept', v: listed, l: st.loc, yesV: p.how === 'fresh' ? p.forV : null, yesL: p.forL });
        }
        push(`${name}:loaded`, next, ...events);
    };
    if (st.pend !== null) run('Run', st.pend);
    else run('Unchecked', { hash: null, approved: false, isNew: false, how: 'none', forV: null, forL: st.loc });

    // ---- ReadFile: read_skill_file, resolved against the held entry only, and verified.
    if (st.held !== null && (!st.off || o.mutant === 'no-disable-at-read') && (o.dynamic || st.srvFile === st.held.v || o.mutant === 'no-verify')) {
        const h = st.held;
        push('ReadFile', st, { kind: 'content', what: 'file', v: st.srvFile, against: h.v, l: st.loc, approved: h.approved, forV: h.approved ? h.v : null, forL: st.loc, how: h.approved ? 'stored' : 'none' });
    }

    // ---- Tool(kind, rule): any other tool call, through the gate in tool.check. 'act' is any tool outside
    // the allowed list (a command, a write, a subagent, another server's tool); 'read-own' and 'read-other'
    // are Claude Code's own resource read, from the skill's server or from the other one. A 'deny' rule
    // refuses before the gate, and runs nothing.
    for (const tool of ['act', 'read-own', 'read-other'] as const)
        for (const rule of ['allow', 'ask'] as const) {
            const byMod = tool === 'act' ? st.acting === 'U' && o.mutant !== 'no-gate' : tool === 'read-other' ? st.acting !== null && o.mutant !== 'no-cross-read-gate' : false;
            const decision = byMod ? (st.present ? 'ask' : 'deny') : rule;
            const event = (personYes: boolean): Event => ({ kind: 'run', tool, unapprovedInContext: st.convoU, skillInContext: st.convoAny, personYes });
            if (decision === 'allow') push(`Tool(${tool},${rule}):runs`, st, event(false));
            else if (decision === 'ask' && st.present) push(`Tool(${tool},${rule}):person-yes`, st, event(true));
        }

    // ---- Offer: the skill's line enters the model's context: the session's skill listing, composed
    // (prompt.attachment) after the helper was told the list as the store holds it now, or
    // list_skills. Only a skill the helper has an entry for is listed.
    if (st.registry !== null && (!st.off || o.mutant === 'listing-ignores-disabled')) push('Offer', st, { kind: 'offer' });

    // ---- Disable / Enable: /mcp-skills disable and enable, here or in another session. Neither
    // touches the conversation: a skill loaded before is still acted on (and still gated).
    if (!st.off) push('Disable', { ...st, off: true, ...(o.mutant === 'disable-ends-window' ? { acting: null } : {}) });
    else push('Enable', { ...st, off: false });

    // ---- HelperRestart: the helper stops and is started again: its registry and held entry are gone.
    if (st.held !== null || st.registry !== null) push('HelperRestart', { ...st, registry: null, held: null });

    // ---- Resume: Claude Code starts again on the same conversation, with the server where it was or
    // elsewhere, with or without a person; the hooks module reads the conversation back.
    const back = readBack(st, o);
    const readings: Opt<Approval>[] = o.lossyReadback && back !== null ? [back, null] : [back];
    for (const present of [true, false])
        for (const loc of LOCS)
            for (const acting of readings) push(`Resume(present=${present},loc=${loc})${acting === back ? '' : ':lossy'}`, { ...st, pend: null, registry: null, held: null, present, loc, acting });

    // ---- Clear: /clear ends the conversation, and the acting window with it.
    if (st.convoAny || st.pend !== null) push('Clear', { ...st, pend: null, held: null, acting: null, convoAny: false, convoU: false, convoLast: null });

    // ---- Forget: /mcp-skills forget.
    if (st.store !== null) push('Forget', { ...st, store: null });

    // ---- ElsewhereYes: the person approves the skill, as it is now, in another session on this machine.
    if (!o.dynamic && !(st.store?.v === st.srvEntry && st.store.l === st.loc)) push('ElsewhereYes', { ...st, store: { v: st.srvEntry, l: st.loc } }, { kind: 'kept', v: st.srvEntry, l: st.loc, yesV: st.srvEntry, yesL: st.loc });
    return out;
}

// ---- Invariants. Names match SkillGate.tla.

/** Checked in every state. */
export function stateInvariants(st: State, o: Options): string[] {
    const bad: string[] = [];
    // NoKeptYesForDynamic: nothing is kept for a skill that cannot be content-bound.
    if (st.store !== null && o.dynamic) bad.push('NoKeptYesForDynamic');
    // HeldImpliesActing: the helper holds an entry only for a skill the conversation acts on.
    if (st.held !== null && !st.convoAny) bad.push('HeldImpliesActing');
    // ActingMatchesConversation: with nothing lost on read-back, the hooks module knows whether the conversation acts on the skill, and whether unapproved.
    if (!o.lossyReadback && o.sticky && (st.acting !== null) !== st.convoAny) bad.push('ActingMatchesConversation');
    if (!o.lossyReadback && o.sticky && (st.acting === 'U') !== st.convoU) bad.push('ActingMatchesConversation');
    return bad;
}

/** Checked on every step, about what the step did. */
export function stepInvariants(events: Event[], st: State, o: Options): string[] {
    const bad: string[] = [];
    for (const e of events) {
        // DisabledNeverReaches: while the person has the skill disabled, nothing of it enters the
        // model's context: not its listing line, not its SKILL.md, not a file.
        if ((e.kind === 'content' || e.kind === 'offer') && st.off) bad.push('DisabledNeverReaches');
        if (e.kind === 'offer') continue;
        if (e.kind === 'content') {
            // ApprovedContent: content that reaches the model as approved is exactly the set the person said yes
            // to, at the location they said it for; a dynamic skill's SKILL.md only with a yes given in this load's check.
            if (e.approved && !o.dynamic && !(e.forV === e.v && e.forL === e.l && e.how !== 'none')) bad.push('ApprovedContent');
            if (e.approved && o.dynamic && e.what === 'SKILL.md' && e.how !== 'fresh') bad.push('ApprovedContent');
            // Verified: a file whose bytes do not match the entry it is read under is never used.
            if (!o.dynamic && e.v !== e.against) bad.push('Verified');
        } else if (e.kind === 'kept') {
            // KeptIsConsented: an approval is kept only for exactly the set and location the person said yes to.
            if (e.yesV !== e.v || e.yesL !== e.l) bad.push('KeptIsConsented');
        } else {
            // Gate: while unapproved skill content is in the conversation, nothing outside the allowed list runs
            // without the person's yes for that call (a read of the skill's own server is on the list).
            if (e.tool === 'act' && e.unapprovedInContext && !e.personYes) bad.push('Gate');
            // CrossServerRead: while a skill is in the conversation, a resource read from another server runs only
            // with the person's yes for that call.
            if (e.tool === 'read-other' && e.skillInContext && !e.personYes) bad.push('CrossServerRead');
            // NobodyAnswers: with nobody present there is no yes.
            if (e.personYes && !st.present) bad.push('NobodyAnswers');
        }
    }
    return bad;
}

// ---- Which servers are used at all (config.ts discoverServers, then Claude Code's own verdict).

export type ServerFacts = {
    trust: 'none' | 'own' | 'inherited';
    fromRepo: boolean;
    /** The person approved the .mcp.json server: in their local entry, or their user settings. */
    personApproves: boolean;
    /** The repository's own .claude/settings*.json approve it. */
    repoApproves: boolean;
    rejected: boolean;
    switchedOff: boolean;
    claudeCodeUses: boolean;
};

const usedBy = (f: ServerFacts, mutant?: Mutant) => used(f, mutant);
/** The rule, as config.ts and the hooks module apply it. */
export function used(f: ServerFacts, mutant?: Mutant): boolean {
    if (!f.claudeCodeUses || f.switchedOff) return false;
    if (!f.fromRepo) return true;
    if (f.trust === 'none' || f.rejected) return false;
    return f.personApproves || ((f.trust === 'own' || mutant === 'trust-repo-when-inherited') && f.repoApproves);
}

export function serverInvariants(f: ServerFacts, mutant?: Mutant): string[] {
    const bad: string[] = [];
    const used = (x: ServerFacts) => usedBy(x, mutant);
    // InheritedTrustRepoApprovesNothing: a repository's own settings never approve its servers when its trust is inherited.
    if (used(f) && f.fromRepo && f.trust === 'inherited' && !f.personApproves) bad.push('InheritedTrustRepoApprovesNothing');
    if (used(f) && f.fromRepo && (f.trust === 'none' || f.rejected)) bad.push('UntrustedOrRejectedUnused');
    if (used(f) && (!f.claudeCodeUses || f.switchedOff)) bad.push('OnlyWhatClaudeCodeUses');
    return bad;
}

// ---- The explorer.

const keyOf = (st: State): string => JSON.stringify(st);

export type Result = { states: number; transitions: number; depth: number; violation?: { invariant: string; trace: string[] } };

export function explore(o: Options, limit = 20_000_000): Result {
    const seen = new Map<string, { parent: string | null; via: string }>();
    let frontier: State[] = [];
    let transitions = 0;
    let depth = 0;
    const traceTo = (k: string, last?: string): string[] => {
        const out: string[] = last ? [last] : [];
        for (let at: string | null = k; at !== null; ) {
            const node: { parent: string | null; via: string } = seen.get(at)!;
            out.unshift(node.via);
            at = node.parent;
        }
        return out;
    };
    for (const s of initial(o)) {
        const k = keyOf(s);
        if (seen.has(k)) continue;
        seen.set(k, { parent: null, via: `Init(present=${s.present},loc=${s.loc})` });
        const bad = stateInvariants(s, o);
        if (bad.length) return { states: seen.size, transitions, depth, violation: { invariant: bad[0]!, trace: traceTo(k) } };
        frontier.push(s);
    }
    while (frontier.length) {
        const next: State[] = [];
        for (const st of frontier) {
            const k = keyOf(st);
            for (const step of steps(st, o)) {
                transitions++;
                const bad = stepInvariants(step.events, st, o);
                if (bad.length) return { states: seen.size, transitions, depth, violation: { invariant: bad[0]!, trace: traceTo(k, step.name) } };
                const nk = keyOf(step.next);
                if (seen.has(nk)) continue;
                seen.set(nk, { parent: k, via: step.name });
                const badState = stateInvariants(step.next, o);
                if (badState.length) return { states: seen.size, transitions, depth: depth + 1, violation: { invariant: badState[0]!, trace: traceTo(nk) } };
                next.push(step.next);
                if (seen.size > limit) throw new Error(`more than ${limit} states`);
            }
        }
        frontier = next;
        if (frontier.length) depth++;
    }
    return { states: seen.size, transitions, depth };
}

export function exploreServers(mutant?: Mutant): { combinations: number; violation?: { invariant: string; facts: ServerFacts } } {
    let combinations = 0;
    const b = [false, true];
    for (const trust of ['none', 'own', 'inherited'] as const)
        for (const fromRepo of b)
            for (const personApproves of b)
                for (const repoApproves of b)
                    for (const rejected of b)
                        for (const switchedOff of b)
                            for (const claudeCodeUses of b) {
                                const f = { trust, fromRepo, personApproves, repoApproves, rejected, switchedOff, claudeCodeUses };
                                combinations++;
                                const bad = serverInvariants(f, mutant);
                                if (bad.length) return { combinations, violation: { invariant: bad[0]!, facts: f } };
                            }
    return { combinations };
}

// `node verification/model.ts [--old] [--lossy] [--versions=N]`: both kinds of skill, for the rule given.
// Exit 1 on a violation, with a shortest trace to it.
if (import.meta.url === `file://${process.argv[1]}`) {
    const sticky = !process.argv.includes('--old');
    const lossyReadback = process.argv.includes('--lossy');
    const versions = Number(/^--versions=(\d+)$/.exec(process.argv.find((a) => a.startsWith('--versions=')) ?? '')?.[1] ?? 3);
    let failed = false;
    const gate = exploreServers();
    console.log(`which servers are used: ${gate.combinations} combinations of the facts, ${gate.violation ? `VIOLATION of ${gate.violation.invariant}: ${JSON.stringify(gate.violation.facts)}` : 'every invariant holds'}`);
    failed ||= !!gate.violation;
    for (const dynamic of [false, true]) {
        const started = Date.now();
        const r = explore({ dynamic, sticky, lossyReadback, versions });
        const what = `${dynamic ? 'a dynamic skill' : 'a skill with a manifest'}, ${versions} versions, ${sticky ? 'the fixed rule' : "0.3.0's rule"}${lossyReadback ? ', lossy read-back' : ''}`;
        if (r.violation) {
            failed = true;
            console.log(`${what}: VIOLATION of ${r.violation.invariant} (after ${r.states} states); a shortest trace:`);
            for (const step of r.violation.trace) console.log(`    ${step}`);
        } else console.log(`${what}: ${r.states} states, ${r.transitions} transitions, depth ${r.depth}; every invariant holds (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    }
    process.exit(failed ? 1 : 0);
}
