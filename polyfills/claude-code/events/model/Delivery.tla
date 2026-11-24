------------------------------ MODULE Delivery ------------------------------
(***************************************************************************)
(* delivery.qnt in TLA+, for TLC: how one watch's events travel from an    *)
(* MCP server to a Claude Code session in mcp-events, by poll, push or     *)
(* webhook (through the relay), with the helper and Claude Code stopping   *)
(* and starting between any two steps, a forger and a replayer on the     *)
(* wire, and optionally a relay that lies. One subscription, one project,  *)
(* one Claude Code window at a time.                                       *)
(*                                                                         *)
(* Written by hand from delivery.qnt, action for action, with the same     *)
(* variables and record fields, so that Quint's traces can be replayed     *)
(* here as they are: model/conform.mjs does that.                          *)
(* Two names differ: Quint's action Append is AppendEv here (Append is the *)
(* Sequences operator), and its init variants are the constants FIX, MODES *)
(* and EVILS. Lists are 1-based here, 0-based in Quint.                    *)
(* model/README.md says what each part stands for in the code, what each   *)
(* invariant means, and what checking them showed.                         *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
    N,             \* events the server emits
    MAX_TIME,      \* the clock's bound; one unit stands for five minutes
    FRESH,         \* Standard Webhooks freshness: five minutes
    SLACK,         \* 0.4.1's REPLAY_SLACK_S: ten minutes
    MAX_SESSIONS,  \* Claude Code sessions in one run (each open after a close is a new one)
    MAX_SEQ,       \* deliveries the relay ever stores (genuine, retried, forged or replayed)
    FIX,           \* TRUE: the client in 0.5.1 (Quint's init); FALSE: 0.4.1 (initBefore)
    MODES,         \* the delivery modes a run may use: a subset of {"poll", "push", "webhook"}
    EVILS          \* whether the relay may lie: a subset of BOOLEAN (it only can for webhook)

ASSUME /\ N \in Nat /\ MAX_TIME \in Nat /\ FRESH \in Nat /\ SLACK \in Nat
       /\ MAX_SESSIONS \in Nat \ {0} /\ MAX_SEQ \in Nat /\ FIX \in BOOLEAN
       /\ MODES \subseteq {"poll", "push", "webhook"} /\ MODES # {} /\ EVILS \subseteq BOOLEAN /\ EVILS # {}

Events == 1..N
FORGED == 0          \* the payload a forged delivery carries: no genuine event has it
Sessions == 1..MAX_SESSIONS

\* The state, as in delivery.qnt (each field is described there):
\*   cfg   [mode, evil, fix]
\*   now   the clock
\*   srv   [emitted, retained, pending, live, sent, lost]
\*   rly   [mailbox, nextSeq]
\*   disk  [cursor, seen, newest, recent, spool, pos, listed]
\*   host  [cc, helper, session, submitted]
\*   mem   [cursor, seen, newest, recent, dirty, step, conn, acks, taken, subbed]
\*   hist  [shown, acked, cut]
\* A delivery (Msg) is [seq, id, ts, ev, cur, recv, genuine]; a Step is [kind, msg, stage, list, next].
VARIABLES cfg, now, srv, rly, disk, host, mem, hist
vars == <<cfg, now, srv, rly, disk, host, mem, hist>>

\* ---- helpers --------------------------------------------------------------------------------
NoMsg == [seq |-> -1, id |-> -1, ts |-> -1, ev |-> -1, cur |-> -1, recv |-> -1, genuine |-> FALSE]
Idle == [kind |-> "", msg |-> NoMsg, stage |-> 0, list |-> <<>>, next |-> 0]
Max(a, b) == IF a > b THEN a ELSE b
MaxOf(S) == CHOOSE x \in S : \A y \in S : y <= x
MinOf(S) == CHOOSE x \in S : \A y \in S : x <= y
Elems(l) == {l[i] : i \in DOMAIN l}
Count(l, e) == Cardinality({i \in DOMAIN l : l[i] = e})
TailFrom(l, from) == IF from >= Len(l) THEN <<>> ELSE SubSeq(l, from + 1, Len(l))
\* Quint's l.slice(0, k): the first k elements.
Prefix(l, k) == SubSeq(l, 1, k)
Ids(r) == {p[1] : p \in r}
\* The events of S, in order (Quint: range(1, N + 1).select(e => S.contains(e))).
InOrder(S) == LET T == S \cap Events
              IN [i \in 1..Cardinality(T) |-> CHOOSE e \in T : Cardinality({x \in T : x < e}) = i - 1]

\* The server's safe-to-persist watermark: every event at or before it has been acknowledged by
\* the endpoint or abandoned.
Watermark(emitted, pending) == MaxOf({k \in 0..emitted : \A j \in 1..k : j \notin pending})

\* Everything any session's spool holds, and the genuine events the relay holds.
Stored == UNION {Elems(disk.spool[s]) : s \in Sessions}
InRelay == {d.ev : d \in {x \in rly.mailbox : x.genuine}}

\* What the helper knows when it starts. From 0.5.0 it also reads the spools of the sessions
\* listed for the project: an event already written there counts as seen although the watch was
\* not saved after it.
Loaded(d, s) ==
    [cursor |-> d.cursor,
     seen |-> IF cfg.fix THEN d.seen \cup UNION {Elems(d.spool[t]) : t \in d.listed \cup {s}} ELSE d.seen,
     newest |-> d.newest, recent |-> d.recent, dirty |-> FALSE,
     step |-> Idle, conn |-> {}, acks |-> {}, taken |-> -1, subbed |-> FALSE]

\* ---- init -----------------------------------------------------------------------------------
Init == \E mode \in MODES, evil \in EVILS :
    /\ cfg = [mode |-> mode, evil |-> evil /\ mode = "webhook", fix |-> FIX]
    /\ now = 0
    \* The watch is set before the first event: its first subscribe or poll is "from now on".
    /\ srv = [emitted |-> 0, retained |-> {}, pending |-> {}, live |-> mode = "webhook", sent |-> {}, lost |-> {}]
    /\ rly = [mailbox |-> {}, nextSeq |-> 0]
    /\ disk = [cursor |-> 0, seen |-> {}, newest |-> -1, recent |-> {},
               spool |-> [s \in Sessions |-> <<>>], pos |-> [s \in Sessions |-> 0],
               listed |-> IF FIX THEN {1} ELSE {}]
    /\ host = [cc |-> TRUE, helper |-> TRUE, session |-> 1, submitted |-> 0]
    /\ mem = [cursor |-> 0, seen |-> {}, newest |-> -1, recent |-> {}, dirty |-> FALSE, step |-> Idle,
              conn |-> {}, acks |-> {}, taken |-> -1, subbed |-> FALSE]
    /\ hist = [shown |-> <<>>, acked |-> {}, cut |-> {}]

\* ---- time and the server --------------------------------------------------------------------
Tick == /\ now < MAX_TIME
        /\ now' = now + 1
        /\ UNCHANGED <<cfg, srv, rly, disk, host, mem, hist>>

Emit == LET e == srv.emitted + 1 IN
    /\ srv.emitted < N
    /\ srv' = [srv EXCEPT !.emitted = e, !.retained = srv.retained \cup {e},
                          !.pending = IF cfg.mode = "webhook" /\ srv.live THEN srv.pending \cup {e} ELSE srv.pending]
    /\ UNCHANGED <<cfg, now, rly, disk, host, mem, hist>>

\* The oldest event leaves the server's history (its retention passed): it can no longer be replayed.
Expire ==
    /\ srv.retained # {}
    /\ srv' = [srv EXCEPT !.retained = srv.retained \ {MinOf(srv.retained)}]
    /\ UNCHANGED <<cfg, now, rly, disk, host, mem, hist>>

\* Webhook: the server POSTs a pending event to the relay, signed now. The relay stores it (once
\* for the very same delivery) and answers 2xx. `replied` FALSE is that answer lost on the way
\* back: the server tries again later, with a new timestamp and the same webhook-id.
PostOf(e, replied) ==
    LET m == [seq |-> rly.nextSeq, id |-> e, ts |-> now, ev |-> e, cur |-> Watermark(srv.emitted, srv.pending),
              recv |-> now, genuine |-> TRUE]
        same == \E d \in rly.mailbox : d.id = m.id /\ d.ts = m.ts
    IN /\ cfg.mode = "webhook" /\ srv.live /\ rly.nextSeq < MAX_SEQ /\ e \in srv.pending
       /\ srv' = [srv EXCEPT !.sent = srv.sent \cup {m}, !.pending = IF replied THEN srv.pending \ {e} ELSE srv.pending]
       /\ rly' = IF same THEN rly ELSE [mailbox |-> rly.mailbox \cup {m}, nextSeq |-> rly.nextSeq + 1]
       /\ UNCHANGED <<cfg, now, disk, host, mem, hist>>
Post == \E e \in srv.pending, replied \in BOOLEAN : PostOf(e, replied)

\* Webhook: retries ran out (an allowed loss).
Abandon == \E e \in srv.pending :
    /\ cfg.mode = "webhook"
    /\ srv' = [srv EXCEPT !.pending = srv.pending \ {e}, !.lost = srv.lost \cup {e}]
    /\ UNCHANGED <<cfg, now, rly, disk, host, mem, hist>>

\* Webhook: the server restarts, or the subscription's time to live runs out. Its retry queue is
\* gone; the next subscribe makes the subscription again from the client's cursor.
Lapse == /\ cfg.mode = "webhook" /\ srv.live
         /\ srv' = [srv EXCEPT !.live = FALSE, !.pending = {}]
         /\ UNCHANGED <<cfg, now, rly, disk, host, mem, hist>>

\* ---- the relay and the wire -----------------------------------------------------------------
\* A delivery's time to live at the relay passes, uncollected (an allowed loss).
RelayDrop == \E d \in rly.mailbox :
    /\ rly' = [rly EXCEPT !.mailbox = rly.mailbox \ {d}]
    /\ srv' = [srv EXCEPT !.lost = IF d.genuine /\ d.ev \notin Stored THEN srv.lost \cup {d.ev} ELSE srv.lost]
    /\ UNCHANGED <<cfg, now, disk, host, mem, hist>>

\* Anyone who knows the address posts a delivery they could not sign.
Forge == /\ rly.nextSeq < MAX_SEQ
         /\ rly' = [mailbox |-> rly.mailbox \cup {[seq |-> rly.nextSeq, id |-> 100 + rly.nextSeq, ts |-> now, ev |-> FORGED,
                                                   cur |-> N, recv |-> now, genuine |-> FALSE]},
                    nextSeq |-> rly.nextSeq + 1]
         /\ UNCHANGED <<cfg, now, srv, disk, host, mem, hist>>

