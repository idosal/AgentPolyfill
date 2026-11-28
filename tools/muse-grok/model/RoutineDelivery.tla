--------------------------- MODULE RoutineDelivery ---------------------------
EXTENDS Integers
CONSTANT Fault
VARIABLES last, rows, phase, through, batch, attempt, firstBody, sends, retries,
          acknowledgments, exposed, owner, titles
vars == <<last, rows, phase, through, batch, attempt, firstBody, sends, retries,
          acknowledgments, exposed, owner, titles>>
Ids == 1..2
Init == /\ last = 0 /\ rows = {} /\ phase = "idle" /\ through = 0 /\ batch = {}
        /\ attempt = <<>> /\ firstBody = <<>> /\ sends = 0 /\ retries = 0
        /\ acknowledgments = {} /\ exposed = {} /\ owner = TRUE /\ titles = FALSE
Append == /\ owner /\ last < 2 /\ last' = last+1 /\ rows' = rows \cup {last+1}
          /\ UNCHANGED <<phase,through,batch,attempt,firstBody,sends,retries,acknowledgments,exposed,owner,titles>>
Reserve == /\ owner /\ phase = "idle" /\ last > through
           /\ \E n \in (through+1)..last :
                /\ batch' = (through+1)..n /\ attempt' = <<batch',titles>> /\ firstBody' = attempt'
           /\ phase' = "sending" /\ sends' = 0 /\ retries' = 0
           /\ UNCHANGED <<last,rows,through,acknowledgments,exposed,owner,titles>>
Post == /\ owner /\ phase = "sending" /\ phase' = "unknown" /\ sends' = sends+1
        /\ UNCHANGED <<last,rows,through,batch,attempt,firstBody,retries,acknowledgments,exposed,owner,titles>>
\* Even a crash between reserving and posting must be treated as ambiguous.
Crash == /\ owner /\ owner' = FALSE /\ phase' = IF phase = "sending" THEN "unknown" ELSE phase
         /\ UNCHANGED <<last,rows,through,batch,attempt,firstBody,sends,retries,acknowledgments,exposed,titles>>
Restart == /\ ~owner /\ owner' = TRUE
           /\ phase' = IF Fault = "automatic-retry" /\ phase = "unknown" THEN "sending" ELSE phase
           /\ UNCHANGED <<last,rows,through,batch,attempt,firstBody,sends,retries,acknowledgments,exposed,titles>>
ExplicitRetry == /\ owner /\ phase = "unknown" /\ retries < 1
                 /\ retries' = retries+1 /\ phase' = "sending"
                 /\ attempt' = IF Fault = "rebuilt-retry" THEN <<batch,titles>> ELSE attempt
                 /\ UNCHANGED <<last,rows,through,batch,firstBody,sends,acknowledgments,exposed,owner,titles>>
\* A 200 response or an operator's confirmation identifies this exact held batch.
Accept == /\ owner /\ phase = "unknown" /\ phase' = "idle"
          /\ acknowledgments' = acknowledgments \cup {batch}
          /\ through' = IF 2 \in batch THEN 2 ELSE 1
          /\ UNCHANGED <<last,rows,batch,attempt,firstBody,sends,retries,exposed,owner,titles>>
Read == /\ \E r \in SUBSET Ids : /\ r # {} /\ r \subseteq rows
           /\ (r \in acknowledgments \/ (Fault = "read-held" /\ phase # "idle" /\ r = batch))
           /\ exposed' = exposed \cup {r}
        /\ UNCHANGED <<last,rows,phase,through,batch,attempt,firstBody,sends,retries,acknowledgments,owner,titles>>
Expire == /\ owner /\ \E r \in acknowledgments : /\ r \subseteq rows /\ rows' = rows \ r
          /\ UNCHANGED <<last,phase,through,batch,attempt,firstBody,sends,retries,acknowledgments,exposed,owner,titles>>
ChangeTitles == /\ titles' = ~titles
                /\ UNCHANGED <<last,rows,phase,through,batch,attempt,firstBody,sends,retries,acknowledgments,exposed,owner>>
Next == Append \/ Reserve \/ Post \/ Crash \/ Restart \/ ExplicitRetry \/ Accept \/ Read \/ Expire \/ ChangeTitles
NoAutomaticReplay == sends <= 1+retries
ExactRetryBody == attempt = firstBody
OnlyAcceptedReads == exposed \subseteq acknowledgments
UnsentRetained == ((through+1)..last) \subseteq rows
=============================================================================
