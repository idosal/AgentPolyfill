------------------------------- MODULE Relay -------------------------------
(***************************************************************************)
(* relay.qnt in TLA+, for TLC: the relay's mailboxes, and whether one MCP  *)
(* server's posts can crowd out another's. Two servers each have a webhook *)
(* address in a mailbox that holds at most CAP deliveries; "a" posts       *)
(* well-formed junk to its own address, "b" posts genuine deliveries; while *)
(* Claude Code is closed nothing collects. Until 0.6.0 a project's watches *)
(* shared one mailbox ("p"); from 0.7.0 each server has its own, and a     *)
(* watch still at "p" moves to its server's own (Drain, then Move).        *)
(*                                                                         *)
(* Written by hand from relay.qnt, action for action, with the same        *)
(* variables, so that Quint's traces can be replayed here as they are      *)
(* (model/conform.mjs does that). Quint's init variants are the constants  *)
(* PER_SERVER, DRAIN and START. Lists are 1-based here, 0-based in Quint.  *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
    CAP,         \* deliveries one mailbox holds (MAX_QUEUED)
    MAX_EV,      \* genuine deliveries server "b" makes
    PER_SERVER,  \* TRUE: 0.7.0, each server's own mailbox; FALSE: 0.6.0
    DRAIN,       \* the move collects the old mailbox first (FALSE only in a variant without it)
    START        \* "p": an existing user's watches at the project's mailbox; "own": each server's own

ASSUME CAP \in Nat \ {0} /\ MAX_EV \in Nat /\ PER_SERVER \in BOOLEAN /\ DRAIN \in BOOLEAN /\ START \in {"p", "own"}

SERVERS == {"a", "b"}
MAILBOXES == {"p", "a", "b"}

VARIABLES cfg, open, home, box, made, shown, accepted, crossRefused, crossRefusedOwn
vars == <<cfg, open, home, box, made, shown, accepted, crossRefused, crossRefusedOwn>>

\* Whether a mailbox holds a delivery to an address of a server other than s.
Occupant(l, s) == \E i \in DOMAIN l : l[i].to # s
Mine(l, s) == SelectSeq(l, LAMBDA d : d.to = s)
NotMine(l, s) == SelectSeq(l, LAMBDA d : d.to # s)
Evs(l) == LET g == SelectSeq(l, LAMBDA d : d.genuine) IN [i \in DOMAIN g |-> g[i].ev]

Init ==
    /\ cfg = [perServer |-> PER_SERVER, drain |-> DRAIN]
    /\ open = TRUE
    /\ home = [s \in SERVERS |-> IF START = "p" THEN "p" ELSE s]
    /\ box = [m \in MAILBOXES |-> <<>>]
    /\ made = 0 /\ shown = <<>> /\ accepted = {} /\ crossRefused = FALSE /\ crossRefusedOwn = FALSE

\* Server "a" posts well-formed junk to its own address. A full mailbox refuses it (503).
Junk == LET m == home["a"] IN
    /\ Len(box[m]) < CAP
    /\ box' = [box EXCEPT ![m] = Append(box[m], [to |-> "a", genuine |-> FALSE, ev |-> 0])]
    /\ UNCHANGED <<cfg, open, home, made, shown, accepted, crossRefused, crossRefusedOwn>>

\* Server "b" posts a genuine delivery to its address. A full mailbox refuses it (503).
Genuine ==
    LET m == home["b"]
        e == made + 1
        room == Len(box[m]) < CAP
        crowded == ~room /\ Occupant(box[m], "b")
    IN /\ made < MAX_EV
       /\ made' = e
       /\ box' = IF room THEN [box EXCEPT ![m] = Append(box[m], [to |-> "b", genuine |-> TRUE, ev |-> e])] ELSE box
       /\ accepted' = IF room THEN accepted \cup {e} ELSE accepted
       /\ crossRefused' = (crossRefused \/ crowded)
       /\ crossRefusedOwn' = (crossRefusedOwn \/ (crowded /\ m # "p"))
       /\ UNCHANGED <<cfg, open, home, shown>>

\* While Claude Code is open the mod collects the oldest delivery of a mailbox; junk is dropped.
CollectAt(m) ==
    /\ open /\ Len(box[m]) > 0
    /\ box' = [box EXCEPT ![m] = Tail(box[m])]
    /\ shown' = IF Head(box[m]).genuine THEN Append(shown, Head(box[m]).ev) ELSE shown
    /\ UNCHANGED <<cfg, open, home, made, accepted, crossRefused, crossRefusedOwn>>
Collect == \E m \in MAILBOXES : CollectAt(m)

Close == open /\ open' = FALSE /\ UNCHANGED <<cfg, home, box, made, shown, accepted, crossRefused, crossRefusedOwn>>
Open == ~open /\ open' = TRUE /\ UNCHANGED <<cfg, home, box, made, shown, accepted, crossRefused, crossRefusedOwn>>

\* 0.7.0, a watch still at the project's mailbox: what that mailbox holds for its address is collected first.
DrainOf(s) ==
    /\ cfg.perServer /\ cfg.drain /\ open /\ home[s] = "p" /\ Len(Mine(box["p"], s)) > 0
    /\ box' = [box EXCEPT !["p"] = NotMine(box["p"], s)]
    /\ shown' = shown \o Evs(Mine(box["p"], s))
    /\ UNCHANGED <<cfg, open, home, made, accepted, crossRefused, crossRefusedOwn>>
Drain == \E s \in SERVERS : DrainOf(s)

\* Then the watch subscribes at a new address in its server's own mailbox, and the old one is retired
\* (the relay deletes what it still holds there; with the drain, nothing is left).
MoveOf(s) ==
    /\ cfg.perServer /\ open /\ home[s] = "p"
    /\ ~cfg.drain \/ Len(Mine(box["p"], s)) = 0
    /\ home' = [home EXCEPT ![s] = s]
    /\ box' = [box EXCEPT !["p"] = NotMine(box["p"], s)]
    /\ UNCHANGED <<cfg, open, made, shown, accepted, crossRefused, crossRefusedOwn>>
Move == \E s \in SERVERS : MoveOf(s)

Next == Junk \/ Genuine \/ Collect \/ Close \/ Open \/ Drain \/ Move

Spec == Init /\ [][Next]_vars

\* ---- invariants (the same names as in relay.qnt).
Held == UNION {{box[m][i].ev : i \in {j \in DOMAIN box[m] : box[m][j].genuine}} : m \in MAILBOXES}
\* 1. A genuine delivery is never refused for room that another server's posts take up.
NoCrossRefusal == ~crossRefused
\* 1'. The same, for an address in its server's own mailbox.
NoCrossRefusalAtOwn == ~crossRefusedOwn
\* 2. A genuine delivery a mailbox took is collected, or still held: moving a watch loses none.
NothingLost == \A e \in accepted : (\E i \in DOMAIN shown : shown[i] = e) \/ e \in Held
\* 3. Each genuine event is collected at most once.
CollectedOnce == \A e \in 1..MAX_EV : Cardinality({i \in DOMAIN shown : shown[i] = e}) <= 1
=============================================================================
