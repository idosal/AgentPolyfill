--------------------------- MODULE DiscoveryHandoff --------------------------
EXTENDS Integers
CONSTANT Fault
Cards == {1,2}
Urls == {1,2}
VARIABLES shown, output, installed
vars == <<shown,output,installed>>
Init == /\ shown = {} /\ output = {} /\ installed = {}
Discover == \E c \in Cards, u \in Urls :
                /\ shown' = shown \cup {<<c,u>>} /\ UNCHANGED <<output,installed>>
\* The plan is advice. A later manual host operation is outside this adapter.
Prepare == \E c \in Cards, u \in Urls :
               /\ (<<c,u>> \in shown \/ Fault = "unseen-endpoint")
               /\ output' = output \cup {<<c,u>>}
               /\ installed' = IF Fault = "apply-plan" THEN installed \cup {u} ELSE installed
               /\ UNCHANGED shown
NewSession == /\ shown' = {} /\ output' = {} /\ UNCHANGED installed
Next == Discover \/ Prepare \/ NewSession
DiscoveredEndpoint == output \subseteq shown
ReadOnlyPlan == installed = {}
=============================================================================
