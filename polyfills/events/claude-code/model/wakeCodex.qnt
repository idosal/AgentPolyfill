// A model of how often events wake a Codex session, in mcp-events for Codex
// (polyfills/events/codex): the wake budget (core/src/wake.ts, kept in wakes.json, with the pause
// that also lifts by itself), the hand-over through `codex queue` (src/threads.ts #handOver,
// src/waker.ts), which calls count as the person's (src/meta.ts isThePersons), and a session
// `codex queue` cannot reach (`unwakeable`). The helper may die between any two steps, events
// arrive at any time, and tool calls come from the person's turns and from turns that are not the
// person's (the wake's own among them). One session, one watch.
// `init` is 0.1.2; `initBefore` is 0.1.2 with CX1's fix taken out (0.1.0's rule, which counts a
// call with no turn metadata as the person's, and 0.1.0's pause, which never lifts by itself);
// `initShortLift` lifts the pause after less than an hour. model/README.md says what was checked.
module wakeCodex {
  pure val MAX_TIME = 10  // the clock's bound; one unit stands for fifteen minutes
  pure val HOUR = 4       // an hour, in those units
  pure val GAP = 1        // MCP_EVENTS_WAKE_GAP_S: how soon one watch may start another wake
  pure val PER_HOUR = 2   // MCP_EVENTS_WAKES_PER_HOUR
  pure val PENDING = 2    // the model's bound: events stored and not yet handed over, at most

  // What Codex says started the turn a call is made in (`x-codex-turn-metadata.turn_trigger`, as
  // Codex 0.172 sends it); "none" is a call with no turn metadata (a Codex before 0.172). The
  // person's own turns carry one of the first four, or nothing on an older Codex. Other turns carry
  // "queue" (a wake, this plugin's among them), a trigger neither list knows ("hook"), or nothing.
  pure val PERSONS_TRIGGERS = Set("user", "exec", "realtime", "voice", "none")
  pure val OTHER_TRIGGERS = Set("queue", "hook", "none")

  // wakes.json: when the session was woken within the hour, when the watch last started a wake,
  // whether waking is paused, since when (-1: unset), and whether the notice was handed to
  // `codex queue` and not yet heard back about.
  type Budget = { wakes: List[int], last: int, paused: bool, pausedAt: int, noticeHanded: bool }
  type State = {
    allow: bool,        // 0.1.1 on: the allowlist; false: 0.1.0's denylist
    lift: int,          // liftAfterMs, in units; 0: the pause lasts until the person speaks (0.1.0)
    local: bool,        // `codex queue` can reach the session (false: a ChatGPT desktop-app chat)
    now: int,
    stored: int,        // events in the session's spool
    pos: int,           // how many of them were handed over (delivered.pos, on disk)
    budget: Budget,     // on disk
    helper: bool,       // the helper runs
    unwakeable: bool,   // the helper's memory: `codex queue` answered "no rollout found"
    queued: str,        // the helper's memory: "" nothing, "batch" or "notice", run through `codex queue` and not heard back about
    upto: int,          // the batch's end, in events
    answered: bool,     // `codex queue` took the message (the session is woken); the helper has not heard so yet
    spoke: int,         // history: how many wakes there had been when the person's own call last started the hour again
    shown: List[int],   // history: when a batch woke the session
    carried: int,       // history: the most events a wake carried (a batch carries every event up to its end)
    noticeAt: int,      // history: when the session was last told that waking stopped, since the person's call (-100: not)
    quiet: int,         // history: no wake may come before this, since the person's call: the lift after the last notice or pause
    early: bool,        // history: a wake came before `quiet`
    twice: bool,        // history: the session was told twice within one pause
    byOther: bool,      // history: a call from a turn that was not the person's started the hour again
    refused: bool,      // history: `codex queue` answered "no rollout found" for this session
    retried: bool       // history: `codex queue` was run for the session after that answer
  }
  var s: State

  pure def maxOf(a: int, b: int): int = if (a > b) a else b
  pure def recent(l: List[int], t: int): List[int] = l.select(x => t - x < HOUR)
  // src/meta.ts. 0.1.1 on: only the triggers on the allowlist. 0.1.0: anything but a trigger on its
  // denylist ("queue" among them), and a call with no turn metadata at all.
  pure def isThePersons(allow: bool, trigger: str): bool =
    if (allow) Set("user", "exec", "realtime", "voice").contains(trigger) else trigger != "queue"
  // Until when a pause (or notice) at t keeps the session from being woken, if nobody speaks.
  pure def quietFrom(lift: int, t: int): int = if (lift > 0) t + lift else 1000
  // WakeBudget.pause: waking stops; where the pause lifts by itself, it counts from now.
  pure def pause(b: Budget, lift: int, t: int): Budget = { ...b, paused: true, noticeHanded: false, pausedAt: if (lift > 0) t else b.pausedAt }