\* Someone who saw a signed delivery posts it again. An honest relay takes it while it is fresh.
\* A lying relay hands it over at any time, saying it has just arrived.
Replay == \E m \in srv.sent :
    /\ rly.nextSeq < MAX_SEQ
    /\ cfg.evil \/ now - m.ts <= FRESH
    /\ ~(\E d \in rly.mailbox : d.id = m.id /\ d.ts = m.ts)
    /\ rly' = [mailbox |-> rly.mailbox \cup {[m EXCEPT !.seq = rly.nextSeq, !.recv = IF cfg.evil THEN m.ts ELSE now]},
               nextSeq |-> rly.nextSeq + 1]
    /\ UNCHANGED <<cfg, now, srv, disk, host, mem, hist>>

\* ---- the helper: webhook --------------------------------------------------------------------
Running == host.cc /\ host.helper

\* One delivery the relay hands over on this connection: an honest relay in the order it stored
\* them, a lying one in any order. Judged as handleDelivery judges it.
Take ==
    LET open == {x \in rly.mailbox : x.seq \notin mem.conn}
        first == MinOf({x.seq : x \in open} \cup {MAX_SEQ})
    IN \E d \in open :
        LET forged == ~d.genuine
            stale == d.recv - d.ts > FRESH \/ d.ts - d.recv > FRESH
            \* 0.4.1 refused one signed more than SLACK before the newest it had taken. From 0.5.0 only its
            \* memory of ids (and an 8-day ceiling, past this model's clock) refuses one.
            old == ~cfg.fix /\ mem.newest >= 0 /\ d.ts < mem.newest - SLACK
            dup == d.id \in Ids(mem.recent)
            refuse == forged \/ stale \/ old \/ dup
        IN /\ Running /\ cfg.mode = "webhook" /\ mem.step.kind = ""
           /\ cfg.evil \/ d.seq = first
           /\ mem' = IF refuse THEN [mem EXCEPT !.conn = mem.conn \cup {d.seq}, !.acks = mem.acks \cup {d}]
                     ELSE [mem EXCEPT !.conn = mem.conn \cup {d.seq},
                                      !.step = [Idle EXCEPT !.kind = "wh", !.msg = d, !.stage = 1]]
           /\ UNCHANGED <<cfg, now, srv, rly, disk, host, hist>>

\* #deliver, first half: the event is written to the session's spool and flushed, if it is new.
\* (Quint's Append.)
AppendEv ==
    LET k == mem.step.kind
        e == IF k = "poll" THEN Head(mem.step.list) ELSE mem.step.msg.ev
        s == host.session
    IN /\ Running /\ k # "" /\ mem.step.stage = 1
       /\ k # "poll" \/ Len(mem.step.list) > 0
       /\ disk' = IF e \in mem.seen THEN disk ELSE [disk EXCEPT !.spool[s] = Append(disk.spool[s], e)]
       /\ mem' = [mem EXCEPT !.step = [mem.step EXCEPT !.stage = 2]]
       /\ UNCHANGED <<cfg, now, srv, rly, host, hist>>

\* #deliver, second half: the watch (its seen ids and cursor) is saved.
SaveWatch ==
    LET k == mem.step.kind
        e == IF k = "poll" THEN Head(mem.step.list) ELSE mem.step.msg.ev
        c == IF k = "poll" THEN mem.cursor ELSE mem.step.msg.cur
        seen == mem.seen \cup {e}
    IN /\ Running /\ k # "" /\ mem.step.stage = 2
       /\ disk' = [disk EXCEPT !.seen = seen, !.cursor = c]
       /\ mem' = [mem EXCEPT !.seen = seen, !.cursor = c, !.dirty = FALSE,
                             !.step = IF k = "wh" THEN [mem.step EXCEPT !.stage = 3]
                                      ELSE IF k = "poll" THEN [mem.step EXCEPT !.stage = 1, !.list = Tail(mem.step.list)]
                                      ELSE Idle]
       /\ UNCHANGED <<cfg, now, srv, rly, host, hist>>

\* The replay memory takes the delivery and is saved; the ack is queued.
Commit ==
    LET d == mem.step.msg
        recent == mem.recent \cup {<<d.id, d.ts>>}
        newest == Max(mem.newest, d.ts)
        \* 0.4.1 forgot ids signed more than SLACK before the newest; from 0.5.0 they are kept (to a count).
        kept == IF cfg.fix THEN recent ELSE {p \in recent : p[2] >= newest - SLACK}
    IN /\ Running /\ mem.step.kind = "wh" /\ mem.step.stage = 3
       /\ disk' = [disk EXCEPT !.recent = kept, !.newest = newest]
       /\ mem' = [mem EXCEPT !.recent = kept, !.newest = newest, !.step = Idle, !.acks = mem.acks \cup {d}]
       /\ UNCHANGED <<cfg, now, srv, rly, host, hist>>

\* A delivery cannot be stored right now (the session's store is full, a save fails): answered
\* 503, so not acknowledged. The relay hands it over again on the next connection.
StoreFails ==
    /\ Running /\ mem.step.kind = "wh" /\ mem.step.stage <= 2
    /\ mem' = [mem EXCEPT !.step = Idle,
                          !.seen = IF mem.step.stage = 2 THEN mem.seen \cup {mem.step.msg.ev} ELSE mem.seen]
    /\ UNCHANGED <<cfg, now, srv, rly, disk, host, hist>>

\* The queued acks go out together; the relay deletes what they name.
FlushAcks ==
    /\ Running /\ mem.acks # {}
    /\ rly' = [rly EXCEPT !.mailbox = {d \in rly.mailbox : ~(\E a \in mem.acks : a.seq = d.seq)}]
    /\ hist' = [hist EXCEPT !.acked = hist.acked \cup mem.acks]
    /\ mem' = [mem EXCEPT !.acks = {}]
    /\ UNCHANGED <<cfg, now, srv, disk, host>>

\* The relay connection drops and is made again: queued acks are lost, and the relay hands over
\* everything it still holds.
Reconnect ==
    /\ Running /\ cfg.mode = "webhook" /\ mem.step.kind = ""
    /\ mem' = [mem EXCEPT !.conn = {}, !.acks = {}]
    /\ UNCHANGED <<cfg, now, srv, rly, disk, host, hist>>

\* events/subscribe, first or refresh, with the watch's cursor. A subscription the server lost is
\* made again from that cursor: what the server still holds after it is delivered again, and
\* what it no longer holds is a gap (truncated). The answer's cursor is the watermark.
Subscribe ==
    LET c == mem.cursor
        replay == {e \in srv.retained : e > c /\ e <= srv.emitted}
        gap == {e \in Events : e > c /\ e <= srv.emitted /\ e \notin srv.retained /\ e \notin Stored /\ e \notin InRelay}
        pending == IF srv.live THEN srv.pending ELSE replay
    IN /\ Running /\ cfg.mode = "webhook" /\ mem.step.kind = ""
       /\ srv' = [srv EXCEPT !.live = TRUE, !.pending = pending, !.lost = IF srv.live THEN srv.lost ELSE srv.lost \cup gap]
       /\ mem' = [mem EXCEPT !.cursor = Watermark(srv.emitted, pending), !.dirty = TRUE]
       /\ UNCHANGED <<cfg, now, rly, disk, host, hist>>

\* ---- the helper: poll and push --------------------------------------------------------------
\* events/poll with the watch's cursor. The answer is taken one event at a time (AppendEv,
\* SaveWatch, with the cursor left as it was); its own cursor is kept after the last one.
Poll ==
    LET c == mem.cursor
        evs == {e \in Events : e > c /\ e <= srv.emitted /\ e \in srv.retained}
        gap == {e \in Events : e > c /\ e <= srv.emitted /\ e \notin srv.retained /\ e \notin Stored}
    IN /\ Running /\ cfg.mode = "poll" /\ mem.step.kind = ""
       /\ mem' = [mem EXCEPT !.step = [Idle EXCEPT !.kind = "poll", !.stage = 1, !.list = InOrder(evs), !.next = srv.emitted]]
       /\ srv' = [srv EXCEPT !.lost = srv.lost \cup gap]
       /\ UNCHANGED <<cfg, now, rly, disk, host, hist>>

