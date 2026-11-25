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
(* constants ALLOW, LIFT and RECORD: TRUE, 4 and TRUE is 0.1.3; RECORD     *)
(* FALSE is 0.1.2 (no record of the hand-over, no timeout counted, a       *)
(* failed notice kept as handed over); ALLOW FALSE and LIFT 0 is 0.1.0's   *)
(* rule and pause.                                                         *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
    ALLOW,      \* TRUE: the allowlist (0.1.1 on); FALSE: 0.1.0's denylist
    LIFT,       \* liftAfterMs, in units; 0: the pause lasts until the person speaks (0.1.0)
    RECORD,     \* TRUE: 0.1.3's record of the hand-over, timeout and dropNotice; FALSE: 0.1.2
    MAX_TIME,   \* the clock's bound; one unit stands for fifteen minutes
    HOUR,       \* an hour, in those units
    GAP,        \* MCP_EVENTS_WAKE_GAP_S: how soon one watch may start another wake
    PER_HOUR,   \* MCP_EVENTS_WAKES_PER_HOUR
    PENDING     \* the model's bound: events stored and not yet handed over, at most

ASSUME ALLOW \in BOOLEAN /\ LIFT \in Nat /\ RECORD \in BOOLEAN /\ MAX_TIME \in Nat /\ HOUR \in Nat
       /\ GAP \in Nat /\ PER_HOUR \in Nat /\ PENDING \in Nat

\* What Codex says started the turn a call is made in (turn_trigger); "none": no turn metadata.
PersonsTriggers == {"user", "composer", "exec", "realtime", "none"}
OtherTriggers == {"queue", "hook", "none"}

\* The state, as in wakeCodex.qnt:
\*   allow, lift, record, local (codex queue can reach the session); now; stored (events in
\*   the spool); pos (how many were handed over, on disk); budget (wakes.json: wakes, last,
\*   paused, pausedAt (-1 unset), noticeHanded, handed (the recorded batch's end, -1 none));
\*   helper; unwakeable (the helper's memory); queued ("", "batch" or "notice": run through
\*   codex queue, not heard back about); upto (the batch's end); answered (codex queue took it,
\*   the helper has not heard so); and history: spoke, shown, carried, noticeAt, quiet, early,
\*   twice, byOther, refused, retried, dup, excused, noticeFailed, stale.
VARIABLE s

MaxOf(a, b) == IF a > b THEN a ELSE b
Recent(l, t) == SelectSeq(l, LAMBDA x : t - x < HOUR)
IsThePersons(allow, trigger) ==
    IF allow THEN trigger \in {"user", "composer", "exec", "realtime"} ELSE trigger # "queue"
QuietFrom(lift, t) == IF lift > 0 THEN t + lift ELSE 1000
Pause(b, lift, t) == [b EXCEPT !.paused = TRUE, !.noticeHanded = FALSE,
                               !.pausedAt = IF lift > 0 THEN t ELSE b.pausedAt]
\* WakeBudget.woke: one wake, counted now; it clears the hand-over's record in the same write.
Woke(b, t) == [b EXCEPT !.wakes = Append(Recent(b.wakes, t), t), !.last = t, !.noticeHanded = FALSE, !.handed = -1]

Init == \E local \in BOOLEAN :
          s = [allow |-> ALLOW, lift |-> LIFT, record |-> RECORD, local |-> local, now |-> 0, stored |-> 0, pos |-> 0,
               budget |-> [wakes |-> <<>>, last |-> -100, paused |-> FALSE, pausedAt |-> -1, noticeHanded |-> FALSE, handed |-> -1],
               helper |-> TRUE, unwakeable |-> FALSE, queued |-> "", upto |-> 0, answered |-> FALSE,
               spoke |-> 0, shown |-> <<>>, carried |-> 0, noticeAt |-> -100, quiet |-> -100,
               early |-> FALSE, twice |-> FALSE, byOther |-> FALSE, refused |-> FALSE, retried |-> FALSE,
               dup |-> FALSE, excused |-> 0, noticeFailed |-> FALSE, stale |-> FALSE]

Tick == s.now < MAX_TIME /\ s' = [s EXCEPT !.now = s.now + 1]

\* The watch stores an event, whatever the wake budget says and whether or not the session can be woken.
Arrive == s.helper /\ s.stored - s.pos < PENDING /\ s' = [s EXCEPT !.stored = s.stored + 1]

\* WakeBudget.gate on a paused budget, once the pause's time has passed: the hour starts again.
Lift == /\ s.helper /\ s.budget.paused /\ s.lift > 0 /\ s.now >= s.budget.pausedAt + s.lift
        /\ s' = [s EXCEPT !.budget = [s.budget EXCEPT !.paused = FALSE, !.pausedAt = -1, !.wakes = <<>>]]

\* #handOver: the next batch, through the gate; past the hour's wakes the notice (noticeHanded
\* first), else the batch (0.1.3: its record first). Either way codex queue is run. Not for a
\* session the helper knows it cannot reach.
Takes == /\ s.helper /\ s.queued = "" /\ ~s.unwakeable /\ s.stored > s.pos
         /\ ~s.budget.paused /\ s.now - s.budget.last >= GAP
Take == LET notice == Len(Recent(s.budget.wakes, s.now)) >= PER_HOUR IN
        /\ Takes
        /\ s' = [s EXCEPT !.queued = IF notice THEN "notice" ELSE "batch", !.upto = s.stored, !.answered = FALSE,
                          !.budget = IF notice THEN [s.budget EXCEPT !.noticeHanded = TRUE]
                                     ELSE IF s.record THEN [s.budget EXCEPT !.handed = s.stored]
                                     ELSE s.budget,
                          !.noticeFailed = IF notice THEN FALSE ELSE s.noticeFailed,
                          !.retried = s.retried \/ s.refused]

\* codex queue takes the message: a turn starts (the session is woken), whether or not the
\* helper lives to hear so.
QueueOk == /\ s.helper /\ s.queued # "" /\ ~s.answered /\ s.local
           /\ s' = IF s.queued = "batch"
                   THEN [s EXCEPT !.answered = TRUE, !.shown = Append(s.shown, s.now),
                                  !.carried = MaxOf(s.carried, s.upto), !.early = s.early \/ s.now < s.quiet,
                                  !.dup = s.dup \/ s.pos < s.carried]
                   ELSE [s EXCEPT !.answered = TRUE,
                                  !.twice = s.twice \/ (s.noticeAt >= 0 /\ (s.lift = 0 \/ s.now - s.noticeAt < s.lift)),
                                  !.noticeAt = s.now, !.quiet = MaxOf(s.quiet, QuietFrom(s.lift, s.now))]
\* codex queue said it did not take it: a batch's record is dropped (dropHanded), and, 0.1.3, the
\* notice is no longer handed over (dropNotice); in 0.1.2 it stayed so.
NotTaken(b, what, record) ==
    IF what = "batch" THEN [b EXCEPT !.handed = -1]
    ELSE IF record THEN [b EXCEPT !.noticeHanded = FALSE] ELSE b
\* It fails, and the helper hears so: it tries again later.
QueueFails == /\ s.helper /\ s.queued # "" /\ ~s.answered /\ s.local
              /\ s' = [s EXCEPT !.queued = "", !.budget = NotTaken(s.budget, s.queued, s.record),
                                !.noticeFailed = s.noticeFailed \/ s.queued = "notice"]
\* "no rollout found": no try can reach this session, and the helper stops trying (in memory).
QueueRefused == /\ s.helper /\ s.queued # "" /\ ~s.answered /\ ~s.local
                /\ s' = [s EXCEPT !.queued = "", !.unwakeable = TRUE, !.refused = TRUE,
                                  !.budget = NotTaken(s.budget, s.queued, s.record),
                                  !.noticeFailed = s.noticeFailed \/ s.queued = "notice"]
