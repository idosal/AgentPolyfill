// A model of how often events wake a session: the helper's wake budget (src/wake.ts) and the
// hand-over it gates (/take, $.prompt.submit, /ack between the hooks module and the helper), with
// the helper dying between any two steps, events arriving at any time, and the person speaking.
// One watch. `init` is 0.5.0; `initBefore` is 0.4.1. model/README.md says what was checked.
module wake {
  pure val MAX_TIME = 9   // the clock's bound; one unit stands for twenty minutes
  pure val HOUR = 3       // an hour, in those units
  pure val GAP = 1        // MCP_EVENTS_WAKE_GAP_S: how soon one watch may start another wake
  pure val PER_HOUR = 2   // MCP_EVENTS_WAKES_PER_HOUR

  // What the helper keeps on disk (wakes.json): when the session was woken, when the watch last
  // started a wake, whether waking is paused until the person speaks.
  type Budget = { wakes: List[int], last: int, paused: bool }
  type State = {
    fix: bool,
    now: int,
    waiting: bool,      // the spool holds events not handed over
    budget: Budget,     // on disk
    helper: bool,       // the helper runs
    taken: str,         // the helper's memory: "" nothing, "batch", or "notice", taken and not acknowledged
    subbed: bool,       // the hooks module submitted what it took
    remembered: bool,   // 0.5.0: the hooks module remembers a submitted batch whose ack it has not seen through
    spoke: int,         // history: how many wakes there had been when the person last sent a message
    shown: List[int],   // history: when an event batch was submitted (a wake)
    notices: int        // history: notices that waking stopped, since the person last spoke
  }
  var s: State

  pure def inHour(l: List[int], t: int, since: int): int = l.foldl(0, (n, x) => if (t - x < HOUR and x >= since) n + 1 else n)

  action initWith(fix: bool): bool = s' = {
    fix: fix, now: 0, waiting: false, budget: { wakes: List(), last: -100, paused: false },
    helper: true, taken: "", subbed: false, remembered: false, spoke: 0, shown: List(), notices: 0
  }
  action init = initWith(true)
  action initBefore = initWith(false)

  action Tick = all { s.now < MAX_TIME, s' = { ...s, now: s.now + 1 } }
  action Arrive = all { not(s.waiting), s' = { ...s, waiting: true } }

  // /take: the budget's gate. A paused budget hands nothing over; a spent hour hands over the notice.
  action Take = all {
    s.helper, s.taken == "", s.waiting, not(s.budget.paused), not(s.remembered),
    s.now - s.budget.last >= GAP,
    s' = { ...s, taken: if (inHour(s.budget.wakes, s.now, -1) >= PER_HOUR) "notice" else "batch", subbed: false }
  }

  // $.prompt.submit: a turn starts (the session is woken).
  action Submit = all {
    s.helper, s.taken != "", not(s.subbed),
    s' = { ...s, subbed: true, remembered: s.fix and s.taken == "batch",
           shown: if (s.taken == "batch") s.shown.append(s.now) else s.shown,
           notices: if (s.taken == "notice") s.notices + 1 else s.notices }
  }

  // /ack: a batch counts as a wake, the notice pauses waking.
  action Ack = all {
    s.helper, s.taken != "", s.subbed,
    s' = { ...s, taken: "", subbed: false, remembered: false,
           waiting: if (s.taken == "batch") false else s.waiting,
           budget: if (s.taken == "batch") { ...s.budget, wakes: s.budget.wakes.append(s.now), last: s.now } else { ...s.budget, paused: true } }
  }

  // 0.5.0: a restarted helper is told of the batch the one before it handed over (the hooks module
  // acknowledges it before the next take), and counts it as a wake.
  action AckRemembered = all {
    s.fix, s.helper, s.taken == "", s.remembered,
    s' = { ...s, remembered: false, waiting: false, budget: { ...s.budget, wakes: s.budget.wakes.append(s.now), last: s.now } }
  }

  action HelperDies = all { s.helper, s' = { ...s, helper: false, taken: "", subbed: false } }
  action HelperStarts = all { not(s.helper), s' = { ...s, helper: true } }

  // The person sends a message of their own: the hour starts again.
  action Speak = all { s' = { ...s, spoke: s.shown.length(), notices: 0, budget: { ...s.budget, wakes: List(), paused: false } } }

  action step = any { Tick, Arrive, Take, Submit, Ack, AckRemembered, HelperDies, HelperStarts, Speak }

  // 1. Between two messages of the person, no hour holds more than PER_HOUR wakes.
  pure def window(l: List[int], i: int, from: int): int = l.indices().filter(j => j >= from and j <= i and l[i] - l[j] < HOUR).size()
  val WithinHour: bool = s.shown.indices().forall(i => i < s.spoke or window(s.shown, i, s.spoke) <= PER_HOUR)
  // 2. Two wakes are at least GAP apart (one watch).
  val Gap: bool = s.shown.indices().forall(i => i == 0 or s.shown[i] - s.shown[i - 1] >= GAP)
  // 3. The session is told at most once that waking stopped, until the person speaks.
  val OneNotice: bool = s.notices <= 1
  val Kept: bool = WithinHour and Gap and OneNotice

  // 0.4.1: the helper dies after the submit, before the ack; the next one hands the same batch
  // over again, and neither the gap nor the hour knows of the first.
  run twiceBeforeTest = initBefore.then(Arrive).then(Take).then(Submit).then(HelperDies).then(HelperStarts).then(Take).then(Submit)
    .expect(not(Gap))
  run onceAfterTest = init.then(Arrive).then(Take).then(Submit).then(HelperDies).then(HelperStarts).then(AckRemembered)
    .then(Arrive).expect(Kept and s.shown == [0] and s.budget.wakes == [0])

  // Found by TLC in 0.5.0 (model/README.md): the helper dies after the notice that waking stopped
  // was submitted, before its ack. Only a batch is remembered across the restart, so the next
  // helper does not know the notice was given, and hands it over again.
  run noticeTwiceTest = init.then(Arrive).then(Take).then(Submit).then(Ack).then(Tick)
    .then(Arrive).then(Take).then(Submit).then(Ack).then(Tick)
    .then(Arrive).then(Take).then(Submit).then(HelperDies).then(HelperStarts).then(Take).then(Submit)
    .expect(not(OneNotice) and s.notices == 2 and s.shown == [0, 1])
}