\* The poll answer is used up: its cursor becomes the watch's, saved a moment later (saveSoon).
PollDone ==
    /\ Running /\ mem.step.kind = "poll" /\ mem.step.stage = 1 /\ Len(mem.step.list) = 0
    /\ mem' = [mem EXCEPT !.step = Idle, !.cursor = mem.step.next, !.dirty = TRUE]
    /\ UNCHANGED <<cfg, now, srv, rly, disk, host, hist>>

\* The next event on the push stream after the watch's cursor (anything missing before it is a gap).
Push ==
    LET c == mem.cursor
        later == {e \in Events : e > c /\ e <= srv.emitted /\ e \in srv.retained}
        e == MinOf(later)
        gap == {x \in Events : x > c /\ x < e /\ x \notin Stored}
    IN /\ Running /\ cfg.mode = "push" /\ mem.step.kind = "" /\ later # {}
       /\ mem' = [mem EXCEPT !.step = [Idle EXCEPT !.kind = "push", !.stage = 1, !.msg = [NoMsg EXCEPT !.ev = e, !.cur = e]]]
       /\ srv' = [srv EXCEPT !.lost = srv.lost \cup gap]
       /\ UNCHANGED <<cfg, now, rly, disk, host, hist>>

\* A cursor taken in memory (a poll's, a subscribe answer's) is written down.
SaveSoon ==
    /\ Running /\ mem.dirty
    /\ disk' = [disk EXCEPT !.cursor = mem.cursor]
    /\ mem' = [mem EXCEPT !.dirty = FALSE]
    /\ UNCHANGED <<cfg, now, srv, rly, host, hist>>

