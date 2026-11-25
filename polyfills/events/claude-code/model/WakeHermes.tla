------------------------------ MODULE WakeHermes ------------------------------
(***************************************************************************)
(* How often events wake a Hermes session in mcp-events for Hermes         *)
(* (polyfills/events/hermes). The wake budget (core/src/wake.ts, kept in   *)
(* wakes.json, with the pause that lifts by itself after an hour), the     *)
(* hand-over through the plugin's ctx.inject_message (hermes/src/          *)
(* session.ts, plugin/__init__.py), which turns count as the person's      *)
(* (the plugin's pre_llm_call hook), and the gateway, with the helper,     *)
(* stopping between any two steps. One session, one watch.                 *)
(*                                                                         *)
(* Adapted by hand from WakeCodex.tla, with the same state (one record, s) *)
(* where the two forms agree, and written in TLA+ only (there is no Quint  *)
(* model of it). What differs from Codex:                                  *)
(*  - The hand-over is a request to the Python half, which calls           *)
(*    inject_message. It answers taken (True) or not (False); no answer    *)
(*    within 30 s is counted as handed over (as `codex queue` timing out). *)
(*    There is no session it can never reach: a refused wake is tried      *)
(*    again.                                                               *)
(*  - "The person wrote" is any turn whose message does not start with the *)
(*    plugin's own "[mcp-events]" line. Hermes's hooks don't say who       *)
(*    started a turn, so a turn another plugin or Hermes itself injects    *)
(*    counts too. OTHERS says which kinds of other turns the session sees. *)
(*  - DROPS: inject_message's True means the gateway took the message for  *)
(*    dispatch, not that the turn ran; with DROPS the gateway may drop it  *)
(*    afterwards (a route it refuses on recheck).                          *)
(* RECORD FALSE takes the write-ahead record of the hand-over out, to see  *)
(* what it is for.                                                         *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
    LIFT,       \* liftAfterMs, in units (an hour)
    RECORD,     \* TRUE: the hand-over is recorded before inject_message (session.ts); FALSE: taken out
    OTHERS,     \* the kinds of turns other than the person's: "ours" (the plugin's own wake), "plugin", "gateway"
    DROPS,      \* TRUE: the gateway may drop a message it took
    MAX_TIME,   \* the clock's bound; one unit stands for fifteen minutes
    HOUR,       \* an hour, in those units
    GAP,        \* MCP_EVENTS_WAKE_GAP_S
    PER_HOUR,   \* MCP_EVENTS_WAKES_PER_HOUR
    PENDING     \* the model's bound: events stored and not yet handed over, at most

ASSUME LIFT \in Nat /\ RECORD \in BOOLEAN /\ OTHERS \subseteq {"ours", "plugin", "gateway"}
       /\ DROPS \in BOOLEAN /\ MAX_TIME \in Nat /\ HOUR \in Nat /\ GAP \in Nat /\ PER_HOUR \in Nat
       /\ PENDING \in Nat

\* The plugin's rule (pre_llm_call): every turn but one that starts with its own line.
CountsAsPerson(kind) == kind # "ours"

\* The state: now; stored; pos (handed over, on disk); budget (wakes.json: wakes, last, paused,
\* pausedAt (-1 unset), noticeHanded, handed (the recorded batch's end, -1 none)); helper;
\* queued ("", "batch" or "notice": asked of the plugin, not heard back about); upto; answered
\* (inject_message took it, the helper has not heard so); and history: spoke, shown, carried,
\* noticeAt, quiet, early, twice, byOther, dup, excused, dropped, noticeFailed, stale.
VARIABLE s

MaxOf(a, b) == IF a > b THEN a ELSE b
Recent(l, t) == SelectSeq(l, LAMBDA x : t - x < HOUR)
QuietFrom(lift, t) == IF lift > 0 THEN t + lift ELSE 1000
Pause(b, lift, t) == [b EXCEPT !.paused = TRUE, !.noticeHanded = FALSE,
                               !.pausedAt = IF lift > 0 THEN t ELSE b.pausedAt]
Woke(b, t) == [b EXCEPT !.wakes = Append(Recent(b.wakes, t), t), !.last = t, !.noticeHanded = FALSE, !.handed = -1]

Init == s = [now |-> 0, stored |-> 0, pos |-> 0,
             budget |-> [wakes |-> <<>>, last |-> -100, paused |-> FALSE, pausedAt |-> -1, noticeHanded |-> FALSE, handed |-> -1],
             helper |-> TRUE, queued |-> "", upto |-> 0, answered |-> FALSE,
             spoke |-> 0, shown |-> <<>>, carried |-> 0, noticeAt |-> -100, quiet |-> -100,
             early |-> FALSE, twice |-> FALSE, byOther |-> FALSE, dup |-> FALSE, excused |-> 0,
             dropped |-> 0, noticeFailed |-> FALSE, stale |-> FALSE]

Tick == s.now < MAX_TIME /\ s' = [s EXCEPT !.now = s.now + 1]

Arrive == s.helper /\ s.stored - s.pos < PENDING /\ s' = [s EXCEPT !.stored = s.stored + 1]

Lift == /\ s.helper /\ s.budget.paused /\ LIFT > 0 /\ s.now >= s.budget.pausedAt + LIFT
        /\ s' = [s EXCEPT !.budget = [s.budget EXCEPT !.paused = FALSE, !.pausedAt = -1, !.wakes = <<>>]]

\* #handOver: past the hour's wakes the notice (noticeHanded first), else the batch (its record
\* first, unless RECORD is taken out); then the plugin is asked.
Takes == /\ s.helper /\ s.queued = "" /\ s.stored > s.pos
         /\ ~s.budget.paused /\ s.now - s.budget.last >= GAP
Take == LET notice == Len(Recent(s.budget.wakes, s.now)) >= PER_HOUR IN
        /\ Takes
        /\ s' = [s EXCEPT !.queued = IF notice THEN "notice" ELSE "batch", !.upto = s.stored, !.answered = FALSE,
                          !.budget = IF notice THEN [s.budget EXCEPT !.noticeHanded = TRUE]
                                     ELSE IF RECORD THEN [s.budget EXCEPT !.handed = s.stored]
                                     ELSE s.budget,
                          !.noticeFailed = IF notice THEN FALSE ELSE s.noticeFailed]

\* inject_message takes it and the turn runs (the session is woken), whether or not the helper
\* lives to hear so.
Taken == /\ s.helper /\ s.queued # "" /\ ~s.answered
         /\ s' = IF s.queued = "batch"
                 THEN [s EXCEPT !.answered = TRUE, !.shown = Append(s.shown, s.now),
                                !.carried = MaxOf(s.carried, s.upto), !.early = s.early \/ s.now < s.quiet,
                                !.dup = s.dup \/ s.pos < s.carried]
                 ELSE [s EXCEPT !.answered = TRUE,
                                !.twice = s.twice \/ (s.noticeAt >= 0 /\ (LIFT = 0 \/ s.now - s.noticeAt < LIFT)),
                                !.noticeAt = s.now, !.quiet = MaxOf(s.quiet, QuietFrom(LIFT, s.now))]
\* DROPS: the gateway takes the message (True) and drops it before the turn runs.
TakenDropped == /\ DROPS /\ s.helper /\ s.queued # "" /\ ~s.answered
                /\ s' = [s EXCEPT !.answered = TRUE,
                                  !.dropped = IF s.queued = "batch" THEN MaxOf(s.dropped, s.upto) ELSE s.dropped]
\* inject_message says False (not allowed, no live host, a busy recheck): the record is dropped
\* (dropHanded), a notice is no longer handed over (dropNotice); tried again later.
NotTaken == /\ s.helper /\ s.queued # "" /\ ~s.answered
            /\ s' = [s EXCEPT !.queued = "",
                              !.budget = IF s.queued = "batch" THEN [s.budget EXCEPT !.handed = -1]
                                         ELSE [s.budget EXCEPT !.noticeHanded = FALSE],
                              !.noticeFailed = s.noticeFailed \/ s.queued = "notice"]
\* No answer within 30 s (the plugin hangs, or answered too late): counted as handed over, at most once.
NoAnswer == /\ s.helper /\ s.queued # ""
            /\ s' = IF s.queued = "batch"
                    THEN [s EXCEPT !.queued = "", !.answered = FALSE, !.pos = MaxOf(s.pos, s.upto),
                                   !.budget = Woke(s.budget, s.now),
                                   !.excused = IF s.answered THEN s.excused ELSE MaxOf(s.excused, s.upto)]
                    ELSE [s EXCEPT !.queued = "", !.answered = FALSE, !.budget = Pause(s.budget, LIFT, s.now),
                                   !.quiet = MaxOf(s.quiet, QuietFrom(LIFT, s.now))]

\* The helper hears True: the batch is marked handed over (Delivery.ack), then counted
\* (WakeBudget.woke, which clears the record); the notice pauses waking.
Heard == /\ s.helper /\ s.answered
         /\ s' = IF s.queued = "batch"
                 THEN [s EXCEPT !.queued = "", !.answered = FALSE, !.pos = s.upto, !.budget = Woke(s.budget, s.now)]
                 ELSE [s EXCEPT !.queued = "", !.answered = FALSE, !.budget = Pause(s.budget, LIFT, s.now),
                                !.quiet = MaxOf(s.quiet, QuietFrom(LIFT, s.now))]

\* The gateway stops (or the helper dies): a batch the plugin was asked about and had not taken is
\* skipped if the next helper counts it (excused).
HelperDies == /\ s.helper
              /\ s' = [s EXCEPT !.helper = FALSE, !.queued = "", !.answered = FALSE,
                                !.excused = IF s.queued = "batch" /\ ~s.answered THEN MaxOf(s.excused, s.upto) ELSE s.excused]
\* The gateway starts again and the helper resumes the saved watch (HermesSession constructor and
\* start): a notice handed over by a helper that ended before it heard back pauses it; a recorded
\* batch is marked handed over and counted.
HelperStarts == LET b == IF s.budget.noticeHanded THEN Pause(s.budget, LIFT, s.now) ELSE s.budget IN
                /\ ~s.helper
                /\ s' = [s EXCEPT !.helper = TRUE,
                                  !.budget = IF b.handed >= 0 THEN Woke(b, s.now) ELSE b,
                                  !.pos = IF b.handed >= 0 THEN MaxOf(s.pos, b.handed) ELSE s.pos,
                                  !.quiet = IF s.budget.noticeHanded THEN MaxOf(s.quiet, QuietFrom(LIFT, s.now)) ELSE s.quiet,
                                  !.stale = s.stale \/ (s.budget.noticeHanded /\ s.noticeFailed)]

\* A turn starts in the session: pre_llm_call. If it counts as the person's, the plugin asks the
\* helper `spoke`: WakeBudget.spoke ends the pause and starts the hour again.
TurnBy(person, kind) ==
    LET theirs == person \/ CountsAsPerson(kind)
        reset == theirs /\ (s.budget.paused \/ Len(s.budget.wakes) > 0)
    IN /\ s.helper
       /\ s' = [s EXCEPT !.budget = IF reset THEN [s.budget EXCEPT !.paused = FALSE, !.pausedAt = -1, !.wakes = <<>>]
                                   ELSE s.budget,
                         !.spoke = IF person THEN Len(s.shown) ELSE s.spoke,
                         !.noticeAt = IF person THEN -100 ELSE s.noticeAt,
                         !.quiet = IF person THEN -100 ELSE s.quiet,
                         !.byOther = s.byOther \/ (~person /\ reset)]
