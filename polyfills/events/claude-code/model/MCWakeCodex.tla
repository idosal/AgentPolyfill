---------------------------- MODULE MCWakeCodex ----------------------------
(***************************************************************************)
(* What TLC needs besides WakeCodex itself (the configurations             *)
(* WakeCodex*.cfg). Nothing here changes a step.                           *)
(***************************************************************************)
EXTENDS WakeCodex

\* TLC tells states apart by a view (VIEW), not by every field of s. Each leaves out only what
\* no step reads, so two states with the same view have the same invariants (of the
\* configurations that use it), and their steps lead to states with the same view:
\*  - the event counts (stored, pos, upto, carried, excused, the record's handed) are read only
\*    as differences from one another, so they are counted from pos; upto is read only while a
\*    batch is queued; carried and excused only as to whether they are below pos, at it, or how
\*    far above (below pos, they count as one below: neither steps nor invariants tell further);
\*  - ViewQuiet also leaves out shown and spoke, which no step reads (spoke is written from
\*    shown's length) and only WithinHour and Gap do. The configurations that check neither use
\*    it: in 0.1.2, with the helper dying after codex queue took a batch and before it heard so
\*    (what WakeCodexHour.cfg finds), shown can grow without bound at one time.
Counted == [s EXCEPT !.stored = s.stored - s.pos, !.upto = IF s.queued = "" THEN 0 ELSE s.upto - s.pos,
                     !.carried = MaxOf(s.carried - s.pos, -1), !.excused = MaxOf(s.excused - s.pos, -1),
                     !.budget = [s.budget EXCEPT !.handed = IF s.budget.handed < 0 THEN -1 ELSE s.budget.handed - s.pos],
                     !.pos = 0]
View == Counted
ViewQuiet == [Counted EXCEPT !.shown = <<>>, !.spoke = 0]
\* ViewOld, for WakeCodexHeard (0.1.2's seven invariants): also leaves out the history only 0.1.3's
\* invariants read (dup, excused, noticeFailed, stale); no step reads it but to write it.
ViewOld == [Counted EXCEPT !.dup = FALSE, !.excused = 0, !.noticeFailed = FALSE, !.stale = FALSE]

\* An action constraint, for WakeCodexHeard (0.1.2): the helper does not die between codex queue
\* taking a batch and the helper hearing so. A run under it says nothing about the steps it
\* leaves out (WakeCodexHour.cfg and WakeCodexGap.cfg run 0.1.2 without it; 0.1.3 needs it nowhere).
HeardBeforeDying == ~(s.answered /\ s.queued = "batch" /\ ~s'.helper)
=============================================================================
