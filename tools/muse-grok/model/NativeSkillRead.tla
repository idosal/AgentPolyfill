-------------------------- MODULE NativeSkillRead ---------------------------
EXTENDS Naturals
CONSTANT Fault
VARIABLES phase, chosen, promptFile, returned, uses, version, shownVersion
vars == <<phase, chosen, promptFile, returned, uses, version, shownVersion>>
Files == {1,2}
Init == /\ phase = "listed" /\ chosen = 0 /\ promptFile = 0 /\ returned = {}
        /\ uses = 0 /\ version = 1 /\ shownVersion = 0
Select == /\ phase = "listed" /\ phase' = "selected"
          /\ UNCHANGED <<chosen,promptFile,returned,uses,version,shownVersion>>
Redeem == /\ (phase = "selected" \/ (Fault = "reuse" /\ phase = "closed")) /\ uses < 2
          /\ \E f \in Files : /\ chosen' = f /\ promptFile' = f
          /\ phase' = "asking" /\ uses' = uses+1 /\ shownVersion' = version
          /\ UNCHANGED <<returned,version>>
Deny == /\ phase = "asking" /\ phase' = "closed"
        /\ UNCHANGED <<chosen,promptFile,returned,uses,version,shownVersion>>
Allow == /\ phase = "asking" /\ phase' = "allowed"
         /\ UNCHANGED <<chosen,promptFile,returned,uses,version,shownVersion>>
Rotate == /\ version = 1 /\ version' = 2
          /\ UNCHANGED <<phase,chosen,promptFile,returned,uses,shownVersion>>
Read == /\ phase = "allowed" /\ (shownVersion = version \/ Fault = "stale")
        /\ \E f \in Files : /\ (f = chosen \/ Fault = "other-file")
                             /\ returned' = returned \cup {<<f,promptFile,version,shownVersion>>}
        /\ phase' = "closed" /\ UNCHANGED <<chosen,promptFile,uses,version,shownVersion>>
Next == Select \/ Redeem \/ Deny \/ Allow \/ Rotate \/ Read
SingleRequest == uses <= 1
ApprovedBytes == \A record \in returned : record[1] = record[2] /\ record[3] = record[4]
=============================================================================
