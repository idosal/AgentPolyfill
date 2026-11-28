----------------------------- MODULE TaskHandles -----------------------------
EXTENDS Integers
CONSTANT Fault
Sources == {1,2}
Tools == {1,2}
Handles == {1,2}
\* One enabled operation per source exposes cross-source allowlist mistakes.
Allowed == {<<1,1>>,<<2,2>>}
VARIABLES issued, live, starts, lookups
vars == <<issued,live,starts,lookups>>
Init == /\ issued = [h \in Handles |-> 0] /\ live = {} /\ starts = {} /\ lookups = {}
Start == \E s \in Sources, t \in Tools, h \in Handles :
           /\ issued[h] = 0 /\ (<<s,t>> \in Allowed \/ Fault = "global-allowlist")
           /\ issued' = [issued EXCEPT ![h] = s] /\ live' = live \cup {h}
           /\ starts' = starts \cup {<<s,t>>} /\ UNCHANGED lookups
\* Status and cancel use the connection saved when the task was issued.
Lookup == \E h \in Handles, s \in Sources :
            /\ (h \in live \/ Fault = "expired-handle") /\ issued[h] # 0
            /\ (issued[h] = s \/ Fault = "wrong-publisher")
            /\ lookups' = {<<issued[h],s,h \in live>>} /\ UNCHANGED <<issued,live,starts>>
Expire == \E h \in live : /\ live' = live \ {h} /\ UNCHANGED <<issued,starts,lookups>>
Next == Start \/ Lookup \/ Expire
EnabledOnly == starts \subseteq Allowed
BoundHandle == \A l \in lookups : l[1] = l[2] /\ l[3]
=============================================================================