\* ---- handing events to the session ----------------------------------------------------------
\* The hooks module asks for what waits (/take). From 0.5.0 it first acknowledges what it last
\* submitted, which a helper that restarted in between never heard.
HandTake ==
    LET s == host.session
        p == IF cfg.fix THEN Max(disk.pos[s], host.submitted) ELSE disk.pos[s]
    IN /\ Running /\ mem.taken = -1 /\ p < Len(disk.spool[s])
       /\ disk' = [disk EXCEPT !.pos[s] = p]
       /\ mem' = [mem EXCEPT !.taken = Len(disk.spool[s]), !.subbed = FALSE]
       /\ UNCHANGED <<cfg, now, srv, rly, host, hist>>

\* $.prompt.submit: the session is shown the batch.
HandSubmit ==
    LET s == host.session
        p == disk.pos[s]
    IN /\ Running /\ mem.taken >= 0 /\ ~mem.subbed
       /\ hist' = [hist EXCEPT !.shown = hist.shown \o Prefix(TailFrom(disk.spool[s], p), mem.taken - p)]
       /\ host' = [host EXCEPT !.submitted = mem.taken]
       /\ mem' = [mem EXCEPT !.subbed = TRUE]
       /\ UNCHANGED <<cfg, now, srv, rly, disk>>