  action initAt(allow: bool, lift: int, local: bool): bool = s' = {
    allow: allow, lift: lift, local: local, now: 0, stored: 0, pos: 0,
    budget: { wakes: List(), last: -100, paused: false, pausedAt: -1, noticeHanded: false },
    helper: true, unwakeable: false, queued: "", upto: 0, answered: false,
    spoke: 0, shown: List(), carried: 0, noticeAt: -100, quiet: -100,
    early: false, twice: false, byOther: false, refused: false, retried: false
  }
  action initWith(allow: bool, lift: int): bool = {
    nondet local = Set(true, false).oneOf()
    initAt(allow, lift, local)
  }
  action init = initWith(true, HOUR)       // 0.1.2: the allowlist, and the pause lifts after an hour (threads.ts)
  action initBefore = initWith(false, 0)   // CX1's fix taken out: 0.1.0's denylist, and no lift
  action initShortLift = initWith(true, 1) // a variant: the pause lifts after a quarter of an hour

  action Tick = all { s.now < MAX_TIME, s' = { ...s, now: s.now + 1 } }

  // The watch stores an event, whatever the wake budget says and whether or not the session can be woken.
  action Arrive = all { s.helper, s.stored - s.pos < PENDING, s' = { ...s, stored: s.stored + 1 } }

  // WakeBudget.gate on a paused budget, once the pause's time has passed (the gate is asked on each
  // stored event and before each hand-over): the hour starts again, as when the person speaks.
  action Lift = all {
    s.helper, s.budget.paused, s.lift > 0, s.now >= s.budget.pausedAt + s.lift,
    s' = { ...s, budget: { ...s.budget, paused: false, pausedAt: -1, wakes: List() } }
  }

  // #handOver: the next batch, through the gate. Past the hour's wakes the notice is handed over
  // (noticeHanded, on disk, first), else the batch; either way `codex queue` is run. Not for a
  // session the helper knows it cannot reach.
  val takes: bool = s.helper and s.queued == "" and not(s.unwakeable) and s.stored > s.pos
    and not(s.budget.paused) and s.now - s.budget.last >= GAP
  action Take = {
    val notice = recent(s.budget.wakes, s.now).length() >= PER_HOUR
    all {
      takes,
      s' = { ...s, queued: if (notice) "notice" else "batch", upto: s.stored, answered: false,
             budget: if (notice) { ...s.budget, noticeHanded: true } else s.budget,
             retried: s.retried or s.refused }
    }
  }

  // `codex queue` takes the message: a turn starts (the session is woken), whether or not the
  // helper lives to hear so.
  action QueueOk = all {
    s.helper, s.queued != "", not(s.answered), s.local,
    s' = if (s.queued == "batch")
           { ...s, answered: true, shown: s.shown.append(s.now), carried: maxOf(s.carried, s.upto),
             early: s.early or s.now < s.quiet }
         else
           { ...s, answered: true,
             twice: s.twice or (s.noticeAt >= 0 and (s.lift == 0 or s.now - s.noticeAt < s.lift)),
             noticeAt: s.now, quiet: maxOf(s.quiet, quietFrom(s.lift, s.now)) }
  }
  // It fails, and the helper hears so: it tries again later. The notice stays handed over.
  action QueueFails = all { s.helper, s.queued != "", not(s.answered), s.local, s' = { ...s, queued: "" } }
  // "no rollout found": no try can reach this session, and the helper stops trying (in memory).
  action QueueRefused = all {
    s.helper, s.queued != "", not(s.answered), not(s.local),
    s' = { ...s, queued: "", unwakeable: true, refused: true }
  }

  // The helper hears that `codex queue` took it: a batch counts as a wake (WakeBudget.woke) and is
  // marked handed over (Delivery.ack); the notice pauses waking.
  action Heard = all {
    s.helper, s.answered,
    s' = if (s.queued == "batch")
           { ...s, queued: "", answered: false, pos: s.upto,
             budget: { ...s.budget, wakes: recent(s.budget.wakes, s.now).append(s.now), last: s.now, noticeHanded: false } }
         else
           { ...s, queued: "", answered: false, budget: pause(s.budget, s.lift, s.now),
             quiet: maxOf(s.quiet, quietFrom(s.lift, s.now)) }
  }

  action HelperDies = all { s.helper, s' = { ...s, helper: false, queued: "", answered: false, unwakeable: false } }
  // A new helper reads the budget and the position from disk. A notice handed to `codex queue` by
  // a helper that stopped before it heard back counts as given (the ThreadSession constructor).
  action HelperStarts = all {
    not(s.helper),
    s' = if (s.budget.noticeHanded)
           { ...s, helper: true, budget: pause(s.budget, s.lift, s.now), quiet: maxOf(s.quiet, quietFrom(s.lift, s.now)) }
         else { ...s, helper: true }
  }

  // A tools/call to the plugin in a turn the person started (`person`) or not, with what Codex says
  // started it. If isThePersons, WakeBudget.spoke: the pause ends and the hour starts again.
  action CallIn(person: bool, trigger: str): bool = {
    val theirs = isThePersons(s.allow, trigger)
    val reset = theirs and (s.budget.paused or s.budget.wakes.length() > 0)
    all {
      s.helper,
      s' = { ...s,
             budget: if (reset) { ...s.budget, paused: false, pausedAt: -1, wakes: List() } else s.budget,
             spoke: if (person and theirs) s.shown.length() else s.spoke,
             noticeAt: if (person and theirs) -100 else s.noticeAt,
             quiet: if (person and theirs) -100 else s.quiet,
             byOther: s.byOther or (not(person) and reset) }
    }
  }
  action PersonCall = { nondet t = PERSONS_TRIGGERS.oneOf() CallIn(true, t) }
  action OtherCall = { nondet t = OTHER_TRIGGERS.oneOf() CallIn(false, t) }

  action step = any { Tick, Arrive, Lift, Take, QueueOk, QueueFails, QueueRefused, Heard, HelperDies, HelperStarts, PersonCall, OtherCall }

  // 1. Between two calls of the person's own turns, no hour holds more than PER_HOUR wakes, across
  //    the pause lifting by itself.
  pure def window(l: List[int], i: int, from: int): int = l.indices().filter(j => j >= from and j <= i and l[i] - l[j] < HOUR).size()
  val WithinHour: bool = s.shown.indices().forall(i => i < s.spoke or window(s.shown, i, s.spoke) <= PER_HOUR)
  // 2. Two wakes are at least GAP apart (one watch).
  val Gap: bool = s.shown.indices().forall(i => i == 0 or s.shown[i] - s.shown[i - 1] >= GAP)
  // 3. Only a call from the person's own turn starts the hour again or ends the pause: a woken
  //    turn's never does, nor any other turn's.
  val OnlyThePerson: bool = not(s.byOther)
  // 4. Once the session is told that waking stopped (or waking pauses), no wake comes until the
  //    person's own call, or until the pause's time has passed.
  val QuietAfterNotice: bool = not(s.early)
  // 5. The session is told at most once in a pause that waking stopped.
  val OneNotice: bool = not(s.twice)
  // 6. A helper that heard "no rollout found" runs no `codex queue` for that session again, and a
  //    session `codex queue` cannot reach is never woken.
  val NoWakeUnwakeable: bool = not(s.unwakeable and s.queued != "") and (s.local or s.shown.length() == 0)
  // 7. Nothing is lost: what is not handed over stays stored, and the hand-over never passes an
  //    event that no wake carried.
  val NothingLost: bool = s.pos <= s.carried and s.pos <= s.stored
  // A documented limit: `unwakeable` is kept in memory, so a new helper runs `codex queue` once more.
  val NeverRetried: bool = not(s.retried)
  val Kept: bool = WithinHour and Gap and OnlyThePerson and QuietAfterNotice and OneNotice and NoWakeUnwakeable and NothingLost

  // ---- scenarios (`quint test wakeCodex.qnt`) ------------------------------------------------
  run wakeNow = Arrive.then(Take).then(QueueOk).then(Heard)
  // Two wakes, at 0 and at 1; at 2 the notice, and waking pauses.
  run spent = initAt(true, HOUR, true).then(wakeNow).then(Tick).then(wakeNow).then(Tick)
    .then(Arrive).then(Take).then(QueueOk).then(Heard)

  // The pause lifts by itself an hour after it began, and the hour starts again.
  run liftTest = spent.expect(s.budget.paused and s.noticeAt == 2 and s.pos == 2)
    .then(Tick).then(Tick).then(Tick).expect(not(takes))
    .then(Tick).then(Lift).then(Take).then(QueueOk).then(Heard)
    .expect(Kept and s.shown == [0, 1, 6] and s.budget.wakes == [6] and s.pos == 3)
  // A woken turn's call (trigger "queue"), a hook's, and one with no turn metadata end nothing.
  run wokenTurnTest = spent.then(CallIn(false, "queue")).then(CallIn(false, "hook")).then(CallIn(false, "none"))
    .then(CallIn(true, "none"))
    .expect(Kept and s.budget.paused and s.spoke == 0)
  // The person's own turn ends the pause: what waited is handed over.
  run personTest = spent.then(CallIn(true, "user")).then(Take).then(QueueOk).then(Heard)
    .expect(Kept and not(s.budget.paused) and s.shown == [0, 1, 2] and s.spoke == 2)
  // CX1's fix taken out: a woken turn's call with no turn metadata counts as the person's, ends
  // the pause, and the next wake comes at once, a third in the hour.
  run deniedBeforeTest = initAt(false, 0, true).then(wakeNow).then(Tick).then(wakeNow).then(Tick)
    .then(Arrive).then(Take).then(QueueOk).then(Heard).then(CallIn(false, "none"))
    .expect(not(OnlyThePerson) and not(s.budget.paused))
    .then(Take).then(QueueOk)
    .expect(not(WithinHour) and not(QuietAfterNotice) and s.shown == [0, 1, 2])
  // A pause that lifts sooner than the hour: two wakes, the notice, and a third wake within the hour.
  run shortLiftTest = initAt(true, 1, true).then(wakeNow).then(Tick).then(wakeNow).then(Tick)
    .then(Arrive).then(Take).then(QueueOk).then(Heard).then(Tick).then(Lift).then(Take).then(QueueOk)
    .expect(not(WithinHour) and QuietAfterNotice and s.shown == [0, 1, 3])
  // The notice is handed to `codex queue` and the helper dies before it hears back: the next one
  // starts paused (noticeHanded), and does not tell the session again.
  run noticeUnheardTest = initAt(true, HOUR, true).then(wakeNow).then(Tick).then(wakeNow).then(Tick)
    .then(Arrive).then(Take).then(QueueOk).then(HelperDies).then(HelperStarts).expect(not(takes))
    .expect(Kept and s.budget.paused and s.budget.pausedAt == 2 and not(s.budget.noticeHanded))
  // A session `codex queue` cannot reach: tried once, then not again; its events go on being stored.
  run unwakeableTest = initAt(true, HOUR, false).then(Arrive).then(Take).then(QueueRefused).then(Arrive)
    .then(Tick).expect(not(takes))
    .expect(Kept and NeverRetried and s.unwakeable and s.stored == 2 and s.pos == 0 and s.shown == [])
  // `unwakeable` is in memory only: a new helper runs `codex queue` for it once more (and is refused again).
  run retriedTest = initAt(true, HOUR, false).then(Arrive).then(Take).then(QueueRefused)
    .then(HelperDies).then(HelperStarts).then(Take).then(QueueRefused)
    .expect(Kept and not(NeverRetried) and s.shown == [])
  // The notice's `codex queue` fails, the person speaks, and the helper restarts before the next
  // wake: `spoke` leaves noticeHanded set, so the new helper starts paused, with no notice given.
  // No invariant is broken (the pause lifts after its hour); the person's message is passed over.
  run noticeFailedTest = initAt(true, HOUR, true).then(wakeNow).then(Tick).then(wakeNow).then(Tick)
    .then(Arrive).then(Take).then(QueueFails).then(CallIn(true, "user")).then(HelperDies).then(HelperStarts)
    .expect(Kept and s.budget.paused and s.spoke == 2 and s.noticeAt < 0 and not(takes))

  // Found by TLC (WakeCodexGap.cfg, WakeCodexHour.cfg; model/README.md): `codex queue` takes a
  // batch and the session is woken; the helper dies before it hears so, so the wake is neither
  // counted nor the batch marked handed over; the next helper hands the same batch over again, and
  // neither the gap nor the hour knows of the first.
  run unheardTwiceTest = initAt(true, HOUR, true).then(Arrive).then(Take).then(QueueOk)
    .then(HelperDies).then(HelperStarts).then(Take).then(QueueOk)
    .expect(not(Gap) and s.shown == [0, 0] and s.budget.wakes == [])
  run unheardHourTest = initAt(true, HOUR, true).then(Arrive).then(Take).then(QueueOk)
    .then(HelperDies).then(HelperStarts).then(Take).then(QueueOk).then(Heard)
    .then(Tick).then(wakeNow)
    .expect(not(WithinHour) and s.shown == [0, 0, 1] and s.budget.wakes == [0, 1])
}
