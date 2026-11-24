------------------------------- MODULE MCWake -------------------------------
(***************************************************************************)
(* What TLC needs besides Wake itself (the configurations Wake*.cfg).      *)
(***************************************************************************)
EXTENDS Wake

\* No step reads `notices`, and it can grow without bound (the notice handed over again and
\* again). The invariants only tell 0, 1 and more apart, so states that differ only in a count
\* past 2 are taken as one (VIEW): the state space is finite, and nothing they check changes.
View == [s EXCEPT !.notices = IF s.notices > 2 THEN 2 ELSE s.notices]
=============================================================================
