// A model of how one watch's events travel from an MCP server to a Claude Code session in
// mcp-events: by poll, push or webhook (through the relay), with the helper and Claude Code
// stopping and starting between any two steps, a forger and a replayer on the wire, and
// optionally a relay that lies. One subscription, one project, one Claude Code window at a time.
// model/README.md says what each part stands for in the code, what each invariant means, and
// what checking them showed.
//
// `init` is the client as it is from 0.5.0. `initBefore` is the client as it was in 0.4.1, so
// the counterexamples that version had can be shown again (`quint run --init initBefore`).
module delivery {
  // ---- bounds --------------------------------------------------------------------------------
  pure val N = 3            // events the server emits
  pure val MAX_TIME = 7     // the clock's bound; one unit stands for five minutes
  pure val FRESH = 1        // Standard Webhooks freshness: five minutes
  pure val SLACK = 2        // 0.4.1's REPLAY_SLACK_S: ten minutes
  pure val MAX_SESSIONS = 3 // Claude Code sessions in one run (each open after a close is a new one)
  pure val MAX_SEQ = 9      // deliveries the relay ever stores (genuine, retried, forged or replayed)
  pure val Events = 1.to(N)
  pure val FORGED = 0       // the payload a forged delivery carries: no genuine event has it

  // ---- types ---------------------------------------------------------------------------------
  // A webhook delivery: its relay sequence number, webhook-id, webhook-timestamp, the event it
  // carries, the watermark cursor in its body, when the relay says it arrived, and whether the
  // server signed it.
  type Msg = { seq: int, id: int, ts: int, ev: int, cur: int, recv: int, genuine: bool }
  // What the helper is in the middle of. kind "" is nothing.
  //   "wh"   one relay delivery: stage 1 append to the spool, 2 save the watch, 3 commit the replay memory
  //   "poll" a poll answer: `list` still to take (stage 1 append, 2 save); then `next` is the cursor
  //   "push" one stream event: stage 1 append, 2 save
  type Step = { kind: str, msg: Msg, stage: int, list: List[int], next: int }
  type Cfg = { mode: str, evil: bool, fix: bool }

  type Server = {
    emitted: int,         // events 1..emitted have happened
    retained: Set[int],   // events the server can still replay from a cursor
    pending: Set[int],    // webhook: events waiting for a 2xx from the endpoint
    live: bool,           // webhook: the server holds the subscription
    sent: Set[Msg],       // every signed POST ever made: what a replayer has
    lost: Set[int]        // events given up for a reason the extension allows: retention passed, retries ran out
  }
  type Relay = { mailbox: Set[Msg], nextSeq: int }
  type Disk = {
    cursor: int, seen: Set[int], newest: int, recent: Set[(int, int)],   // watches.json
    spool: int -> List[int],     // sessions/<id>/events.jsonl (event ids, in order)
    pos: int -> int,             // sessions/<id>/delivered.pos (how many records were handed over)
    listed: Set[int]             // 0.5.0: sessions whose spool may hold events not yet handed over
  }
  // Claude Code open; the helper running; which session; and (0.5.0) the spool position the hooks
  // module last submitted, which it keeps while the helper restarts.
  type Host = { cc: bool, helper: bool, session: int, submitted: int }
  type Mem = {
    cursor: int, seen: Set[int], newest: int, recent: Set[(int, int)], dirty: bool,
    step: Step,
    conn: Set[int],   // relay: deliveries handled on this connection (the relay sends each once per connection)
    acks: Set[Msg],   // relay: acks queued, not yet sent (they go out together)
    taken: int,       // hand-over: the spool position of the batch taken, or -1
    subbed: bool      // hand-over: that batch was submitted
  }
  // shown: every event shown to a session, in order. acked: deliveries acknowledged to the relay.
  // cut: events of a batch submitted to a session that Claude Code closed before the batch's ack was saved.
  type Hist = { shown: List[int], acked: Set[Msg], cut: Set[int] }

  // ---- state ---------------------------------------------------------------------------------
  var cfg: Cfg
  var now: int
  var srv: Server
  var rly: Relay
  var disk: Disk
  var host: Host
  var mem: Mem
  var hist: Hist

