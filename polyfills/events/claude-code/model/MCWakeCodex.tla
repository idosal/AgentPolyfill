---------------------------- MODULE MCWakeCodex ----------------------------
(***************************************************************************)
(* What TLC needs besides WakeCodex itself (the configurations             *)
(* WakeCodex*.cfg). Nothing here changes a step.                           *)
(***************************************************************************)
EXTENDS WakeCodex

\* TLC tells states apart by a view (VIEW), not by every field of s. Each leaves out only what
\* no step reads, so two states with the same view have the same invariants (of the
\* configurations that use it), and their steps lead to states with the same view:
\*  - the event counts (stored, pos, upto, carried) are read only as differences from one
\*    another, so they are counted from pos; upto is read only while a batch is queued;
\*  - ViewQuiet also leaves out shown and spoke, which no step reads (spoke is written from
\*    shown's length) and only WithinHour and Gap do. The configurations that check neither use
\*    it: with the helper dying after codex queue took a batch and before it heard so (what
\*    WakeCodexHour.cfg finds), shown can grow without bound at one time.
Counted == [s EXCEPT !.stored = s.stored - s.pos, !.upto = IF s.queued = "" THEN 0 ELSE s.upto - s.pos,
                     !.carried = s.carried - s.pos, !.pos = 0]
View == Counted
ViewQuiet == [Counted EXCEPT !.shown = <<>>, !.spoke = 0]

\* An action constraint, for the configurations that check WithinHour and Gap everywhere else:
\* the helper does not die between codex queue taking a batch and the helper hearing so. A run
\* under it says nothing about the steps it leaves out (WakeCodexHour.cfg and WakeCodexGap.cfg
\* run without it).
HeardBeforeDying == ~(s.answered /\ s.queued = "batch" /\ ~s'.helper)
=============================================================================