\* /ack: the position is saved.
HandAck ==
    LET s == host.session IN
    /\ Running /\ mem.taken >= 0 /\ mem.subbed
    /\ disk' = [disk EXCEPT !.pos[s] = Max(disk.pos[s], mem.taken)]
    /\ mem' = [mem EXCEPT !.taken = -1, !.subbed = FALSE]
    /\ UNCHANGED <<cfg, now, srv, rly, host, hist>>

\* ---- stopping and starting ------------------------------------------------------------------
\* The helper dies; Claude Code stays. Everything in the helper's memory is gone.
HelperCrash ==
    /\ host.helper
    /\ host' = [host EXCEPT !.helper = FALSE]
    /\ mem' = Loaded(disk, host.session)
    /\ UNCHANGED <<cfg, now, srv, rly, disk, hist>>

\* The hooks module starts the helper again, in the same session.
HelperStart ==
    /\ host.cc /\ ~host.helper
    /\ host' = [host EXCEPT !.helper = TRUE]
    /\ mem' = Loaded(disk, host.session)
    /\ UNCHANGED <<cfg, now, srv, rly, disk, hist>>

\* Claude Code is closed, or crashes: the helper and the hooks module go with it.
Close ==
    LET s == host.session
        p == disk.pos[s]
        \* A batch submitted whose ack was not saved: nobody left knows it was shown.
        unsaved == IF mem.taken >= 0 /\ mem.subbed THEN Elems(Prefix(TailFrom(disk.spool[s], p), mem.taken - p))
                   ELSE IF host.submitted > p THEN Elems(Prefix(TailFrom(disk.spool[s], p), host.submitted - p))
                   ELSE {}
    IN /\ host.cc
       /\ host' = [cc |-> FALSE, helper |-> FALSE, session |-> s, submitted |-> 0]
       /\ mem' = Loaded(disk, s)
       /\ hist' = [hist EXCEPT !.cut = hist.cut \cup unsaved]
       /\ UNCHANGED <<cfg, now, srv, rly, disk>>