  // ---- helpers -------------------------------------------------------------------------------
  pure val NoMsg: Msg = { seq: -1, id: -1, ts: -1, ev: -1, cur: -1, recv: -1, genuine: false }
  pure val Idle: Step = { kind: "", msg: NoMsg, stage: 0, list: List(), next: 0 }
  pure def max(a: int, b: int): int = if (a > b) a else b
  pure def elems(l: List[int]): Set[int] = l.indices().map(i => l[i])
  pure def count(l: List[int], e: int): int = l.foldl(0, (n, x) => if (x == e) n + 1 else n)
  pure def tailFrom(l: List[int], from: int): List[int] = if (from >= l.length()) List() else l.slice(from, l.length())
  pure def ids(r: Set[(int, int)]): Set[int] = r.map(p => p._1)
  pure def inOrder(s: Set[int]): List[int] = range(1, N + 1).select(e => s.contains(e))
  pure val sessions: Set[int] = 1.to(MAX_SESSIONS)

  // The server's safe-to-persist watermark: every event at or before it has been acknowledged by
  // the endpoint or abandoned.
  pure def watermark(emitted: int, pending: Set[int]): int =
    0.to(emitted).filter(k => 1.to(k).forall(j => not(pending.contains(j)))).fold(0, max)

  // Everything any session's spool holds, and the genuine events the relay holds.
  val stored: Set[int] = sessions.fold(Set(), (acc, s) => acc.union(elems(disk.spool.get(s))))
  val inRelay: Set[int] = rly.mailbox.filter(d => d.genuine).map(d => d.ev)

  // What the helper knows when it starts. From 0.5.0 it also reads the spools of the sessions
  // listed for the project: an event already written there counts as seen although the watch was
  // not saved after it.
  def loaded(d: Disk, s: int): Mem = {
    cursor: d.cursor,
    seen: if (cfg.fix) d.listed.union(Set(s)).fold(d.seen, (acc, t) => acc.union(elems(d.spool.get(t)))) else d.seen,
    newest: d.newest, recent: d.recent, dirty: false,
    step: Idle, conn: Set(), acks: Set(), taken: -1, subbed: false
  }