PersonTurn == TurnBy(TRUE, "typed")
OtherTurn == \E k \in OTHERS : TurnBy(FALSE, k)

Next == \/ Tick \/ Arrive \/ Lift \/ Take \/ Taken \/ TakenDropped \/ NotTaken \/ NoAnswer \/ Heard
        \/ HelperDies \/ HelperStarts \/ PersonTurn \/ OtherTurn

Spec == Init /\ [][Next]_s

\* ---- Invariants (WakeCodex.tla's, less NoWakeUnwakeable, which has no counterpart here).
Window(l, i, from) == Cardinality({j \in DOMAIN l : j > from /\ j <= i /\ l[i] - l[j] < HOUR})
WithinHour == \A i \in DOMAIN s.shown : i <= s.spoke \/ Window(s.shown, i, s.spoke) <= PER_HOUR
Gap == \A i \in DOMAIN s.shown : i = 1 \/ s.shown[i] - s.shown[i - 1] >= GAP
OnlyThePerson == ~s.byOther
QuietAfterNotice == ~s.early
OneNotice == ~s.twice
Stored == s.pos <= s.stored
AtMostOnce == ~s.dup
NoStalePause == ~s.stale
\* An event handed over that no wake carried: only a batch the plugin never answered about, or
\* (DROPS) one the gateway took and dropped.
OnlyUnheardSkipped == s.pos <= MaxOf(s.carried, MaxOf(s.excused, s.dropped))
\* The same without the dropped ones: what DROPS costs.
OnlyUnheardNotDropped == s.pos <= MaxOf(s.carried, s.excused)
NothingLost == s.pos <= s.carried /\ s.pos <= s.stored
Kept == WithinHour /\ Gap /\ OnlyThePerson /\ QuietAfterNotice /\ OneNotice
        /\ Stored /\ AtMostOnce /\ NoStalePause /\ OnlyUnheardSkipped
=============================================================================