\* 0.1.3: codex queue times out, having queued the message or not: counted as handed over, at most
\* once. A batch is marked handed over and counted; the notice pauses waking.
QueueUnknown == /\ s.helper /\ s.queued # "" /\ s.record
                /\ s' = IF s.queued = "batch"
                        THEN [s EXCEPT !.queued = "", !.answered = FALSE, !.pos = MaxOf(s.pos, s.upto),
                                       !.budget = Woke(s.budget, s.now),
                                       !.excused = IF s.answered THEN s.excused ELSE MaxOf(s.excused, s.upto)]
                        ELSE [s EXCEPT !.queued = "", !.answered = FALSE, !.budget = Pause(s.budget, s.lift, s.now),
                                       !.quiet = MaxOf(s.quiet, QuietFrom(s.lift, s.now))]

\* The helper hears that codex queue took it: a batch is marked handed over (Delivery.ack) and
\* counts as a wake (WakeBudget.woke, which clears the record); the notice pauses waking.
Heard == /\ s.helper /\ s.answered
         /\ s' = IF s.queued = "batch"
                 THEN [s EXCEPT !.queued = "", !.answered = FALSE, !.pos = s.upto, !.budget = Woke(s.budget, s.now)]
                 ELSE [s EXCEPT !.queued = "", !.answered = FALSE, !.budget = Pause(s.budget, s.lift, s.now),
                                !.quiet = MaxOf(s.quiet, QuietFrom(s.lift, s.now))]

