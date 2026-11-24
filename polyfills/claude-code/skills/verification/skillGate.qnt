// -*- mode: Bluespec; -*-
// The mcp-skills mod's skill gate: approval, loading, verification, the acting window, the gate
// on other tool calls, and the person disabling and enabling the skill. The same state machine as verification/model.ts, action for action and
// invariant for invariant (docs/verification.md maps each to the code). This file is for Quint's
// simulator (`quint run`, which samples). TLC checks SkillGate.tla, this file written in TLA+ by
// hand (verification/check.mjs, exhaustive to each configuration's bound); verification/conform.mjs
// replays traces of this file in that one.
//
// One server serves a skill and may change its entry, its SKILL.md and a supporting file at any
// moment, each separately; a second server is only a place resources can be read from.

module skillGate {
  // The skill has no manifest ("dynamic"): no digests, nothing to bind an approval to.
  const DYNAMIC: bool
  // The fixed rule: a skill loaded unapproved stays unapproved until the conversation is cleared.
  // FALSE is 0.3.0's rule, where the latest load decided.
  const STICKY: bool
  // A resume may miss the load when it reads the conversation back (the documented limit).
  const LOSSY: bool
  // How many versions each part of the skill can be in.
  const NVERSIONS: int

  pure val NONE = -1
  pure val LOCS = Set(0, 1)
  pure val BOOLS = Set(true, false)
  pure def versions = 0.to(NVERSIONS - 1)

  // A load call whose permission check has run (state.pending in register.ts): what it settled.
  // forV/forL: the version and location the person's approval covers, given in this check
  // ("fresh") or kept from before ("stored"); nothing for a load nobody approved ("none").
  type Pend = { active: bool, hash: int, approved: bool, isNew: bool, how: str, forV: int, forL: int }

  type State = {
    srvEntry: int, srvBody: int, srvFile: int,   // what the server serves now
    loc: int,                                    // where the configured server is
    registry: int,                               // helper: the entry last seen (NONE: none)
    held: int, heldApproved: bool,               // helper: the entry the loaded skill is held under
    store: int, storeLoc: int,                   // the kept approval: version and location (NONE: none)
    pend: Pend,
    present: bool,                               // a person can be asked in this session
    acting: str,                                 // hooks module: "none", "A" (approved) or "U"
    convoAny: bool, convoU: bool, convoLast: str, // the conversation: any load, any unapproved one, the latest's line
    off: bool                                    // the person disabled the skill (the mod's store, by server and URI)
  }

  // What a step did that an invariant is about: content entering the conversation, or a tool call running.
  type Event = {
    kind: str, what: str, v: int, against: int, l: int, approved: bool, forV: int, forL: int, how: str,
    tool: str, unapprovedInContext: bool, skillInContext: bool, personYes: bool
  }
  // An approval kept by the step, and the yes it was kept for.
  type Kept = { kept: bool, v: int, l: int, yesV: int, yesL: int }

  pure val noPend: Pend = { active: false, hash: NONE, approved: false, isNew: false, how: "none", forV: NONE, forL: NONE }
  pure val noEvent: Event = {
    kind: "none", what: "", v: NONE, against: NONE, l: NONE, approved: false, forV: NONE, forL: NONE, how: "none",
    tool: "", unapprovedInContext: false, skillInContext: false, personYes: false
  }
  pure val noKept: Kept = { kept: false, v: NONE, l: NONE, yesV: NONE, yesL: NONE }

  var st: State
  var ev: Event
  var kept: Kept

