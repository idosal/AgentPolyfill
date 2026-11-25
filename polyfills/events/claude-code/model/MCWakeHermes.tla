---------------------------- MODULE MCWakeHermes ----------------------------
(***************************************************************************)
(* What TLC needs besides WakeHermes itself (the configurations            *)
(* WakeHermes*.cfg). Nothing here changes a step. The views are            *)
(* MCWakeCodex.tla's, for the same reasons: event counts are read only as  *)
(* differences from pos; ViewQuiet also leaves out shown and spoke, which  *)
(* only WithinHour and Gap read.                                           *)
(***************************************************************************)
EXTENDS WakeHermes

Counted == [s EXCEPT !.stored = s.stored - s.pos, !.upto = IF s.queued = "" THEN 0 ELSE s.upto - s.pos,
                     !.carried = MaxOf(s.carried - s.pos, -1), !.excused = MaxOf(s.excused - s.pos, -1),
                     !.dropped = MaxOf(s.dropped - s.pos, -1),
                     !.budget = [s.budget EXCEPT !.handed = IF s.budget.handed < 0 THEN -1 ELSE s.budget.handed - s.pos],
                     !.pos = 0]
View == Counted
ViewQuiet == [Counted EXCEPT !.shown = <<>>, !.spoke = 0]
=============================================================================
