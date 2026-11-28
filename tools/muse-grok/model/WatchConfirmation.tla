------------------------- MODULE WatchConfirmation ---------------------------
EXTENDS Integers
CONSTANT Fault
Sessions == {1,2}
Keys == {1,2}
\* A key stands for the verb, publisher label, event and full displayed filter.
VARIABLES endpoint, generation, pending, consumed, receipt
vars == <<endpoint,generation,pending,consumed,receipt>>
Empty == <<0,0,0,FALSE>>
Init == /\ endpoint = 1 /\ generation = [s \in Sessions |-> 0]
        /\ pending = [s \in Sessions |-> Empty] /\ consumed = {} /\ receipt = {}
Propose == \E s \in Sessions, k \in Keys, c \in 1..2 :
              /\ generation[s] < 2 /\ c # pending[s][3]
              /\ generation' = [generation EXCEPT ![s] = @+1]
              /\ pending' = [pending EXCEPT ![s] = <<k,endpoint,c,FALSE>>]
              /\ UNCHANGED <<endpoint,consumed,receipt>>
Type == \E s \in Sessions, c \in 1..2 :
           /\ pending[s][3] = c /\ pending[s][4] = FALSE
           /\ pending' = [pending EXCEPT ![s][4] = TRUE]
           /\ UNCHANGED <<endpoint,generation,consumed,receipt>>
Consume == \E s \in Sessions, k \in Keys :
              /\ pending[s][4] /\ pending[s][1] = k
              /\ (pending[s][2] = endpoint \/ Fault = "ignore-endpoint")
              /\ receipt' = {<<endpoint,pending[s][2],<<s,generation[s]>> \in consumed>>}
              /\ consumed' = consumed \cup {<<s,generation[s]>>}
              /\ pending' = IF Fault = "keep-confirmation" THEN pending ELSE [pending EXCEPT ![s] = Empty]
              /\ UNCHANGED <<endpoint,generation>>
Expire == /\ \E s \in Sessions : pending' = [pending EXCEPT ![s] = Empty]
          /\ UNCHANGED <<endpoint,generation,consumed,receipt>>
Reconfigure == /\ endpoint' = IF endpoint = 1 THEN 2 ELSE 1
               /\ UNCHANGED <<pending,generation,consumed,receipt>>
Next == Propose \/ Type \/ Consume \/ Expire \/ Reconfigure
OneUseAtNamedEndpoint == \A a \in receipt : a[1] = a[2] /\ ~a[3]
=============================================================================