  action go(s: State, e: Event, k: Kept): bool = all { st' = s, ev' = e, kept' = k }
  action quiet(s: State): bool = go(s, noEvent, noKept)

  action init = {
    nondet present = BOOLS.oneOf()
    nondet l = LOCS.oneOf()
    go({
      srvEntry: 0, srvBody: 0, srvFile: 0, loc: l, registry: NONE, held: NONE, heldApproved: false,
      store: NONE, storeLoc: NONE, pend: noPend, present: present,
      acting: "none", convoAny: false, convoU: false, convoLast: "none", off: false
    }, noEvent, noKept)
  }

  // ServerSetEntry / ServerSetBody / ServerSetFile: the server changes one part of its skill.
  action serverSetEntry = { nondet v = versions.oneOf() quiet({ ...st, srvEntry: v }) }
  action serverSetBody = { nondet v = versions.oneOf() quiet({ ...st, srvBody: v }) }
  action serverSetFile = { nondet v = versions.oneOf() quiet({ ...st, srvFile: v }) }

  // List: skills/list puts the server's current entry in the registry.
  action listSkills = quiet({ ...st, registry: st.srvEntry })

  // Check: the permission check of a load_skill call (tool.check in register.ts, App.entry).
  action check = {
    // SkillsHost.entry(): a loaded skill is asked about afresh; otherwise the registry's entry, or skills/get.
    val e = if (st.held != NONE) st.srvEntry else if (st.registry != NONE) st.registry else st.srvEntry
    val base = { ...st, registry: e }
    val hash = if (DYNAMIC) NONE else e
    nondet answer = BOOLS.oneOf()
    all {
      not(st.pend.active),
      // A skill the person disabled is refused at the check, before anything else: nothing changes.
      not(st.off),
      if (hash != NONE and st.store == hash and st.storeLoc == st.loc)
        quiet({ ...base, pend: { active: true, hash: hash, approved: true, isNew: false, how: "stored", forV: st.store, forL: st.storeLoc } })
      else if (st.present)
        // The person is shown this entry (version e) at this location, and answers.
        if (answer) quiet({ ...base, pend: { active: true, hash: hash, approved: true, isNew: true, how: "fresh", forV: if (DYNAMIC) NONE else e, forL: st.loc } })
        else quiet(base)
      else
        // Nobody to ask: Claude Code's own rules decide; allowed, the skill loads unapproved.
        if (answer) quiet({ ...base, pend: { active: true, hash: hash, approved: false, isNew: false, how: "none", forV: NONE, forL: st.loc } })
        else quiet(base)
    }
  }

  // A successful load from the entry `listed`: the skill's text enters the conversation.
  pure def loaded(s: State, p: Pend, listed: int): { st: State, ev: Event, kept: Kept } = {
    val mark = if (p.approved) "A" else "U"
    val keep = p.approved and p.isNew and p.hash != NONE and listed == p.hash
    val after = {
      ...s,
      held: listed, heldApproved: p.approved,
      acting: if (STICKY and s.acting == "U") "U" else mark,
      convoAny: true, convoU: s.convoU or not(p.approved), convoLast: if (STICKY) "none" else mark,
      store: if (keep) listed else s.store, storeLoc: if (keep) s.loc else s.storeLoc
    }
    {
      st: after,
      ev: { ...noEvent, kind: "content", what: "SKILL.md", v: if (DYNAMIC) s.srvBody else listed, against: listed,
            l: s.loc, approved: p.approved, forV: p.forV, forL: p.forL, how: p.how },
      kept: if (keep) { kept: true, v: listed, l: s.loc, yesV: if (p.how == "fresh") p.forV else NONE, yesL: p.forL } else noKept
    }
  }

  // The load (serve() in register.ts, SkillsHost.load()): exactly the approved set, verified, or nothing.
  pure def load(s: State, p: Pend): { st: State, ev: Event, kept: Kept } = {
    val s0 = { ...s, pend: noPend }
    val expected = p.hash
    val known = if (s.held != NONE and expected == NONE) NONE else s.registry
    val listed1 = if (known != NONE) known else s.srvEntry
    val s1 = if (known != NONE) s0 else { ...s0, registry: listed1 }
    // A listed entry may be stale: it is read once more with skills/get, and the load tried from that.
    val listed2 = s.srvEntry
    val s2 = { ...s1, registry: listed2 }
    val failed1 = { st: s1, ev: noEvent, kept: noKept }
    val failed2 = { st: s2, ev: noEvent, kept: noKept }
    if (expected != NONE and listed1 != expected) failed1
    else if (DYNAMIC or s.srvBody == listed1) loaded(s1, p, listed1)
    else if (known == NONE) failed1
    else if (expected != NONE and listed2 != expected) failed2
    else if (s.srvBody == listed2) loaded(s2, p, listed2)
    else failed2
  }

  // A skill disabled since the check is refused when the call runs: the store is read again there.
  action runLoad = {
    val r = load(st, st.pend)
    all { st.pend.active, if (st.off) quiet({ ...st, pend: noPend }) else go(r.st, r.ev, r.kept) }
  }

  // Unchecked: a load_skill call that reached the tool with no permission check (another mod's): approved by nobody.
  // Refused, with nothing changed, while the skill is disabled.
  action unchecked = {
    val r = load(st, { ...noPend, active: true, forL: st.loc })
    all { not(st.pend.active), not(st.off), go(r.st, r.ev, r.kept) }
  }

  // ReadFile: read_skill_file, resolved against the held entry only, and verified.
  action readFile = all {
    st.held != NONE,
    not(st.off),
    DYNAMIC or st.srvFile == st.held,
    go(st, { ...noEvent, kind: "content", what: "file", v: st.srvFile, against: st.held, l: st.loc, approved: st.heldApproved,
             forV: if (st.heldApproved) st.held else NONE, forL: st.loc, how: if (st.heldApproved) "stored" else "none" }, noKept)
  }

  // Tool: any other tool call, through the gate in tool.check. "act": a tool outside the allowed list
  // (a command, a write, a subagent, another server's tool); "read-own", "read-other": Claude Code's
  // own resource read, from the skill's server or from the other one. A "deny" rule runs nothing.
  action tool = {
    nondet kind = Set("act", "read-own", "read-other").oneOf()
    nondet rule = Set("allow", "ask").oneOf()
    nondet yes = BOOLS.oneOf()
    val byMod = if (kind == "act") st.acting == "U" else if (kind == "read-other") st.acting != "none" else false
    val decision = if (byMod) (if (st.present) "ask" else "deny") else rule
    all {
      decision == "allow" or (decision == "ask" and st.present and yes),
      go(st, { ...noEvent, kind: "run", tool: kind, unapprovedInContext: st.convoU, skillInContext: st.convoAny, personYes: decision == "ask" }, noKept)
    }
  }

  // Offer: the skill's line enters the model's context: the session's skill listing, composed after
  // the helper was told the list as the store holds it now, or list_skills. Only a skill the helper
  // has an entry for is listed.
  action offer = all { st.registry != NONE, not(st.off), go(st, { ...noEvent, kind: "offer" }, noKept) }

  // Disable / Enable: /mcp-skills disable and enable, here or in another session (the list is the
  // mod's store). Neither touches the conversation: a skill loaded before is still acted on.
  action disable = all { not(st.off), quiet({ ...st, off: true }) }
  action enable = all { st.off, quiet({ ...st, off: false }) }

  // HelperRestart: the helper stops and is started again: its registry and held entry are gone.
  action helperRestart = quiet({ ...st, registry: NONE, held: NONE, heldApproved: false })

  // Resume: Claude Code starts again on the same conversation, with the server where it was or
  // elsewhere, with or without a person; the hooks module reads the conversation back.
  action resume = {
    nondet present = BOOLS.oneOf()
    nondet l = LOCS.oneOf()
    nondet lose = BOOLS.oneOf()
    val back = if (not(st.convoAny)) "none" else if (STICKY) (if (st.convoU) "U" else "A") else st.convoLast
    all {
      LOSSY or not(lose),
      quiet({ ...st, pend: noPend, registry: NONE, held: NONE, heldApproved: false, present: present, loc: l, acting: if (lose) "none" else back })
    }
  }

  // Clear: /clear ends the conversation, and the acting window with it.
  action clear = quiet({ ...st, pend: noPend, held: NONE, heldApproved: false, acting: "none", convoAny: false, convoU: false, convoLast: "none" })

  // Forget: /mcp-skills forget.
  action forget = all { st.store != NONE, quiet({ ...st, store: NONE, storeLoc: NONE }) }

  // ElsewhereYes: the person approves the skill, as it is now, in another session on this machine.
  action elsewhereYes = all {
    not(DYNAMIC),
    go({ ...st, store: st.srvEntry, storeLoc: st.loc }, noEvent, { kept: true, v: st.srvEntry, l: st.loc, yesV: st.srvEntry, yesL: st.loc })
  }

  action step = any {
    serverSetEntry, serverSetBody, serverSetFile, listSkills, check, runLoad, unchecked, readFile, tool,
    helperRestart, resume, clear, forget, elsewhereYes, offer, disable, enable
  }

  // ---- Invariants (same names as in model.ts).

  // Content that reaches the model as approved is exactly the set the person said yes to, at the
  // location they said it for; a dynamic skill's SKILL.md only with a yes given in this load's check.
  val ApprovedContent = ev.kind != "content" or not(ev.approved) or
    (if (DYNAMIC) (ev.what != "SKILL.md" or ev.how == "fresh") else (ev.forV == ev.v and ev.forL == ev.l and ev.how != "none"))
  // A file whose bytes do not match the entry it is read under is never used.
  val Verified = ev.kind != "content" or DYNAMIC or ev.v == ev.against
  // An approval is kept only for exactly the set and location the person said yes to.
  val KeptIsConsented = not(kept.kept) or (kept.yesV == kept.v and kept.yesL == kept.l)
  // While unapproved skill text is in the conversation, nothing outside the allowed list runs
  // without the person's yes for that call.
  val Gate = ev.kind != "run" or ev.tool != "act" or not(ev.unapprovedInContext) or ev.personYes
  // While a skill is in the conversation, a resource read from another server runs only with the
  // person's yes for that call.
  val CrossServerRead = ev.kind != "run" or ev.tool != "read-other" or not(ev.skillInContext) or ev.personYes
  // With nobody present there is no yes.
  val NobodyAnswers = ev.kind != "run" or not(ev.personYes) or st.present
  // Nothing is kept for a skill that cannot be content-bound.
  val NoKeptYesForDynamic = not(DYNAMIC) or st.store == NONE
  // The helper holds an entry only for a skill the conversation acts on.
  val HeldImpliesActing = st.held == NONE or st.convoAny
  // With nothing lost on read-back, the hooks module knows whether the conversation acts on the skill, and whether unapproved.
  val ActingMatchesConversation = LOSSY or not(STICKY) or ((st.acting != "none") == st.convoAny and (st.acting == "U") == st.convoU)

  // While the person has the skill disabled, nothing of it enters the model's context: not its
  // listing line, not its SKILL.md, not a file. (No step that adds content changes off.)
  val DisabledNeverReaches = (ev.kind != "content" and ev.kind != "offer") or not(st.off)

  val Safety = ApprovedContent and Verified and KeptIsConsented and Gate and CrossServerRead and NobodyAnswers
    and NoKeptYesForDynamic and HeldImpliesActing and ActingMatchesConversation and DisabledNeverReaches

  // ---- Which servers are used at all (config.ts discoverServers, then Claude Code's own verdict).
  pure def used(trust: str, fromRepo: bool, person: bool, repo: bool, rejected: bool, off: bool, claudeCodeUses: bool): bool =
    if (not(claudeCodeUses) or off) false
    else if (not(fromRepo)) true
    else if (trust == "none" or rejected) false
    else person or (trust == "own" and repo)

  // A repository's own settings never approve its servers when its trust is inherited; an untrusted
  // or rejected repository server is never used; nothing Claude Code does not use is used.
  val ServerRule = Set("none", "own", "inherited").forall(trust => BOOLS.forall(fromRepo => BOOLS.forall(person =>
    BOOLS.forall(repo => BOOLS.forall(rejected => BOOLS.forall(off => BOOLS.forall(cc =>
      val u = used(trust, fromRepo, person, repo, rejected, off, cc)
      (not(u and fromRepo and trust == "inherited") or person)
        and (not(u and fromRepo) or (trust != "none" and not(rejected)))
        and (not(u) or (cc and not(off)))
    )))))))
}

// The instances simulated (`quint run --main=<instance> --invariant=Safety`). Manifest.cfg,
// Dynamic.cfg, Rule030.cfg and Lossy.cfg are the same four for TLC.
module manifest { import skillGate(DYNAMIC = false, STICKY = true, LOSSY = false, NVERSIONS = 3).* }
module dynamic { import skillGate(DYNAMIC = true, STICKY = true, LOSSY = false, NVERSIONS = 3).* }
// Expected to fail, with a counterexample: 0.3.0's rule, and the documented read-back limit.
module rule030 { import skillGate(DYNAMIC = false, STICKY = false, LOSSY = false, NVERSIONS = 3).* }
module lossy { import skillGate(DYNAMIC = false, STICKY = true, LOSSY = true, NVERSIONS = 3).* }
