// A model of the relay's mailboxes in mcp-events, and of how one MCP server's posts can crowd out
// another's: two servers each have a webhook address (a watch's hook) in a mailbox that holds at
// most CAP deliveries; server "a" is hostile and posts well-formed junk to its own address, which
// the relay stores (it holds no secret, so it cannot tell); server "b" posts genuine deliveries.
// While Claude Code is closed nothing collects.
//
// Until 0.6.0 a project's watches shared one mailbox ("p"). From 0.7.0 each server has its own
// ("a", "b"), and a watch whose address is still in the project's mailbox moves to its server's own
// when it next runs: what the old mailbox holds for it is collected first, then the watch subscribes
// at its new address and the old one is retired (WatchManager.#migrate in src/watcher.ts).
// model/README.md says what each part stands for in the code, and what checking showed.
module relay {
  pure val CAP = 2          // deliveries one mailbox holds (MAX_QUEUED)
  pure val MAX_EV = 3       // genuine deliveries server "b" makes
  pure val SERVERS = Set("a", "b")

  // A stored delivery: whose address it was posted to, and, if genuine, which event it carries.
  type Delivery = { to: str, genuine: bool, ev: int }
  // perServer: 0.7.0 (each server's own mailbox); drain: the move collects the old mailbox first
  // (off only in a variant that leaves the drain out, to show that the check sees its absence).
  type Cfg = { perServer: bool, drain: bool }

  var cfg: Cfg
  var open: bool                     // Claude Code is open, and the mod collects
  var home: str -> str               // the mailbox each server's address is in
  var box: str -> List[Delivery]     // what each mailbox holds, in the order it was stored
  var made: int                      // genuine deliveries "b" has made so far
  var shown: List[int]               // history: the genuine events collected, in order
  var accepted: Set[int]             // history: the genuine events a mailbox took
  var crossRefused: bool             // history: a genuine delivery was refused for room another server's posts take
  var crossRefusedOwn: bool          // history: the same, at an address in its server's own mailbox

  pure val MAILBOXES = Set("p", "a", "b")
  pure val NONE: Delivery = { to: "", genuine: false, ev: 0 }
  pure def first(l: List[Delivery]): Delivery = if (l.length() > 0) l[0] else NONE
  pure def occupant(l: List[Delivery], s: str): bool = l.foldl(false, (acc, d) => acc or d.to != s)

  action initWith(perServer: bool, drain: bool, start: str): bool = all {
    cfg' = { perServer: perServer, drain: drain },
    open' = true,
    // "p": an existing user's watches, at the project's one mailbox; otherwise each server's own.
    home' = SERVERS.mapBy(s => if (start == "p") "p" else s),
    box' = MAILBOXES.mapBy(_ => List()),
    made' = 0, shown' = List(), accepted' = Set(), crossRefused' = false, crossRefusedOwn' = false
  }
  action init = initWith(true, true, "own")             // 0.7.0, watches made with it
  action migrating = initWith(true, true, "p")          // 0.7.0, an existing user's watches
  action initBefore = initWith(false, true, "p")        // 0.6.0
  action migratingNoDrain = initWith(true, false, "p")  // 0.7.0 with the drain taken out (a variant)

  // Server "a" posts well-formed junk to its own address. A full mailbox refuses it (503).
  action Junk = {
    val m = home.get("a")
    all {
      box.get(m).length() < CAP,
      box' = box.set(m, box.get(m).append({ to: "a", genuine: false, ev: 0 })),
      cfg' = cfg, open' = open, home' = home, made' = made, shown' = shown, accepted' = accepted,
      crossRefused' = crossRefused, crossRefusedOwn' = crossRefusedOwn
    }
  }

  // Server "b" posts a genuine delivery to its address. A full mailbox refuses it (503); the
  // server may try again later, which the model leaves out.
  action Genuine = {
    val m = home.get("b")
    val e = made + 1
    val room = box.get(m).length() < CAP
    val crowded = not(room) and occupant(box.get(m), "b")
    all {
      made < MAX_EV,
      made' = e,
      box' = if (room) box.set(m, box.get(m).append({ to: "b", genuine: true, ev: e })) else box,
      accepted' = if (room) accepted.union(Set(e)) else accepted,
      crossRefused' = (crossRefused or crowded),
      crossRefusedOwn' = (crossRefusedOwn or (crowded and m != "p")),
      cfg' = cfg, open' = open, home' = home, shown' = shown
    }
  }

  // While Claude Code is open the mod collects: the oldest delivery of a mailbox is handed over,
  // judged (junk fails its signature and is dropped) and acknowledged, so the relay deletes it.
  action Collect = {
    nondet m = MAILBOXES.oneOf()
    CollectAt(m)
  }
  action CollectAt(m: str): bool = {
    val d = first(box.get(m))
    all {
      open, box.get(m).length() > 0,
      box' = box.set(m, box.get(m).slice(1, box.get(m).length())),
      shown' = if (d.genuine) shown.append(d.ev) else shown,
      cfg' = cfg, open' = open, home' = home, made' = made, accepted' = accepted,
      crossRefused' = crossRefused, crossRefusedOwn' = crossRefusedOwn
    }
  }