  // ---- init ----------------------------------------------------------------------------------
  action initWith(fix: bool, modes: Set[str], evils: Set[bool]): bool = {
    nondet mode = modes.oneOf()
    nondet evil = evils.oneOf()
    all {
      cfg' = { mode: mode, evil: evil and mode == "webhook", fix: fix },
      now' = 0,
      // The watch is set before the first event: its first subscribe or poll is "from now on".
      srv' = { emitted: 0, retained: Set(), pending: Set(), live: mode == "webhook", sent: Set(), lost: Set() },
      rly' = { mailbox: Set(), nextSeq: 0 },
      disk' = {
        cursor: 0, seen: Set(), newest: -1, recent: Set(),
        spool: sessions.mapBy(_ => List()), pos: sessions.mapBy(_ => 0),
        listed: if (fix) Set(1) else Set()
      },
      host' = { cc: true, helper: true, session: 1, submitted: 0 },
      mem' = { cursor: 0, seen: Set(), newest: -1, recent: Set(), dirty: false, step: Idle, conn: Set(), acks: Set(), taken: -1, subbed: false },
      hist' = { shown: List(), acked: Set(), cut: Set() }
    }
  }
  pure val ALL_MODES = Set("poll", "push", "webhook")
  action init = initWith(true, ALL_MODES, Set(false, true))
  action initBefore = initWith(false, ALL_MODES, Set(false, true))
  // One mode at a time, so that a run of samples is spent where a case is (`--init webhook`, ...).
  action poll = initWith(true, Set("poll"), Set(false))
  action push = initWith(true, Set("push"), Set(false))
  action webhook = initWith(true, Set("webhook"), Set(false))
  action webhookEvilRelay = initWith(true, Set("webhook"), Set(true))
  action pollBefore = initWith(false, Set("poll"), Set(false))
  action pushBefore = initWith(false, Set("push"), Set(false))
  action webhookBefore = initWith(false, Set("webhook"), Set(false))
  action webhookEvilRelayBefore = initWith(false, Set("webhook"), Set(true))

  // ---- time and the server -------------------------------------------------------------------
  action Tick = all {
    now < MAX_TIME,
    now' = now + 1,
    cfg' = cfg, srv' = srv, rly' = rly, disk' = disk, host' = host, mem' = mem, hist' = hist
  }

  action Emit = {
    val e = srv.emitted + 1
    all {
      srv.emitted < N,
      srv' = { ...srv, emitted: e, retained: srv.retained.union(Set(e)),
               pending: if (cfg.mode == "webhook" and srv.live) srv.pending.union(Set(e)) else srv.pending },
      cfg' = cfg, now' = now, rly' = rly, disk' = disk, host' = host, mem' = mem, hist' = hist
    }
  }

  // The oldest event leaves the server's history (its retention passed): it can no longer be replayed.
  action Expire = {
    val e = srv.retained.fold(N + 1, (a, b) => if (a < b) a else b)
    all {
      srv.retained != Set(),
      srv' = { ...srv, retained: srv.retained.exclude(Set(e)) },
      cfg' = cfg, now' = now, rly' = rly, disk' = disk, host' = host, mem' = mem, hist' = hist
    }
  }

  // Webhook: the server POSTs a pending event to the relay, signed now. The relay stores it (once
  // for the very same delivery) and answers 2xx. `replied` false is that answer lost on the way
  // back: the server tries again later, with a new timestamp and the same webhook-id.
  action Post = {
    nondet e = srv.pending.oneOf()
    nondet replied = Set(true, false).oneOf()
    PostOf(e, replied)
  }
  action PostOf(e: int, replied: bool): bool = {
    val m: Msg = { seq: rly.nextSeq, id: e, ts: now, ev: e, cur: watermark(srv.emitted, srv.pending), recv: now, genuine: true }
    val same = rly.mailbox.exists(d => d.id == m.id and d.ts == m.ts)
    all {
      cfg.mode == "webhook", srv.live, rly.nextSeq < MAX_SEQ, srv.pending.contains(e),
      srv' = { ...srv, sent: srv.sent.union(Set(m)), pending: if (replied) srv.pending.exclude(Set(e)) else srv.pending },
      rly' = if (same) rly else { mailbox: rly.mailbox.union(Set(m)), nextSeq: rly.nextSeq + 1 },
      cfg' = cfg, now' = now, disk' = disk, host' = host, mem' = mem, hist' = hist
    }
  }

  // Webhook: retries ran out (an allowed loss).
  action Abandon = {
    nondet e = srv.pending.oneOf()
    all {
      cfg.mode == "webhook",
      srv' = { ...srv, pending: srv.pending.exclude(Set(e)), lost: srv.lost.union(Set(e)) },
      cfg' = cfg, now' = now, rly' = rly, disk' = disk, host' = host, mem' = mem, hist' = hist
    }
  }

  // Webhook: the server restarts, or the subscription's time to live runs out. Its retry queue is
  // gone; the next subscribe makes the subscription again from the client's cursor.
  action Lapse = all {
    cfg.mode == "webhook", srv.live,
    srv' = { ...srv, live: false, pending: Set() },
    cfg' = cfg, now' = now, rly' = rly, disk' = disk, host' = host, mem' = mem, hist' = hist
  }

  // ---- the relay and the wire ----------------------------------------------------------------
  // A delivery's time to live at the relay passes, uncollected (an allowed loss).
  action RelayDrop = {
    nondet d = rly.mailbox.oneOf()
    all {
      rly' = { ...rly, mailbox: rly.mailbox.exclude(Set(d)) },
      srv' = { ...srv, lost: if (d.genuine and not(stored.contains(d.ev))) srv.lost.union(Set(d.ev)) else srv.lost },
      cfg' = cfg, now' = now, disk' = disk, host' = host, mem' = mem, hist' = hist
    }
  }

  // Anyone who knows the address posts a delivery they could not sign.
  action Forge = all {
    rly.nextSeq < MAX_SEQ,
    rly' = { mailbox: rly.mailbox.union(Set({ seq: rly.nextSeq, id: 100 + rly.nextSeq, ts: now, ev: FORGED, cur: N, recv: now, genuine: false })), nextSeq: rly.nextSeq + 1 },
    cfg' = cfg, now' = now, srv' = srv, disk' = disk, host' = host, mem' = mem, hist' = hist
  }

  // Someone who saw a signed delivery posts it again. An honest relay takes it while it is fresh.
  // A lying relay hands it over at any time, saying it has just arrived.
  action Replay = {
    nondet m = srv.sent.oneOf()
    all {
      rly.nextSeq < MAX_SEQ,
      cfg.evil or now - m.ts <= FRESH,
      not(rly.mailbox.exists(d => d.id == m.id and d.ts == m.ts)),
      rly' = { mailbox: rly.mailbox.union(Set({ ...m, seq: rly.nextSeq, recv: if (cfg.evil) m.ts else now })), nextSeq: rly.nextSeq + 1 },
      cfg' = cfg, now' = now, srv' = srv, disk' = disk, host' = host, mem' = mem, hist' = hist
    }
  }

  // ---- the helper: webhook ------------------------------------------------------------------
  val running: bool = host.cc and host.helper

  // One delivery the relay hands over on this connection: an honest relay in the order it stored
  // them, a lying one in any order. Judged as handleDelivery judges it.
  action Take = {
    val open = rly.mailbox.filter(x => not(mem.conn.contains(x.seq)))
    val first = open.fold(MAX_SEQ, (a, x) => if (x.seq < a) x.seq else a)
    nondet d = open.oneOf()
    val forged = not(d.genuine)
    val stale = d.recv - d.ts > FRESH or d.ts - d.recv > FRESH
    // 0.4.1 refused one signed more than SLACK before the newest it had taken. From 0.5.0 only its
    // memory of ids (and an 8-day ceiling, past this model's clock) refuses one.
    val old = not(cfg.fix) and mem.newest >= 0 and d.ts < mem.newest - SLACK
    val dup = ids(mem.recent).contains(d.id)
    val refuse = forged or stale or old or dup
    all {
      running, cfg.mode == "webhook", mem.step.kind == "",
      cfg.evil or d.seq == first,
      mem' = if (refuse) { ...mem, conn: mem.conn.union(Set(d.seq)), acks: mem.acks.union(Set(d)) }
             else { ...mem, conn: mem.conn.union(Set(d.seq)), step: { ...Idle, kind: "wh", msg: d, stage: 1 } },
      cfg' = cfg, now' = now, srv' = srv, rly' = rly, disk' = disk, host' = host, hist' = hist
    }
  }

  // #deliver, first half: the event is written to the session's spool and flushed, if it is new.
  action Append = {
    val k = mem.step.kind
    val e = if (k == "poll") mem.step.list[0] else mem.step.msg.ev
    val s = host.session
    all {
      running, k != "", mem.step.stage == 1,
      k != "poll" or mem.step.list.length() > 0,
      disk' = if (mem.seen.contains(e)) disk else { ...disk, spool: disk.spool.set(s, disk.spool.get(s).append(e)) },
      mem' = { ...mem, step: { ...mem.step, stage: 2 } },
      cfg' = cfg, now' = now, srv' = srv, rly' = rly, host' = host, hist' = hist
    }
  }

  // #deliver, second half: the watch (its seen ids and cursor) is saved.
  action SaveWatch = {
    val k = mem.step.kind
    val e = if (k == "poll") mem.step.list[0] else mem.step.msg.ev
    val c = if (k == "poll") mem.cursor else mem.step.msg.cur
    val seen = mem.seen.union(Set(e))
    all {
      running, k != "", mem.step.stage == 2,
      disk' = { ...disk, seen: seen, cursor: c },
      mem' = { ...mem, seen: seen, cursor: c, dirty: false,
               step: if (k == "wh") { ...mem.step, stage: 3 }
                     else if (k == "poll") { ...mem.step, stage: 1, list: mem.step.list.slice(1, mem.step.list.length()) }
                     else Idle },
      cfg' = cfg, now' = now, srv' = srv, rly' = rly, host' = host, hist' = hist
    }
  }

  // The replay memory takes the delivery and is saved; the ack is queued.
  action Commit = {
    val d = mem.step.msg
    val recent = mem.recent.union(Set((d.id, d.ts)))
    val newest = max(mem.newest, d.ts)
    // 0.4.1 forgot ids signed more than SLACK before the newest; from 0.5.0 they are kept (to a count).
    val kept = if (cfg.fix) recent else recent.filter(p => p._2 >= newest - SLACK)
    all {
      running, mem.step.kind == "wh", mem.step.stage == 3,
      disk' = { ...disk, recent: kept, newest: newest },
      mem' = { ...mem, recent: kept, newest: newest, step: Idle, acks: mem.acks.union(Set(d)) },
      cfg' = cfg, now' = now, srv' = srv, rly' = rly, host' = host, hist' = hist
    }
  }

  // A delivery cannot be stored right now (the session's store is full, a save fails): answered
  // 503, so not acknowledged. The relay hands it over again on the next connection.
  action StoreFails = all {
    running, mem.step.kind == "wh", mem.step.stage <= 2,
    mem' = { ...mem, step: Idle, seen: if (mem.step.stage == 2) mem.seen.union(Set(mem.step.msg.ev)) else mem.seen },
    cfg' = cfg, now' = now, srv' = srv, rly' = rly, disk' = disk, host' = host, hist' = hist
  }

  // The queued acks go out together; the relay deletes what they name.
  action FlushAcks = all {
    running, mem.acks != Set(),
    rly' = { ...rly, mailbox: rly.mailbox.filter(d => not(mem.acks.exists(a => a.seq == d.seq))) },
    hist' = { ...hist, acked: hist.acked.union(mem.acks) },
    mem' = { ...mem, acks: Set() },
    cfg' = cfg, now' = now, srv' = srv, disk' = disk, host' = host
  }

  // The relay connection drops and is made again: queued acks are lost, and the relay hands over
  // everything it still holds.
  action Reconnect = all {
    running, cfg.mode == "webhook", mem.step.kind == "",
    mem' = { ...mem, conn: Set(), acks: Set() },
    cfg' = cfg, now' = now, srv' = srv, rly' = rly, disk' = disk, host' = host, hist' = hist
  }

  // events/subscribe, first or refresh, with the watch's cursor. A subscription the server lost is
  // made again from that cursor: what the server still holds after it is delivered again, and
  // what it no longer holds is a gap (truncated). The answer's cursor is the watermark.
  action Subscribe = {
    val c = mem.cursor
    val replay = srv.retained.filter(e => e > c and e <= srv.emitted)
    val gap = Events.filter(e => e > c and e <= srv.emitted and not(srv.retained.contains(e)) and not(stored.contains(e)) and not(inRelay.contains(e)))
    val pending = if (srv.live) srv.pending else replay
    all {
      running, cfg.mode == "webhook", mem.step.kind == "",
      srv' = { ...srv, live: true, pending: pending, lost: if (srv.live) srv.lost else srv.lost.union(gap) },
      mem' = { ...mem, cursor: watermark(srv.emitted, pending), dirty: true },
      cfg' = cfg, now' = now, rly' = rly, disk' = disk, host' = host, hist' = hist
    }
  }

  // ---- the helper: poll and push -------------------------------------------------------------
  // events/poll with the watch's cursor. The answer is taken one event at a time (Append,
  // SaveWatch, with the cursor left as it was); its own cursor is kept after the last one.
  action Poll = {
    val c = mem.cursor
    val evs = Events.filter(e => e > c and e <= srv.emitted and srv.retained.contains(e))
    val gap = Events.filter(e => e > c and e <= srv.emitted and not(srv.retained.contains(e)) and not(stored.contains(e)))
    all {
      running, cfg.mode == "poll", mem.step.kind == "",
      mem' = { ...mem, step: { ...Idle, kind: "poll", stage: 1, list: inOrder(evs), next: srv.emitted } },
      srv' = { ...srv, lost: srv.lost.union(gap) },
      cfg' = cfg, now' = now, rly' = rly, disk' = disk, host' = host, hist' = hist
    }
  }

  // The poll answer is used up: its cursor becomes the watch's, saved a moment later (saveSoon).
  action PollDone = all {
    running, mem.step.kind == "poll", mem.step.stage == 1, mem.step.list.length() == 0,
    mem' = { ...mem, step: Idle, cursor: mem.step.next, dirty: true },
    cfg' = cfg, now' = now, srv' = srv, rly' = rly, disk' = disk, host' = host, hist' = hist
  }

  // The next event on the push stream after the watch's cursor (anything missing before it is a gap).
  action Push = {
    val c = mem.cursor
    val later = Events.filter(e => e > c and e <= srv.emitted and srv.retained.contains(e))
    val e = later.fold(N + 1, (a, b) => if (a < b) a else b)
    val gap = Events.filter(x => x > c and x < e and not(stored.contains(x)))
    all {
      running, cfg.mode == "push", mem.step.kind == "", later != Set(),
      mem' = { ...mem, step: { ...Idle, kind: "push", stage: 1, msg: { ...NoMsg, ev: e, cur: e } } },
      srv' = { ...srv, lost: srv.lost.union(gap) },
      cfg' = cfg, now' = now, rly' = rly, disk' = disk, host' = host, hist' = hist
    }
  }

  // A cursor taken in memory (a poll's, a subscribe answer's) is written down.
  action SaveSoon = all {
    running, mem.dirty,
    disk' = { ...disk, cursor: mem.cursor },
    mem' = { ...mem, dirty: false },
    cfg' = cfg, now' = now, srv' = srv, rly' = rly, host' = host, hist' = hist
  }

  // ---- handing events to the session ---------------------------------------------------------
  // The hooks module asks for what waits (/take). From 0.5.0 it first acknowledges what it last
  // submitted, which a helper that restarted in between never heard.
  action HandTake = {
    val s = host.session
    val p = if (cfg.fix) max(disk.pos.get(s), host.submitted) else disk.pos.get(s)
    all {
      running, mem.taken == -1, p < disk.spool.get(s).length(),
      disk' = { ...disk, pos: disk.pos.set(s, p) },
      mem' = { ...mem, taken: disk.spool.get(s).length(), subbed: false },
      cfg' = cfg, now' = now, srv' = srv, rly' = rly, host' = host, hist' = hist
    }
  }

  // $.prompt.submit: the session is shown the batch.
  action HandSubmit = {
    val s = host.session
    val p = disk.pos.get(s)
    all {
      running, mem.taken >= 0, not(mem.subbed),
      hist' = { ...hist, shown: hist.shown.concat(tailFrom(disk.spool.get(s), p).slice(0, mem.taken - p)) },
      host' = { ...host, submitted: mem.taken },
      mem' = { ...mem, subbed: true },
      cfg' = cfg, now' = now, srv' = srv, rly' = rly, disk' = disk
    }
  }

  // /ack: the position is saved.
  action HandAck = {
    val s = host.session
    all {
      running, mem.taken >= 0, mem.subbed,
      disk' = { ...disk, pos: disk.pos.set(s, max(disk.pos.get(s), mem.taken)) },
      mem' = { ...mem, taken: -1, subbed: false },
      cfg' = cfg, now' = now, srv' = srv, rly' = rly, host' = host, hist' = hist
    }
  }

  // ---- stopping and starting -----------------------------------------------------------------
  // The helper dies; Claude Code stays. Everything in the helper's memory is gone.
  action HelperCrash = all {
    host.helper,
    host' = { ...host, helper: false },
    mem' = loaded(disk, host.session),
    cfg' = cfg, now' = now, srv' = srv, rly' = rly, disk' = disk, hist' = hist
  }

  // The hooks module starts the helper again, in the same session.
  action HelperStart = all {
    host.cc, not(host.helper),
    host' = { ...host, helper: true },
    mem' = loaded(disk, host.session),
    cfg' = cfg, now' = now, srv' = srv, rly' = rly, disk' = disk, hist' = hist
  }

  // Claude Code is closed, or crashes: the helper and the hooks module go with it.
  action Close = {
    val s = host.session
    val p = disk.pos.get(s)
    // A batch submitted whose ack was not saved: nobody left knows it was shown.
    val unsaved = if (mem.taken >= 0 and mem.subbed) elems(tailFrom(disk.spool.get(s), p).slice(0, mem.taken - p))
                  else if (host.submitted > p) elems(tailFrom(disk.spool.get(s), p).slice(0, host.submitted - p))
                  else Set()
    all {
      host.cc,
      host' = { cc: false, helper: false, session: s, submitted: 0 },
      mem' = loaded(disk, s),
      hist' = { ...hist, cut: hist.cut.union(unsaved) },
      cfg' = cfg, now' = now, srv' = srv, rly' = rly, disk' = disk
    }
  }

  // Claude Code is opened again in the project: a new session, whose helper claims the watches.
  // From 0.5.0 the session is first listed for the project.
  action Open = {
    val s = host.session + 1
    val d = { ...disk, listed: if (cfg.fix) disk.listed.union(Set(s)) else disk.listed }
    all {
      not(host.cc), s <= MAX_SESSIONS,
      host' = { cc: true, helper: true, session: s, submitted: 0 },
      disk' = d,
      mem' = loaded(d, s),
      cfg' = cfg, now' = now, srv' = srv, rly' = rly, hist' = hist
    }
  }

  // 0.5.0: one write appends, to this session's spool, what listed earlier sessions hold past
  // their hand-over position that was handed over in none of them and is not here already.
  def handed(d: Disk): Set[int] = d.listed.fold(Set(), (acc, t) => acc.union(elems(d.spool.get(t).slice(0, d.pos.get(t)))))
  def waiting(d: Disk, s: int): Set[int] = d.listed.exclude(Set(s)).fold(Set(), (acc, t) => acc.union(elems(tailFrom(d.spool.get(t), d.pos.get(t)))))
  action Carry = {
    val s = host.session
    val carry = waiting(disk, s).exclude(handed(disk)).exclude(elems(disk.spool.get(s)))
    all {
      cfg.fix, running, mem.step.kind == "", carry != Set(),
      disk' = { ...disk, spool: disk.spool.set(s, disk.spool.get(s).concat(inOrder(carry))) },
      mem' = { ...mem, seen: mem.seen.union(carry) },
      cfg' = cfg, now' = now, srv' = srv, rly' = rly, host' = host, hist' = hist
    }
  }

  // 0.5.0: then an earlier session whose waiting events are all here (or were handed over) is
  // marked as handed over and taken off the list.
  action Settle = {
    nondet t = disk.listed.exclude(Set(host.session)).oneOf()
    SettleOf(t)
  }
  action SettleOf(t: int): bool = {
    val s = host.session
    all {
      cfg.fix, running, mem.step.kind == "", t != s, disk.listed.contains(t),
      elems(tailFrom(disk.spool.get(t), disk.pos.get(t))).subseteq(elems(disk.spool.get(s)).union(handed(disk))),
      disk' = { ...disk, pos: disk.pos.set(t, disk.spool.get(t).length()), listed: disk.listed.exclude(Set(t)) },
      cfg' = cfg, now' = now, srv' = srv, rly' = rly, host' = host, mem' = mem, hist' = hist
    }
  }

  action step = any {
    Tick, Emit, Expire, Post, Abandon, Lapse,
    RelayDrop, Forge, Replay,
    Take, Append, SaveWatch, Commit, StoreFails, FlushAcks, Reconnect, Subscribe,
    Poll, PollDone, Push, SaveSoon,
    HandTake, HandSubmit, HandAck,
    HelperCrash, HelperStart, Close, Open, Carry, Settle
  }

  // ---- invariants ----------------------------------------------------------------------------
  // 1. The session is shown each event at most once, across helper restarts and sessions...
  val StrictAtMostOnce: bool = Events.forall(e => count(hist.shown, e) <= 1)
  // ...except an event in a batch that was submitted to a session which Claude Code then closed
  // before the batch's ack was saved: the next session is shown it again (at least once, not at
  // most once). The submit happens in Claude Code and the ack is saved by the helper; nothing
  // makes the two one step.
  val AtMostOnce: bool = Events.forall(e => count(hist.shown, e) <= 1 or hist.cut.contains(e))

  // 2. Nothing forged is stored, so nothing forged is shown.
  val NothingForged: bool = sessions.forall(s => not(elems(disk.spool.get(s)).contains(FORGED)))

  // 3. With an honest relay: a genuine delivery is acknowledged to the relay (and so deleted there)
  //    only once its event is on disk, or its loss is one the extension allows.
  val NoAckBeforeStore: bool =
    cfg.evil or hist.acked.forall(d => not(d.genuine) or stored.contains(d.ev) or srv.lost.contains(d.ev))

  // 4. No event is stranded: one stored in an earlier session's spool and never handed over is
  //    still on its way to a session (that session is listed, or the event is in the current spool).
  val NoneStranded: bool =
    sessions.forall(t => t == host.session or elems(tailFrom(disk.spool.get(t), disk.pos.get(t))).forall(e =>
      elems(hist.shown).contains(e) or disk.listed.contains(t) or elems(disk.spool.get(host.session)).contains(e)))

  // 5. With an honest relay: the saved cursor never passes an event that is neither stored, nor
  //    still at the relay, nor lost for a reason the extension allows. Resuming from it skips nothing else.
  val CursorSafe: bool =
    cfg.evil or 1.to(disk.cursor).forall(e => stored.contains(e) or inRelay.contains(e) or srv.lost.contains(e))

  val Safety: bool = AtMostOnce and NothingForged and NoAckBeforeStore and NoneStranded and CursorSafe

  // ---- the counterexamples, as scenarios (`quint test delivery.qnt`) -------------------------
  // Each found 0.4.1's client breaking an invariant; each is run again against 0.5.0's.

  // A helper restart between showing a batch and saving that it was shown: shown again.
  run handOverTwiceBeforeTest = pollBefore.then(Emit).then(Poll).then(Append).then(SaveWatch).then(PollDone)
    .then(HandTake).then(HandSubmit).then(HelperCrash).then(HelperStart).then(HandTake).then(HandSubmit)
    .expect(not(AtMostOnce))
  run handOverTwiceAfterTest = poll.then(Emit).then(Poll).then(Append).then(SaveWatch).then(PollDone)
    .then(HandTake).then(HandSubmit).then(HelperCrash).then(HelperStart)
    // the poll's cursor was not saved yet, so event 1 comes again with event 2, and is passed over
    .then(Emit).then(Poll).then(Append).then(SaveWatch).then(Append).then(SaveWatch).then(PollDone).then(HandTake).then(HandSubmit)
    .expect(AtMostOnce and hist.shown == [1, 2])

  // A helper restart between writing an event to the spool and saving the watch: written again.
  run storedTwiceBeforeTest = pushBefore.then(Emit).then(Push).then(Append).then(HelperCrash).then(HelperStart)
    .then(Push).then(Append).then(SaveWatch).then(HandTake).then(HandSubmit)
    .expect(not(AtMostOnce))
  run storedTwiceAfterTest = push.then(Emit).then(Push).then(Append).then(HelperCrash).then(HelperStart)
    .then(Push).then(Append).then(SaveWatch).then(HandTake).then(HandSubmit)
    .expect(AtMostOnce and hist.shown == [1])

  // Claude Code closed after an event was stored and before it was handed over: the next session
  // never shows it.
  run strandedBeforeTest = pollBefore.then(Emit).then(Poll).then(Append).then(SaveWatch).then(PollDone).then(SaveSoon)
    .then(Close).then(Open)
    .expect(not(NoneStranded))
  run strandedAfterTest = poll.then(Emit).then(Poll).then(Append).then(SaveWatch).then(PollDone).then(SaveSoon)
    .then(Close).then(Open).then(Carry).then(Settle).then(HandTake).then(HandSubmit)
    .expect(NoneStranded and hist.shown == [1])

  // A delivery that could not be stored is left at the relay; a later one, signed more than ten
  // minutes after it, is taken; on the next connection the first is refused as a replay and
  // acknowledged, so the relay deletes it, and the saved cursor has passed it (B1).
  run refusedAsOldBeforeTest = webhookBefore.then(Emit).then(PostOf(1, true)).then(Take).then(StoreFails)
    .then(Tick).then(Tick).then(Tick).then(Emit).then(PostOf(2, true))
    .then(Take).then(Append).then(SaveWatch).then(Commit).then(FlushAcks)
    .then(Reconnect).then(Take).then(FlushAcks)
    .expect(not(NoAckBeforeStore) and not(CursorSafe))
  run refusedAsOldAfterTest = webhook.then(Emit).then(PostOf(1, true)).then(Take).then(StoreFails)
    .then(Tick).then(Tick).then(Tick).then(Emit).then(PostOf(2, true))
    .then(Take).then(Append).then(SaveWatch).then(Commit).then(FlushAcks)
    .then(Reconnect).then(Take).then(Append).then(SaveWatch).then(Commit).then(FlushAcks)
    .then(HandTake).then(HandSubmit)
    .expect(NoAckBeforeStore and CursorSafe and AtMostOnce and hist.shown == [2, 1])

  // A replay of a delivery already taken, by someone on the wire, or by a relay that lies about
  // when it arrived, after the replay memory could have forgotten it: refused, not shown again.
  run replayRefusedTest = webhookEvilRelay.then(Emit).then(PostOf(1, true)).then(Take).then(Append).then(SaveWatch).then(Commit).then(FlushAcks)
    .then(Tick).then(Tick).then(Tick).then(Tick).then(Replay).then(Take).then(FlushAcks).then(HandTake).then(HandSubmit)
    .expect(AtMostOnce and NothingForged and hist.shown == [1])

  // Forged deliveries are dropped and acknowledged; nothing of theirs is stored.
  run forgedDroppedTest = webhook.then(Forge).then(Forge).then(Take).then(Take).then(FlushAcks)
    .expect(NothingForged and rly.mailbox == Set())

  // Found by TLC in 0.5.0 (model/README.md). The event is written to the first session's spool
  // and shown, and the watch is not saved after it. The next session's helper counts it as seen
  // (loaded), in memory only; Settle takes the first session off the list; the helper restarts,
  // and neither the list nor the saved watch has the event: it is stored and shown again.
  run seenForgottenTest = poll.then(Emit).then(Poll).then(Append).then(HandTake).then(HandSubmit).then(HandAck)
    .then(Close).then(Open).then(Settle).then(HelperCrash).then(HelperStart)
    .then(Poll).then(Append).then(HandTake).then(HandSubmit)
    .expect(not(AtMostOnce) and hist.shown == [1, 1] and hist.cut == Set())
  // Found by TLC in 0.5.0, with three sessions (model/README.md). The second session carries the
  // event the first stored and never showed, and shows it; Claude Code closes before the first
  // session is settled. The third session settles the second first, which takes the record that
  // the event was handed over off the list, and then carries the event from the first again.
  run carriedTwiceTest = poll.then(Emit).then(Poll).then(Append).then(Close).then(Open).then(Carry)
    .then(HandTake).then(HandSubmit).then(HandAck).then(Close).then(Open).then(SettleOf(2)).then(Carry)
    .then(HandTake).then(HandSubmit)
    .expect(not(AtMostOnce) and hist.shown == [1, 1] and hist.cut == Set())
  // The same through the relay, which hands the delivery over again because it was never acknowledged.
  run seenForgottenWebhookTest = webhook.then(Emit).then(PostOf(1, true)).then(Take).then(Append)
    .then(HandTake).then(HandSubmit).then(HandAck)
    .then(Close).then(Open).then(Settle).then(HelperCrash).then(HelperStart)
    .then(Take).then(Append).then(HandTake).then(HandSubmit)
    .expect(not(AtMostOnce) and hist.shown == [1, 1] and hist.cut == Set())
}
