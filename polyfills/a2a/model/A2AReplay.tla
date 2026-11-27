---- MODULE A2AReplay ----
EXTENDS Naturals
CONSTANTS Correlated, RemoteDedup
Q == 1..2
VARIABLES pending, phase, captured, receipts, seen, effects, mismatched
vars == <<pending, phase, captured, receipts, seen, effects, mismatched>>

Init == /\ pending = 1 /\ phase = "idle" /\ captured = 0
        /\ receipts = {} /\ seen = {}
        /\ effects = [q \in Q |-> 0] /\ mismatched = FALSE

\* One SQLite writer may hold the adapter's fresh-read/send/receipt section.
\* An old or already-receipted form yields an acknowledgement without a send (stuttering).
ReadAnswer(q) == /\ phase = "idle" /\ pending = q /\ q \notin receipts
                 /\ phase' = "checked" /\ captured' = q
                 /\ UNCHANGED <<pending, receipts, seen, effects, mismatched>>

\* The remote status is independent of the adapter's transaction. At 3 it is terminal.
Advance == /\ pending \in Q /\ pending' = pending + 1
           /\ UNCHANGED <<phase, captured, receipts, seen, effects, mismatched>>

Send == /\ phase = "checked" /\ phase' = "sent"
        /\ LET apply == /\ pending \in Q
                        /\ (~Correlated \/ captured = pending)
                        /\ (~RemoteDedup \/ captured \notin seen)
           IN /\ mismatched' = (mismatched \/ (apply /\ captured # pending))
              /\ seen' = IF apply THEN seen \cup {captured} ELSE seen
              /\ effects' = IF apply /\ effects[pending] < 2
                            THEN [effects EXCEPT ![pending] = @ + 1] ELSE effects
        /\ UNCHANGED <<pending, receipts, captured>>

Commit == /\ phase = "sent" /\ receipts' = receipts \cup {captured}
          /\ phase' = "idle" /\ captured' = 0
          /\ UNCHANGED <<pending, seen, effects, mismatched>>

\* A process restart discards volatile state; remote effects and committed receipts survive.
Restart == /\ phase # "idle" /\ phase' = "idle" /\ captured' = 0
           /\ UNCHANGED <<pending, receipts, seen, effects, mismatched>>

Next == (\E q \in Q: ReadAnswer(q)) \/ Advance \/ Send \/ Commit \/ Restart
Spec == Init /\ [][Next]_vars
NoWrongQuestion == ~mismatched
AtMostOneEffect == \A q \in Q: effects[q] <= 1
====
