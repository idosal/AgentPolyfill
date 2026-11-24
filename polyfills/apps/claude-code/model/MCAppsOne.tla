----------------------------- MODULE MCAppsOne -----------------------------
(* AppsViews with every call on one server: the calls are then interchangeable, *)
(* so TLC checks one behaviour of each shape (symmetry).                          *)
EXTENDS AppsViews, TLC

MCCallServer == [c \in Calls |-> "s1"]
CallPerms == Permutations(Calls)
=============================================================================