\* Claude Code is opened again in the project: a new session, whose helper claims the watches.
\* From 0.5.0 the session is first listed for the project.
Open ==
    LET s == host.session + 1
        d == [disk EXCEPT !.listed = IF cfg.fix THEN disk.listed \cup {s} ELSE disk.listed]
    IN /\ ~host.cc /\ s <= MAX_SESSIONS
       /\ host' = [cc |-> TRUE, helper |-> TRUE, session |-> s, submitted |-> 0]
       /\ disk' = d
       /\ mem' = Loaded(d, s)
       /\ UNCHANGED <<cfg, now, srv, rly, hist>>

\* From 0.5.0, what a starting helper does with what earlier sessions left (WatchManager.#recover),
\* in the order the code does it. Everything is read before anything is written: the seen ids (in
\* Loaded) and what to carry, from every listed session at once.
\*
\* First, one write appends, to this session's spool, what listed earlier sessions hold past their
\* hand-over position that was handed over in none of them and is not here already.
Handed(d) == UNION {Elems(Prefix(d.spool[t], d.pos[t])) : t \in d.listed}
Waiting(d, s) == UNION {Elems(TailFrom(d.spool[t], d.pos[t])) : t \in d.listed \ {s}}
\* The events in the spools of the listed earlier sessions: seen, though perhaps not saved as seen.
Recovered(d, s) == UNION {Elems(d.spool[t]) : t \in d.listed \ {s}}
Carry ==
    LET s == host.session
        carry == (Waiting(disk, s) \ Handed(disk)) \ Elems(disk.spool[s])
    IN /\ cfg.fix /\ Running /\ mem.step.kind = "" /\ carry # {}
       /\ disk' = [disk EXCEPT !.spool[s] = disk.spool[s] \o InOrder(carry)]
       /\ mem' = [mem EXCEPT !.seen = mem.seen \cup carry]
       /\ UNCHANGED <<cfg, now, srv, rly, host, hist>>

\* Then the watch is saved with the seen ids read there (#saveNow). 0.5.0 saved it only after the
\* next step, which TLC found could forget them; from 0.5.1 it is saved first. A save that fails is
\* this step not happening.
SaveSeen ==
    LET s == host.session IN
    /\ cfg.fix /\ Running /\ mem.step.kind = "" /\ ~(Recovered(disk, s) \subseteq disk.seen)
    /\ disk' = [disk EXCEPT !.seen = mem.seen \cup Recovered(disk, s)]
    /\ UNCHANGED <<cfg, now, srv, rly, host, mem, hist>>

\* Last, once those ids are saved and what waited there is here (or was handed over), every listed
\* earlier session is marked as handed over and taken off the list, together.
Settle ==
    LET s == host.session
        others == disk.listed \ {s}
    IN /\ cfg.fix /\ Running /\ mem.step.kind = "" /\ others # {}
       /\ Recovered(disk, s) \subseteq disk.seen
       /\ \A t \in others : Elems(TailFrom(disk.spool[t], disk.pos[t])) \subseteq (Elems(disk.spool[s]) \cup Handed(disk))
       /\ disk' = [disk EXCEPT !.pos = [t \in DOMAIN disk.pos |-> IF t \in others THEN Len(disk.spool[t]) ELSE disk.pos[t]],
                               !.listed = disk.listed \ others]
       /\ UNCHANGED <<cfg, now, srv, rly, host, mem, hist>>

Next == \/ Tick \/ Emit \/ Expire \/ Post \/ Abandon \/ Lapse
        \/ RelayDrop \/ Forge \/ Replay
        \/ Take \/ AppendEv \/ SaveWatch \/ Commit \/ StoreFails \/ FlushAcks \/ Reconnect \/ Subscribe
        \/ Poll \/ PollDone \/ Push \/ SaveSoon
        \/ HandTake \/ HandSubmit \/ HandAck
        \/ HelperCrash \/ HelperStart \/ Close \/ Open \/ Carry \/ SaveSeen \/ Settle

Spec == Init /\ [][Next]_vars

\* ---- invariants (the same names as in delivery.qnt) -----------------------------------------
\* 1. The session is shown each event at most once, across helper restarts and sessions...
StrictAtMostOnce == \A e \in Events : Count(hist.shown, e) <= 1
\* ...except an event in a batch that was submitted to a session which Claude Code then closed
\* before the batch's ack was saved: the next session is shown it again (at least once, not at
\* most once). The submit happens in Claude Code and the ack is saved by the helper; nothing
\* makes the two one step.
AtMostOnce == \A e \in Events : Count(hist.shown, e) <= 1 \/ e \in hist.cut