  action Close = all {
    open, open' = false,
    cfg' = cfg, home' = home, box' = box, made' = made, shown' = shown, accepted' = accepted,
    crossRefused' = crossRefused, crossRefusedOwn' = crossRefusedOwn
  }
  action Open = all {
    not(open), open' = true,
    cfg' = cfg, home' = home, box' = box, made' = made, shown' = shown, accepted' = accepted,
    crossRefused' = crossRefused, crossRefusedOwn' = crossRefusedOwn
  }

  // 0.7.0, a watch still at the project's mailbox: first what that mailbox holds for its address is
  // collected (the relay hands it over when the hook is asked for again).
  action Drain = {
    nondet s = SERVERS.oneOf()
    DrainOf(s)
  }
  action DrainOf(s: str): bool = {
    val p = box.get("p")
    val mine = p.select(d => d.to == s)
    all {
      cfg.perServer, cfg.drain, open, home.get(s) == "p", mine.length() > 0,
      box' = box.set("p", p.select(d => d.to != s)),
      shown' = shown.concat(mine.select(d => d.genuine).foldl(List(), (acc, d) => acc.append(d.ev))),
      cfg' = cfg, open' = open, home' = home, made' = made, accepted' = accepted,
      crossRefused' = crossRefused, crossRefusedOwn' = crossRefusedOwn
    }
  }

  // Then the watch subscribes at a new address in its server's own mailbox, and the old address is
  // retired: the relay deletes what it still holds there. The drain comes first, and while the mod
  // collects, what arrives at the old address before it is retired is handed over first; so in the
  // code nothing is left there to delete. The variant without the drain moves at once.
  action Move = {
    nondet s = SERVERS.oneOf()
    MoveOf(s)
  }
  action MoveOf(s: str): bool = {
    all {
      cfg.perServer, open, home.get(s) == "p",
      not(cfg.drain) or box.get("p").select(d => d.to == s).length() == 0,
      home' = home.set(s, s),
      box' = box.set("p", box.get("p").select(d => d.to != s)),
      cfg' = cfg, open' = open, made' = made, shown' = shown, accepted' = accepted,
      crossRefused' = crossRefused, crossRefusedOwn' = crossRefusedOwn
    }
  }

  action step = any { Junk, Genuine, Collect, Close, Open, Drain, Move }

  // ---- invariants ----------------------------------------------------------------------------
  def held: Set[int] = MAILBOXES.fold(Set(), (acc, m) => acc.union(box.get(m).select(d => d.genuine).foldl(Set(), (a2, d) => a2.union(Set(d.ev)))))
  // 1. A genuine delivery is never refused for room that another server's posts take up.
  val NoCrossRefusal: bool = not(crossRefused)
  // 1'. The same, for an address in its server's own mailbox (what 0.7.0 promises before a watch has moved).
  val NoCrossRefusalAtOwn: bool = not(crossRefusedOwn)
  // 2. A genuine delivery a mailbox took is collected, or still held: moving a watch loses none.
  val NothingLost: bool = accepted.forall(e => shown.indices().exists(i => shown[i] == e) or held.contains(e))
  // 3. Each genuine event is collected at most once.
  val CollectedOnce: bool = 1.to(MAX_EV).forall(e => shown.indices().filter(i => shown[i] == e).size() <= 1)

  // ---- scenarios (`quint test relay.qnt`) ------------------------------------------------------
  // 0.6.0: while Claude Code is closed, "a" fills the shared mailbox; "b"'s delivery is refused.
  run sharedRefusedBeforeTest = initBefore.then(Close).then(Junk).then(Junk).then(Genuine)
    .expect(not(NoCrossRefusal) and accepted == Set())
  // 0.7.0: the same posts; "b"'s mailbox is its own, and takes it.
  run ownTakenTest = init.then(Close).then(Junk).then(Junk).then(Genuine)
    .expect(NoCrossRefusal and accepted == Set(1))
  // 0.7.0, an existing user: a delivery held at the old mailbox is collected, then the watch moves.
  run movedTest = migrating.then(Close).then(Genuine).then(Open).then(DrainOf("b")).then(MoveOf("b"))
    .then(Close).then(Junk).then(Junk).then(Genuine).then(Open).then(CollectAt("b"))
    .expect(NothingLost and NoCrossRefusal and shown == [1, 2] and home.get("b") == "b")
  // The variant that moves without collecting first loses the held delivery.
  run movedNoDrainTest = migratingNoDrain.then(Close).then(Genuine).then(Open).then(MoveOf("b"))
    .expect(not(NothingLost))
}
