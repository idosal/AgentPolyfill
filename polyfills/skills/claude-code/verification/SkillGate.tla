----------------------------- MODULE SkillGate -----------------------------
(***************************************************************************)
(* skillGate.qnt in TLA+, for TLC: the mcp-skills mod's skill gate.        *)
(* Approval, loading, verification, the acting window, the gate on other   *)
(* tool calls, and the person disabling and enabling the skill. One server *)
(* serves a skill and may change its entry, its SKILL.md and a supporting  *)
(* file at any moment, each separately; a second server is only a place    *)
(* resources can be read from.                                             *)
(*                                                                         *)
(* Written by hand from skillGate.qnt, action for action and invariant for *)
(* invariant, with the same three variables (st, ev, kept), so that Quint's *)
(* traces can be replayed here as they are (verification/conform.mjs does  *)
(* that). docs/verification.md maps each part to the code and says what    *)
(* checking it shows.                                                      *)
(***************************************************************************)
EXTENDS Integers

CONSTANTS
    DYNAMIC,    \* the skill has no manifest: no digests, nothing to bind an approval to
    STICKY,     \* TRUE: a skill loaded unapproved stays unapproved until /clear (0.3.1); FALSE: 0.3.0's rule
    LOSSY,      \* a resume may miss the load when it reads the conversation back (the documented limit)
    NVERSIONS   \* how many versions each part of the skill can be in

ASSUME DYNAMIC \in BOOLEAN /\ STICKY \in BOOLEAN /\ LOSSY \in BOOLEAN /\ NVERSIONS \in Nat \ {0}

NONE == -1
LOCS == {0, 1}
Versions == 0..(NVERSIONS - 1)

\* st: the state (see skillGate.qnt for each field). ev: what the step did that an invariant is
\* about (content entering the conversation, or a tool call running). kept: an approval kept by
\* the step, and the yes it was kept for.
VARIABLES st, ev, kept
vars == <<st, ev, kept>>

NoPend == [active |-> FALSE, hash |-> NONE, approved |-> FALSE, isNew |-> FALSE, how |-> "none", forV |-> NONE, forL |-> NONE]
NoEvent == [kind |-> "none", what |-> "", v |-> NONE, against |-> NONE, l |-> NONE, approved |-> FALSE,
            forV |-> NONE, forL |-> NONE, how |-> "none",
            tool |-> "", unapprovedInContext |-> FALSE, skillInContext |-> FALSE, personYes |-> FALSE]
NoKept == [kept |-> FALSE, v |-> NONE, l |-> NONE, yesV |-> NONE, yesL |-> NONE]

Go(s, e, k) == st' = s /\ ev' = e /\ kept' = k
Quiet(s) == Go(s, NoEvent, NoKept)

Init == \E present \in BOOLEAN, l \in LOCS :
    /\ st = [srvEntry |-> 0, srvBody |-> 0, srvFile |-> 0, loc |-> l, registry |-> NONE, held |-> NONE,
             heldApproved |-> FALSE, store |-> NONE, storeLoc |-> NONE, pend |-> NoPend, present |-> present,
             acting |-> "none", convoAny |-> FALSE, convoU |-> FALSE, convoLast |-> "none", off |-> FALSE]
    /\ ev = NoEvent
    /\ kept = NoKept

\* ServerSetEntry / ServerSetBody / ServerSetFile: the server changes one part of its skill.
ServerSetEntry == \E v \in Versions : Quiet([st EXCEPT !.srvEntry = v])
ServerSetBody == \E v \in Versions : Quiet([st EXCEPT !.srvBody = v])
ServerSetFile == \E v \in Versions : Quiet([st EXCEPT !.srvFile = v])

\* List: skills/list puts the server's current entry in the registry.
ListSkills == Quiet([st EXCEPT !.registry = st.srvEntry])

\* Check: the permission check of a load_skill call (tool.check in register.ts, App.entry).
Check ==
    \* SkillsHost.entry(): a loaded skill is asked about afresh; otherwise the registry's entry, or skills/get.
    LET e == IF st.held # NONE THEN st.srvEntry ELSE IF st.registry # NONE THEN st.registry ELSE st.srvEntry
        base == [st EXCEPT !.registry = e]
        hash == IF DYNAMIC THEN NONE ELSE e
    IN \E answer \in BOOLEAN :
        /\ ~st.pend.active
        \* A skill the person disabled is refused at the check, before anything else: nothing changes.
        /\ ~st.off
        /\ IF hash # NONE /\ st.store = hash /\ st.storeLoc = st.loc
           THEN Quiet([base EXCEPT !.pend = [active |-> TRUE, hash |-> hash, approved |-> TRUE, isNew |-> FALSE,
                                             how |-> "stored", forV |-> st.store, forL |-> st.storeLoc]])
           ELSE IF st.present
           \* The person is shown this entry (version e) at this location, and answers.
           THEN IF answer
                THEN Quiet([base EXCEPT !.pend = [active |-> TRUE, hash |-> hash, approved |-> TRUE, isNew |-> TRUE,
                                                  how |-> "fresh", forV |-> IF DYNAMIC THEN NONE ELSE e, forL |-> st.loc]])
                ELSE Quiet(base)
           \* Nobody to ask: Claude Code's own rules decide; allowed, the skill loads unapproved.
           ELSE IF answer
                THEN Quiet([base EXCEPT !.pend = [active |-> TRUE, hash |-> hash, approved |-> FALSE, isNew |-> FALSE,
                                                  how |-> "none", forV |-> NONE, forL |-> st.loc]])
                ELSE Quiet(base)

\* A successful load from the entry `listed`: the skill's text enters the conversation.
Loaded(s, p, listed) ==
    LET mark == IF p.approved THEN "A" ELSE "U"
        keep == p.approved /\ p.isNew /\ p.hash # NONE /\ listed = p.hash
        after == [s EXCEPT !.held = listed, !.heldApproved = p.approved,
                           !.acting = IF STICKY /\ s.acting = "U" THEN "U" ELSE mark,
                           !.convoAny = TRUE, !.convoU = s.convoU \/ ~p.approved,
                           !.convoLast = IF STICKY THEN "none" ELSE mark,
                           !.store = IF keep THEN listed ELSE s.store,
                           !.storeLoc = IF keep THEN s.loc ELSE s.storeLoc]
    IN [st |-> after,
        ev |-> [NoEvent EXCEPT !.kind = "content", !.what = "SKILL.md", !.v = IF DYNAMIC THEN s.srvBody ELSE listed,
                               !.against = listed, !.l = s.loc, !.approved = p.approved, !.forV = p.forV,
                               !.forL = p.forL, !.how = p.how],
        kept |-> IF keep THEN [kept |-> TRUE, v |-> listed, l |-> s.loc,
                               yesV |-> IF p.how = "fresh" THEN p.forV ELSE NONE, yesL |-> p.forL]
                 ELSE NoKept]

\* The load (serve() in register.ts, SkillsHost.load()): exactly the approved set, verified, or nothing.
Load(s, p) ==
    LET s0 == [s EXCEPT !.pend = NoPend]
        expected == p.hash
        known == IF s.held # NONE /\ expected = NONE THEN NONE ELSE s.registry
        listed1 == IF known # NONE THEN known ELSE s.srvEntry
        s1 == IF known # NONE THEN s0 ELSE [s0 EXCEPT !.registry = listed1]
        \* A listed entry may be stale: it is read once more with skills/get, and the load tried from that.
        listed2 == s.srvEntry
        s2 == [s1 EXCEPT !.registry = listed2]
        failed1 == [st |-> s1, ev |-> NoEvent, kept |-> NoKept]
        failed2 == [st |-> s2, ev |-> NoEvent, kept |-> NoKept]
    IN IF expected # NONE /\ listed1 # expected THEN failed1
       ELSE IF DYNAMIC \/ s.srvBody = listed1 THEN Loaded(s1, p, listed1)
       ELSE IF known = NONE THEN failed1
       ELSE IF expected # NONE /\ listed2 # expected THEN failed2
       ELSE IF s.srvBody = listed2 THEN Loaded(s2, p, listed2)
       ELSE failed2

\* A skill disabled since the check is refused when the call runs: the store is read again there.
RunLoad == /\ st.pend.active
           /\ IF st.off THEN Quiet([st EXCEPT !.pend = NoPend])
              ELSE LET r == Load(st, st.pend) IN Go(r.st, r.ev, r.kept)

\* Unchecked: a load_skill call that reached the tool with no permission check (another mod's): approved by nobody.
\* Refused, with nothing changed, while the skill is disabled.
Unchecked == ~st.pend.active /\ ~st.off /\ LET r == Load(st, [NoPend EXCEPT !.active = TRUE, !.forL = st.loc]) IN Go(r.st, r.ev, r.kept)

\* ReadFile: read_skill_file, resolved against the held entry only, and verified.
ReadFile ==
    /\ st.held # NONE
    /\ ~st.off
    /\ DYNAMIC \/ st.srvFile = st.held
    /\ Go(st, [NoEvent EXCEPT !.kind = "content", !.what = "file", !.v = st.srvFile, !.against = st.held,
                              !.l = st.loc, !.approved = st.heldApproved,
                              !.forV = IF st.heldApproved THEN st.held ELSE NONE, !.forL = st.loc,
                              !.how = IF st.heldApproved THEN "stored" ELSE "none"], NoKept)

\* Tool: any other tool call, through the gate in tool.check. "act": a tool outside the allowed list
\* (a command, a write, a subagent, another server's tool); "read-own", "read-other": Claude Code's
\* own resource read, from the skill's server or from the other one. A "deny" rule runs nothing.
Tool == \E kind \in {"act", "read-own", "read-other"}, rule \in {"allow", "ask"}, yes \in BOOLEAN :
    LET byMod == IF kind = "act" THEN st.acting = "U" ELSE IF kind = "read-other" THEN st.acting # "none" ELSE FALSE
        decision == IF byMod THEN (IF st.present THEN "ask" ELSE "deny") ELSE rule
    IN /\ decision = "allow" \/ (decision = "ask" /\ st.present /\ yes)
       /\ Go(st, [NoEvent EXCEPT !.kind = "run", !.tool = kind, !.unapprovedInContext = st.convoU,
                                 !.skillInContext = st.convoAny, !.personYes = (decision = "ask")], NoKept)

\* Offer: the skill's line enters the model's context: the session's skill listing, composed after
\* the helper was told the list as the store holds it now, or list_skills. Only a skill the helper
\* has an entry for is listed.
Offer == st.registry # NONE /\ ~st.off /\ Go(st, [NoEvent EXCEPT !.kind = "offer"], NoKept)

\* Disable / Enable: /mcp-skills disable and enable, here or in another session (the list is the
\* mod's store). Neither touches the conversation: a skill loaded before is still acted on.
Disable == ~st.off /\ Quiet([st EXCEPT !.off = TRUE])
Enable == st.off /\ Quiet([st EXCEPT !.off = FALSE])

\* HelperRestart: the helper stops and is started again: its registry and held entry are gone.
HelperRestart == Quiet([st EXCEPT !.registry = NONE, !.held = NONE, !.heldApproved = FALSE])

\* Resume: Claude Code starts again on the same conversation, with the server where it was or
\* elsewhere, with or without a person; the hooks module reads the conversation back.
Resume == \E present \in BOOLEAN, l \in LOCS, lose \in BOOLEAN :
    LET back == IF ~st.convoAny THEN "none" ELSE IF STICKY THEN (IF st.convoU THEN "U" ELSE "A") ELSE st.convoLast
    IN /\ LOSSY \/ ~lose
       /\ Quiet([st EXCEPT !.pend = NoPend, !.registry = NONE, !.held = NONE, !.heldApproved = FALSE,
                           !.present = present, !.loc = l, !.acting = IF lose THEN "none" ELSE back])

\* Clear: /clear ends the conversation, and the acting window with it.
Clear == Quiet([st EXCEPT !.pend = NoPend, !.held = NONE, !.heldApproved = FALSE, !.acting = "none",
                          !.convoAny = FALSE, !.convoU = FALSE, !.convoLast = "none"])

\* Forget: /mcp-skills forget.
Forget == st.store # NONE /\ Quiet([st EXCEPT !.store = NONE, !.storeLoc = NONE])

\* ElsewhereYes: the person approves the skill, as it is now, in another session on this machine.
ElsewhereYes == /\ ~DYNAMIC
                /\ Go([st EXCEPT !.store = st.srvEntry, !.storeLoc = st.loc], NoEvent,
                      [kept |-> TRUE, v |-> st.srvEntry, l |-> st.loc, yesV |-> st.srvEntry, yesL |-> st.loc])

Next == \/ ServerSetEntry \/ ServerSetBody \/ ServerSetFile \/ ListSkills \/ Check \/ RunLoad \/ Unchecked
        \/ ReadFile \/ Tool \/ HelperRestart \/ Resume \/ Clear \/ Forget \/ ElsewhereYes
        \/ Offer \/ Disable \/ Enable

Spec == Init /\ [][Next]_vars

\* ---- Invariants (the same names as in skillGate.qnt and model.ts).

\* Content that reaches the model as approved is exactly the set the person said yes to, at the
\* location they said it for; a dynamic skill's SKILL.md only with a yes given in this load's check.
ApprovedContent == ev.kind # "content" \/ ~ev.approved \/
    (IF DYNAMIC THEN (ev.what # "SKILL.md" \/ ev.how = "fresh")
     ELSE (ev.forV = ev.v /\ ev.forL = ev.l /\ ev.how # "none"))
\* A file whose bytes do not match the entry it is read under is never used.
Verified == ev.kind # "content" \/ DYNAMIC \/ ev.v = ev.against
\* An approval is kept only for exactly the set and location the person said yes to.
KeptIsConsented == ~kept.kept \/ (kept.yesV = kept.v /\ kept.yesL = kept.l)
\* While unapproved skill text is in the conversation, nothing outside the allowed list runs
\* without the person's yes for that call.
Gate == ev.kind # "run" \/ ev.tool # "act" \/ ~ev.unapprovedInContext \/ ev.personYes
\* While a skill is in the conversation, a resource read from another server runs only with the
\* person's yes for that call.
CrossServerRead == ev.kind # "run" \/ ev.tool # "read-other" \/ ~ev.skillInContext \/ ev.personYes
\* With nobody present there is no yes.
NobodyAnswers == ev.kind # "run" \/ ~ev.personYes \/ st.present
\* Nothing is kept for a skill that cannot be content-bound.
NoKeptYesForDynamic == ~DYNAMIC \/ st.store = NONE
\* The helper holds an entry only for a skill the conversation acts on.
HeldImpliesActing == st.held = NONE \/ st.convoAny
\* With nothing lost on read-back, the hooks module knows whether the conversation acts on the skill, and whether unapproved.
ActingMatchesConversation == LOSSY \/ ~STICKY \/ ((st.acting # "none") = st.convoAny /\ (st.acting = "U") = st.convoU)

\* While the person has the skill disabled, nothing of it enters the model's context: not its
\* listing line, not its SKILL.md, not a file. (No step that adds content changes off.)
DisabledNeverReaches == (ev.kind # "content" /\ ev.kind # "offer") \/ ~st.off

Safety == ApprovedContent /\ Verified /\ KeptIsConsented /\ Gate /\ CrossServerRead /\ NobodyAnswers
          /\ NoKeptYesForDynamic /\ HeldImpliesActing /\ ActingMatchesConversation /\ DisabledNeverReaches

\* ---- Which servers are used at all (config.ts discoverServers, then Claude Code's own verdict).
Used(trust, fromRepo, person, repo, rejected, off, claudeCodeUses) ==
    IF ~claudeCodeUses \/ off THEN FALSE
    ELSE IF ~fromRepo THEN TRUE
    ELSE IF trust = "none" \/ rejected THEN FALSE
    ELSE person \/ (trust = "own" /\ repo)

\* A repository's own settings never approve its servers when its trust is inherited; an untrusted
\* or rejected repository server is never used; nothing Claude Code does not use is used.
ServerRule == \A trust \in {"none", "own", "inherited"}, fromRepo, person, repo, rejected, off, cc \in BOOLEAN :
    LET u == Used(trust, fromRepo, person, repo, rejected, off, cc)
    IN /\ (~(u /\ fromRepo /\ trust = "inherited") \/ person)
       /\ (~(u /\ fromRepo) \/ (trust # "none" /\ ~rejected))
       /\ (~u \/ (cc /\ ~off))

\* For comparing with verification/model.ts, which counts states of st alone (ev and kept are what
\* a step did, not where it leaves the gate): a configuration with VIEW StOnly counts those. Not
\* for checking: under it a step into a state already seen is not checked.
StOnly == st
=============================================================================
