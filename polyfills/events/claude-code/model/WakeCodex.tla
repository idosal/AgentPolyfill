------------------------------ MODULE WakeCodex ------------------------------
(***************************************************************************)
(* wakeCodex.qnt in TLA+, for TLC: how often events wake a Codex session   *)
(* in mcp-events for Codex. The wake budget (core/src/wake.ts, kept in     *)
(* wakes.json, with the pause that also lifts by itself), the hand-over    *)
(* through `codex queue` (codex/src/threads.ts, waker.ts), which calls     *)
(* count as the person's (codex/src/meta.ts), and a session `codex queue`  *)
(* cannot reach. The helper may die between any two steps; events arrive  *)
(* at any time; calls come from the person's turns and from others. One    *)
(* session, one watch.                                                     *)
(*                                                                         *)
(* Written by hand from wakeCodex.qnt, action for action and with the same *)
(* state (one record, s), so that Quint's traces can be replayed here as   *)
(* they are: model/conform.mjs does that. Quint's init variants are the    *)
(* constants ALLOW and LIFT: TRUE and 4 is 0.1.2; FALSE and 0 is 0.1.2     *)
(* with CX1's fix taken out (0.1.0's rule and pause).                      *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
    ALLOW,      \* TRUE: the allowlist (0.1.1 on); FALSE: 0.1.0's denylist
    LIFT,       \* liftAfterMs, in units; 0: the pause lasts until the person speaks (0.1.0)
    MAX_TIME,   \* the clock's bound; one unit stands for fifteen minutes
    HOUR,       \* an hour, in those units
    GAP,        \* MCP_EVENTS_WAKE_GAP_S: how soon one watch may start another wake
    PER_HOUR,   \* MCP_EVENTS_WAKES_PER_HOUR
    PENDING     \* the model's bound: events stored and not yet handed over, at most

ASSUME ALLOW \in BOOLEAN /\ LIFT \in Nat /\ MAX_TIME \in Nat /\ HOUR \in Nat /\ GAP \in Nat
       /\ PER_HOUR \in Nat /\ PENDING \in Nat

\* What Codex says started the turn a call is made in (turn_trigger); "none": no turn metadata.
PersonsTriggers == {"user", "exec", "realtime", "voice", "none"}
OtherTriggers == {"queue", "hook", "none"}

\* The state, as in wakeCodex.qnt:
\*   allow, lift, local (codex queue can reach the session); now; stored (events in the
\*   spool); pos (how many were handed over, on disk); budget (wakes.json: wakes, last,
\*   paused, pausedAt (-1 unset), noticeHanded); helper; unwakeable (the helper's memory);
\*   queued ("", "batch" or "notice": run through codex queue, not heard back about); upto
\*   (the batch's end); answered (codex queue took it, the helper has not heard so); and
\*   history: spoke, shown, carried, noticeAt, quiet, early, twice, byOther, refused, retried.
VARIABLE s

MaxOf(a, b) == IF a > b THEN a ELSE b
Recent(l, t) == SelectSeq(l, LAMBDA x : t - x < HOUR)
IsThePersons(allow, trigger) ==
    IF allow THEN trigger \in {"user", "exec", "realtime", "voice"} ELSE trigger # "queue"
QuietFrom(lift, t) == IF lift > 0 THEN t + lift ELSE 1000
Pause(b, lift, t) == [b EXCEPT !.paused = TRUE, !.noticeHanded = FALSE,
                               !.pausedAt = IF lift > 0 THEN t ELSE b.pausedAt]

Init == \E local \in BOOLEAN :
          s = [allow |-> ALLOW, lift |-> LIFT, local |-> local, now |-> 0, stored |-> 0, pos |-> 0,
               budget |-> [wakes |-> <<>>, last |-> -100, paused |-> FALSE, pausedAt |-> -1, noticeHanded |-> FALSE],
               helper |-> TRUE, unwakeable |-> FALSE, queued |-> "", upto |-> 0, answered |-> FALSE,
               spoke |-> 0, shown |-> <<>>, carried |-> 0, noticeAt |-> -100, quiet |-> -100,
               early |-> FALSE, twice |-> FALSE, byOther |-> FALSE, refused |-> FALSE, retried |-> FALSE]

Tick == s.now < MAX_TIME /\ s' = [s EXCEPT !.now = s.now + 1]

\* The watch stores an event, whatever the wake budget says and whether or not the session can be woken.
Arrive == s.helper /\ s.stored - s.pos < PENDING /\ s' = [s EXCEPT !.stored = s.stored + 1]

\* WakeBudget.gate on a paused budget, once the pause's time has passed: the hour starts again.
Lift == /\ s.helper /\ s.budget.paused /\ s.lift > 0 /\ s.now >= s.budget.pausedAt + s.lift
        /\ s' = [s EXCEPT !.budget = [s.budget EXCEPT !.paused = FALSE, !.pausedAt = -1, !.wakes = <<>>]]

\* #handOver: the next batch, through the gate; past the hour's wakes the notice (noticeHanded
\* first). Either way codex queue is run. Not for a session the helper knows it cannot reach.
Takes == /\ s.helper /\ s.queued = "" /\ ~s.unwakeable /\ s.stored > s.pos
         /\ ~s.budget.paused /\ s.now - s.budget.last >= GAP
Take == LET notice == Len(Recent(s.budget.wakes, s.now)) >= PER_HOUR IN
        /\ Takes
        /\ s' = [s EXCEPT !.queued = IF notice THEN "notice" ELSE "batch", !.upto = s.stored, !.answered = FALSE,
                          !.budget = IF notice THEN [s.budget EXCEPT !.noticeHanded = TRUE] ELSE s.budget,
                          !.retried = s.retried \/ s.refused]

\* codex queue takes the message: a turn starts (the session is woken), whether or not the
\* helper lives to hear so.
QueueOk == /\ s.helper /\ s.queued # "" /\ ~s.answered /\ s.local
           /\ s' = IF s.queued = "batch"
                   THEN [s EXCEPT !.answered = TRUE, !.shown = Append(s.shown, s.now),
                                  !.carried = MaxOf(s.carried, s.upto), !.early = s.early \/ s.now < s.quiet]
                   ELSE [s EXCEPT !.answered = TRUE,
                                  !.twice = s.twice \/ (s.noticeAt >= 0 /\ (s.lift = 0 \/ s.now - s.noticeAt < s.lift)),
                                  !.noticeAt = s.now, !.quiet = MaxOf(s.quiet, QuietFrom(s.lift, s.now))]
\* It fails, and the helper hears so: it tries again later. The notice stays handed over.
QueueFails == s.helper /\ s.queued # "" /\ ~s.answered /\ s.local /\ s' = [s EXCEPT !.queued = ""]
\* "no rollout found": no try can reach this session, and the helper stops trying (in memory).
QueueRefused == /\ s.helper /\ s.queued # "" /\ ~s.answered /\ ~s.local
                /\ s' = [s EXCEPT !.queued = "", !.unwakeable = TRUE, !.refused = TRUE]

\* The helper hears that codex queue took it: a batch counts as a wake (WakeBudget.woke) and is
\* marked handed over (Delivery.ack); the notice pauses waking.
Heard == /\ s.helper /\ s.answered
         /\ s' = IF s.queued = "batch"
                 THEN [s EXCEPT !.queued = "", !.answered = FALSE, !.pos = s.upto,
                                !.budget = [s.budget EXCEPT !.wakes = Append(Recent(s.budget.wakes, s.now), s.now),
                                                            !.last = s.now, !.noticeHanded = FALSE]]
                 ELSE [s EXCEPT !.queued = "", !.answered = FALSE, !.budget = Pause(s.budget, s.lift, s.now),
                                !.quiet = MaxOf(s.quiet, QuietFrom(s.lift, s.now))]

HelperDies == s.helper /\ s' = [s EXCEPT !.helper = FALSE, !.queued = "", !.answered = FALSE, !.unwakeable = FALSE]
\* A new helper reads the budget and the position from disk. A notice handed to codex queue by a
\* helper that stopped before it heard back counts as given (the ThreadSession constructor).
HelperStarts == /\ ~s.helper
                /\ s' = IF s.budget.noticeHanded
                        THEN [s EXCEPT !.helper = TRUE, !.budget = Pause(s.budget, s.lift, s.now),
                                       !.quiet = MaxOf(s.quiet, QuietFrom(s.lift, s.now))]
                        ELSE [s EXCEPT !.helper = TRUE]

\* A tools/call in a turn the person started (person) or not, with what Codex says started it.
\* If IsThePersons, WakeBudget.spoke: the pause ends and the hour starts again.
CallIn(person, trigger) ==
    LET theirs == IsThePersons(s.allow, trigger)
        reset == theirs /\ (s.budget.paused \/ Len(s.budget.wakes) > 0)
    IN /\ s.helper
       /\ s' = [s EXCEPT !.budget = IF reset THEN [s.budget EXCEPT !.paused = FALSE, !.pausedAt = -1, !.wakes = <<>>]
                                   ELSE s.budget,
                         !.spoke = IF person /\ theirs THEN Len(s.shown) ELSE s.spoke,
                         !.noticeAt = IF person /\ theirs THEN -100 ELSE s.noticeAt,
                         !.quiet = IF person /\ theirs THEN -100 ELSE s.quiet,
                         !.byOther = s.byOther \/ (~person /\ reset)]
PersonCall == \E t \in PersonsTriggers : CallIn(TRUE, t)
OtherCall == \E t \in OtherTriggers : CallIn(FALSE, t)

Next == \/ Tick \/ Arrive \/ Lift \/ Take \/ QueueOk \/ QueueFails \/ QueueRefused \/ Heard
        \/ HelperDies \/ HelperStarts \/ PersonCall \/ OtherCall

Spec == Init /\ [][Next]_s

\* ---- Invariants (the same names as in wakeCodex.qnt).

\* 1. Between two calls of the person's own turns, no hour holds more than PER_HOUR wakes, across
\*    the pause lifting by itself. (wakeCodex.qnt's indices are 0-based; here 1-based, so
\*    "i < spoke" is "i <= spoke".)
Window(l, i, from) == Cardinality({j \in DOMAIN l : j > from /\ j <= i /\ l[i] - l[j] < HOUR})
WithinHour == \A i \in DOMAIN s.shown : i <= s.spoke \/ Window(s.shown, i, s.spoke) <= PER_HOUR
\* 2. Two wakes are at least GAP apart (one watch).
Gap == \A i \in DOMAIN s.shown : i = 1 \/ s.shown[i] - s.shown[i - 1] >= GAP
\* 3. Only a call from the person's own turn starts the hour again or ends the pause.
OnlyThePerson == ~s.byOther
\* 4. Once the session is told that waking stopped (or waking pauses), no wake comes until the
\*    person's own call, or until the pause's time has passed.
QuietAfterNotice == ~s.early
\* 5. The session is told at most once in a pause that waking stopped.
OneNotice == ~s.twice
\* 6. A helper that heard "no rollout found" runs no codex queue for that session again, and a
\*    session codex queue cannot reach is never woken.
NoWakeUnwakeable == ~(s.unwakeable /\ s.queued # "") /\ (s.local \/ Len(s.shown) = 0)
\* 7. Nothing is lost: what is not handed over stays stored, and the hand-over never passes an
\*    event that no wake carried.
NothingLost == s.pos <= s.carried /\ s.pos <= s.stored
\* A documented limit: unwakeable is kept in memory, so a new helper runs codex queue once more.
NeverRetried == ~s.retried
Kept == WithinHour /\ Gap /\ OnlyThePerson /\ QuietAfterNotice /\ OneNotice /\ NoWakeUnwakeable /\ NothingLost
=============================================================================
