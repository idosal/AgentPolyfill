---------------------------- MODULE MCAppsViews ----------------------------
(* The constants TLC checks AppsViews with (a config file can't write a function). *)
EXTENDS AppsViews

\* Calls alternate between the two servers: c1 and c3 on s1, c2 and c4 on s2.
MCCallServer == [c \in Calls |-> IF c \in {"c1", "c3"} THEN "s1" ELSE "s2"]
=============================================================================
