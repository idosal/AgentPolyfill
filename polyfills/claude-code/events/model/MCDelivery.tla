----------------------------- MODULE MCDelivery -----------------------------
(***************************************************************************)
(* What TLC needs besides Delivery itself (the configurations Poll*.cfg,   *)
(* Push*.cfg, Webhook*.cfg, Strict.cfg). Nothing here changes a step.      *)
(***************************************************************************)
EXTENDS Delivery

\* TLC tells states apart by this (VIEW), not by every variable. It leaves out only what no
\* step reads, so two states with the same view have the same invariants, and their steps lead
\* to states with the same view:
\*  - hist is written and never read, except by the invariants: they use how often each event
\*    was shown (0, 1 or more), which genuine events were acknowledged, and hist.cut;
\*  - a delivery in srv.sent is read only by Replay, which gives the copy a new relay sequence
\*    number, so the number it had is left out.
Min2(n) == IF n > 2 THEN 2 ELSE n
View == <<cfg, now, [srv EXCEPT !.sent = {[m EXCEPT !.seq = 0] : m \in srv.sent}], rly, disk, host, mem,
          [shown |-> [e \in Events |-> Min2(Count(hist.shown, e))],
           acked |-> {d.ev : d \in {x \in hist.acked : x.genuine}},
           cut |-> hist.cut]>>

\* State constraints, each for one configuration that must find a violation. A constraint keeps
\* TLC to the states that meet it, so a run under one says nothing about what holds; what it
\* finds is still a run of the model. They keep the search to the part of the model a defect is
\* in, past a shorter one TLC would find first, or within the state folder's limit.

\* B1 (WebhookBeforeB1*.cfg): no forger, no crash or close, the subscription kept, nothing lost,
\* nothing handed to the session. Without it the search passes the state folder's limit first.
GuideB1 == /\ \A d \in rly.mailbox : d.genuine
           /\ host.cc /\ host.helper /\ srv.live /\ srv.lost = {} /\ hist.shown = <<>>

\* "Stored twice" (PushBeforeStored.cfg): the helper is not down with a batch submitted and not
\* acknowledged, which leaves out "handed over twice" (as short, and found first otherwise).
GuideStored == host.helper \/ host.submitted <= disk.pos[host.session]

\* "Carried twice" (PollCarriedTwice.cfg, 0.5.0): after the first session, the helper fetches
\* nothing from the server, which leaves out "seen forgotten" (as short, and found first otherwise).
GuideCarried == host.session = 1 \/ mem.step.kind = ""
=============================================================================
