-------------------------------- MODULE Wake --------------------------------
(***************************************************************************)
(* wake.qnt in TLA+, for TLC: how often events wake a session. The helper's *)
(* wake budget (src/wake.ts, kept in wakes.json) and the hand-over it gates *)
(* (/take, $.prompt.submit, /ack between the hooks module and the helper),  *)
(* with the helper dying between any two steps, events arriving at any     *)
(* time, and the person speaking. One watch.                               *)
(*                                                                         *)
(* Written by hand from wake.qnt, action for action and with the same      *)
(* state (one record, s), so that Quint's traces can be replayed here as   *)
(* they are: model/conform.mjs does that.                                  *)
(* FIX = TRUE is the client from 0.5.0, FALSE is 0.4.1.                    *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
    FIX,        \* TRUE: 0.5.0; FALSE: 0.4.1
    MAX_TIME,   \* the clock's bound; one unit stands for twenty minutes
    HOUR,       \* an hour, in those units
    GAP,        \* MCP_EVENTS_WAKE_GAP_S: how soon one watch may start another wake
    PER_HOUR    \* MCP_EVENTS_WAKES_PER_HOUR

ASSUME FIX \in BOOLEAN /\ MAX_TIME \in Nat /\ HOUR \in Nat /\ GAP \in Nat /\ PER_HOUR \in Nat

\* The state, as in wake.qnt:
\*   fix; now; waiting (the spool holds events not handed over); budget (on disk:
\*   wakes, last, paused); helper (it runs); taken ("" nothing, "batch" or "notice",
\*   taken and not acknowledged); subbed (the hooks module submitted what it took);
\*   remembered (0.5.0: the hooks module remembers a submitted batch whose ack it has
\*   not seen through); spoke, shown, notices (history: wakes when the person last
\*   spoke, when each batch was submitted, notices since the person last spoke).
VARIABLE s

InHour(l, t, since) == Cardinality({i \in DOMAIN l : t - l[i] < HOUR /\ l[i] >= since})

Init == s = [fix |-> FIX, now |-> 0, waiting |-> FALSE,
             budget |-> [wakes |-> <<>>, last |-> -100, paused |-> FALSE],
             helper |-> TRUE, taken |-> "", subbed |-> FALSE, remembered |-> FALSE,
             spoke |-> 0, shown |-> <<>>, notices |-> 0]

Tick == s.now < MAX_TIME /\ s' = [s EXCEPT !.now = s.now + 1]
Arrive == ~s.waiting /\ s' = [s EXCEPT !.waiting = TRUE]

\* /take: the budget's gate. A paused budget hands nothing over; a spent hour hands over the notice.
Take == /\ s.helper /\ s.taken = "" /\ s.waiting /\ ~s.budget.paused /\ ~s.remembered
        /\ s.now - s.budget.last >= GAP
        /\ s' = [s EXCEPT !.taken = IF InHour(s.budget.wakes, s.now, -1) >= PER_HOUR THEN "notice" ELSE "batch",
                          !.subbed = FALSE]

\* $.prompt.submit: a turn starts (the session is woken).
Submit == /\ s.helper /\ s.taken # "" /\ ~s.subbed
          /\ s' = [s EXCEPT !.subbed = TRUE, !.remembered = s.fix /\ s.taken = "batch",
                            !.shown = IF s.taken = "batch" THEN Append(s.shown, s.now) ELSE s.shown,
                            !.notices = IF s.taken = "notice" THEN s.notices + 1 ELSE s.notices]

\* /ack: a batch counts as a wake, the notice pauses waking.
Ack == /\ s.helper /\ s.taken # "" /\ s.subbed
       /\ s' = [s EXCEPT !.taken = "", !.subbed = FALSE, !.remembered = FALSE,
                         !.waiting = IF s.taken = "batch" THEN FALSE ELSE s.waiting,
                         !.budget = IF s.taken = "batch"
                                    THEN [s.budget EXCEPT !.wakes = Append(s.budget.wakes, s.now), !.last = s.now]
                                    ELSE [s.budget EXCEPT !.paused = TRUE]]

\* 0.5.0: a restarted helper is told of the batch the one before it handed over (the hooks module
\* acknowledges it before the next take), and counts it as a wake.
AckRemembered == /\ s.fix /\ s.helper /\ s.taken = "" /\ s.remembered
                 /\ s' = [s EXCEPT !.remembered = FALSE, !.waiting = FALSE,
                                   !.budget = [s.budget EXCEPT !.wakes = Append(s.budget.wakes, s.now), !.last = s.now]]

HelperDies == s.helper /\ s' = [s EXCEPT !.helper = FALSE, !.taken = "", !.subbed = FALSE]
HelperStarts == ~s.helper /\ s' = [s EXCEPT !.helper = TRUE]

\* The person sends a message of their own: the hour starts again.
Speak == s' = [s EXCEPT !.spoke = Len(s.shown), !.notices = 0,
                        !.budget = [s.budget EXCEPT !.wakes = <<>>, !.paused = FALSE]]

Next == Tick \/ Arrive \/ Take \/ Submit \/ Ack \/ AckRemembered \/ HelperDies \/ HelperStarts \/ Speak

Spec == Init /\ [][Next]_s

\* ---- Invariants (the same names as in wake.qnt).

\* 1. Between two messages of the person, no hour holds more than PER_HOUR wakes.
\*    (wake.qnt's indices are 0-based; here i and j are 1-based, so "i < spoke" is "i <= spoke".)
Window(l, i, from) == Cardinality({j \in DOMAIN l : j > from /\ j <= i /\ l[i] - l[j] < HOUR})
WithinHour == \A i \in DOMAIN s.shown : i <= s.spoke \/ Window(s.shown, i, s.spoke) <= PER_HOUR
\* 2. Two wakes are at least GAP apart (one watch).
Gap == \A i \in DOMAIN s.shown : i = 1 \/ s.shown[i] - s.shown[i - 1] >= GAP
\* 3. The session is told at most once that waking stopped, until the person speaks.
OneNotice == s.notices <= 1
Kept == WithinHour /\ Gap /\ OneNotice
=============================================================================