\* The helper ends. A batch it handed to codex queue that Codex has not taken is skipped if the
\* next helper counts it (excused).
HelperDies == /\ s.helper
              /\ s' = [s EXCEPT !.helper = FALSE, !.queued = "", !.answered = FALSE, !.unwakeable = FALSE,
                                !.excused = IF s.queued = "batch" /\ ~s.answered THEN MaxOf(s.excused, s.upto) ELSE s.excused]
\* A new helper reads the budget and the position from disk. A notice handed to codex queue by a
\* helper that ended before it heard back counts as given: it starts paused (ThreadSession.start,
\* from 0.1.5; the constructor before). Then, 0.1.3, a batch such a helper handed over (the record) is marked handed over
\* and counted, now (ThreadSession.start).
HelperStarts == LET b == IF s.budget.noticeHanded THEN Pause(s.budget, s.lift, s.now) ELSE s.budget IN
                /\ ~s.helper
                /\ s' = [s EXCEPT !.helper = TRUE,
                                  !.budget = IF b.handed >= 0 THEN Woke(b, s.now) ELSE b,
                                  !.pos = IF b.handed >= 0 THEN MaxOf(s.pos, b.handed) ELSE s.pos,
                                  !.quiet = IF s.budget.noticeHanded THEN MaxOf(s.quiet, QuietFrom(s.lift, s.now)) ELSE s.quiet,
                                  !.stale = s.stale \/ (s.budget.noticeHanded /\ s.noticeFailed)]

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

Next == \/ Tick \/ Arrive \/ Lift \/ Take \/ QueueOk \/ QueueFails \/ QueueRefused \/ QueueUnknown \/ Heard
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
\* 7. What is handed over was stored: the position never passes the store.
Stored == s.pos <= s.stored
\* 8. At most once: no wake announces an event an earlier wake announced.
AtMostOnce == ~s.dup
\* 9. A helper never starts paused by a notice the person's own call came after.
NoStalePause == ~s.stale
\* 10. The hand-over passes an event that no wake carried only for a batch handed to codex queue
\*     that the helper never heard back about, and that Codex had not taken.
OnlyUnheardSkipped == s.pos <= MaxOf(s.carried, s.excused)
\* A documented limit of 0.1.3's at-most-once: that one case skips the batch (still stored). 0.1.2's
\* at-least-once kept this, and broke Gap and AtMostOnce.
NothingLost == s.pos <= s.carried /\ s.pos <= s.stored
\* A documented limit: unwakeable is kept in memory, so a new helper runs codex queue once more.
NeverRetried == ~s.retried
Kept == WithinHour /\ Gap /\ OnlyThePerson /\ QuietAfterNotice /\ OneNotice /\ NoWakeUnwakeable
        /\ Stored /\ AtMostOnce /\ NoStalePause /\ OnlyUnheardSkipped
=============================================================================
