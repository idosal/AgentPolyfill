--------------------------- MODULE SkillApproval -----------------------------
EXTENDS Integers
CONSTANT Fault
Sessions == {1,2}
Targets == {1,2}
Versions == {1,2}
VARIABLES target, version, grants, request, disclosed
vars == <<target,version,grants,request,disclosed>>
None == <<0,0>>
Init == /\ target = 1 /\ version = 1 /\ grants = [s \in Sessions |-> None]
        /\ request = <<0,0,0>> /\ disclosed = {}
\* Ask names the source and current manifest. Listing metadata changes no grant.
Ask == /\ request[1] = 0 /\ \E s \in Sessions : /\ request' = <<s,target,version>>
                                      /\ grants' = [grants EXCEPT ![s] = None]
       /\ UNCHANGED <<target,version,disclosed>>
Decline == /\ request[1] # 0 /\ request' = <<0,0,0>>
           /\ grants' = [grants EXCEPT ![request[1]] = None]
           /\ UNCHANGED <<target,version,disclosed>>
Allow == /\ request[1] # 0 /\ request[2] = target /\ request[3] = version
         /\ grants' = [grants EXCEPT ![request[1]] = <<target,version>>]
         /\ request' = <<0,0,0>> /\ UNCHANGED <<target,version,disclosed>>
Reopen == /\ \E s \in Sessions : grants' = [grants EXCEPT ![s] = None]
          /\ UNCHANGED <<target,version,request,disclosed>>
Change == /\ \E p \in Targets, v \in Versions : /\ target' = p /\ version' = v
          /\ UNCHANGED <<grants,request,disclosed>>
\* One reference in the manifest and one outside it. "verified" represents digest and size matching.
ReadFile == \E s \in Sessions, use \in Sessions, listed \in BOOLEAN, verified \in BOOLEAN :
              /\ (use = s \/ Fault = "other-session")
              /\ (grants[use][1] = target \/ Fault = "wrong-source")
              /\ grants[use][2] = version
              /\ (listed \/ Fault = "unlisted-file") /\ (verified \/ Fault = "unchecked-bytes")
              /\ disclosed' = {<<grants[s],<<target,version>>,listed,verified>>}
              /\ UNCHANGED <<target,version,grants,request>>
Next == Ask \/ Decline \/ Allow \/ Reopen \/ Change \/ ReadFile
ScopedVerifiedFile == \A r \in disclosed : r[1] = r[2] /\ r[3] /\ r[4]
=============================================================================