\* 2. Nothing forged is stored, so nothing forged is shown.
NothingForged == \A s \in Sessions : FORGED \notin Elems(disk.spool[s])

\* 3. With an honest relay: a genuine delivery is acknowledged to the relay (and so deleted there)
\*    only once its event is on disk, or its loss is one the extension allows.
NoAckBeforeStore == cfg.evil \/ \A d \in hist.acked : ~d.genuine \/ d.ev \in Stored \/ d.ev \in srv.lost

\* 4. No event is stranded: one stored in an earlier session's spool and never handed over is
\*    still on its way to a session (that session is listed, or the event is in the current spool).
NoneStranded == \A t \in Sessions : t = host.session \/
    \A e \in Elems(TailFrom(disk.spool[t], disk.pos[t])) :
        e \in Elems(hist.shown) \/ t \in disk.listed \/ e \in Elems(disk.spool[host.session])

\* 5. With an honest relay: the saved cursor never passes an event that is neither stored, nor
\*    still at the relay, nor lost for a reason the extension allows. Resuming from it skips nothing else.
CursorSafe == cfg.evil \/ \A e \in 1..disk.cursor : e \in Stored \/ e \in InRelay \/ e \in srv.lost

Safety == AtMostOnce /\ NothingForged /\ NoAckBeforeStore /\ NoneStranded /\ CursorSafe
=============================================================================
