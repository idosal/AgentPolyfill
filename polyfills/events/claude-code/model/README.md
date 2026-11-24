# Formal models

Three models of the parts of this mod where a bug would matter most: how one watch's events get
from an MCP server to a Claude Code session, how often events may wake that session, and whether
one server's webhook posts can crowd out another's at the relay. Each is written in
[Quint](https://quint-lang.org) (`delivery.qnt`, `wake.qnt`, `relay.qnt`) and, by hand from the
Quint file, in TLA+ (`Delivery.tla`, `Wake.tla`, `Relay.tla`) for the TLC model checker.

**What has been checked, exactly.**

- **TLC 1.7.4** (`node model/check.mjs`) visits every state of the TLA+ models that is
  reachable within each configuration's bounds, breadth first, and checks the invariants in
  each (two configurations that must find a violation are also kept to part of the model).
  Within those bounds that is exhaustive; past them it says nothing, and the bounds are small:
  poll and push with 3 events and 3 sessions, webhook with 1 event, or with 2 and the clock
  stopped ([the bounds](#tlc-configuration-by-configuration)).
- **Quint's own tools**: the scenarios (`quint test`), and `quint run`, Quint's random
  simulator, which samples runs. Simulation is not exhaustive at any bound.
- **That the TLA+ models are the Quint models**, in part. `node model/conform.mjs` replays
  traces Quint generates (random runs from every init, and every scenario) in the TLA+ models
  with TLC: all 2,140 traces (603 of `wake.qnt`, 333 of `delivery.qnt`, 1,204 of `relay.qnt`;
  74,392 steps) are behaviours of the TLA+ models. That checks one direction (what Quint can do, TLA+ can do), on
  samples. For the other, each counterexample TLC found on 0.5.0's models was also replayed as
  a scenario in the Quint file, and Quint reproduced it; the rest is by reading. The TLA+ is written by hand because Quint's
  own translation (`quint compile --target tlaplus`) needs Apalache, which was not installed.
- **All of it checks the models, not the code.** That a model says what the code does is by
  reading; the tables below say what stands for what.

Run them, from `polyfills/events/claude-code`:

```bash
TLA2TOOLS=/path/to/tla2tools.jar node model/check.mjs     # TLC 1.7.4 (run here on Java 21)
TLA2TOOLS=/path/to/tla2tools.jar node model/conform.mjs   # also needs Quint (QUINT=...)
quint test model/delivery.qnt --backend typescript         # the counterexamples, as scenarios
quint run model/delivery.qnt --init webhook --invariant Safety --max-samples 20000 --max-steps 60 --backend typescript
quint test model/wake.qnt --backend typescript
quint run model/wake.qnt --invariant Kept --max-samples 30000 --max-steps 40 --backend typescript
quint test model/relay.qnt --backend typescript
```

(Quint 0.34.0, `npx @informalsystems/quint@0.34.0`.) In Quint, `init` in each model is the
client from 0.5.1; `initBefore` (and `pollBefore`, `webhookBefore`, ...) is the client as it
was in 0.4.1, so the faults that version had can be shown again. In TLA+ the constant `FIX`
says which (and `MODES`, `EVILS` which of Quint's inits).

## `delivery.qnt`: from the server to the session

One subscription in one project, one Claude Code window at a time. The server emits three
events; its history can expire; for webhook it posts each to the relay, retries (a lost answer
means a retry with a new timestamp and the same `webhook-id`), gives up, or loses the
subscription (a restart, or the time to live running out). The relay stores what it is sent,
drops a delivery when its retention passes, and hands deliveries over in order on each
connection. Anyone may post forged deliveries; anyone who saw a delivery may post it again while
it is fresh; and, as a variant, the relay itself lies about when deliveries arrived and hands
them over in any order. The helper and Claude Code may stop between any two steps.

| In the model | In the code |
| --- | --- |
| `Take`, then `Append` (`AppendEv` in TLA+), `SaveWatch`, `Commit` | `RelayClient` hands a delivery to `handleDelivery` (`src/webhooks.ts`): verify, `ReplayGuard.begin`, `#deliver` (`src/watcher.ts`: spool append with fsync, then `#saveNow`), `ReplayGuard.commit` and `accepted()` |
| `StoreFails` | `#deliver` throws (spool full, save failed): `handleDelivery` answers 503 and the relay keeps the delivery |
| `FlushAcks`, `Reconnect` | `RelayClient` sends acks together; a closed socket loses queued acks, and the relay sends everything unacknowledged on the next connection |
| `Subscribe` | `events/subscribe` and its refreshes, with the watch's cursor; the answer's cursor is the server's watermark |
| `Poll`, `PollDone`, `Push`, `SaveSoon` | `#poll` and `#push`; a poll's cursor is saved 250 ms later (`#saveSoon`), a push event's with the event |
| `HandTake`, `HandSubmit`, `HandAck` | `/take`, `$.prompt.submit`, `/ack` between `mod/hooks/register.ts` and `src/helper.ts`; `submitted` is the hooks module's memory of what it submitted |
| `HelperCrash`, `HelperStart` | the helper dies and the hooks module starts it again, same session |
| `Close`, `Open` | Claude Code closes (or crashes); a new session opens in the project |
| the recovered seen ids in `loaded`, then `Carry`, `SaveSeen`, `Settle` | `WatchManager.#recover` (`src/watcher.ts`): it reads every listed session's spool (`peekSpool`, `src/store.ts`), appends what is to be carried (`appendMany`), saves the watch (`#saveNow`), then marks each session handed over (`saveDeliveredPosition`) and takes them all off the list (`ProjectState.unlist`) |

Not modelled: two Claude Code windows on one project at once; events the server sends with
`cursor: null` (event types without replay); the 500-id limit on a watch's seen ids and the
1,000-id limit on its replay memory (both are unbounded in the model); the 8-day ceiling; the
B3 admission limits (sizes, depth); `events/list` and its changes. Coarser than the code: the
recovery steps may come at any time in the model, where the code does them before the watches
run; and `Settle` marks every session and takes them off the list in one step, where the code
writes each session's position and then the list (a stop in between leaves them listed, and
the next helper does it again).

### Invariants

1. **`AtMostOnce`**: the session is shown each event at most once, across helper restarts and
   sessions, except an event in a batch that was submitted to a session which Claude Code then
   closed before that batch's ack was saved. **`StrictAtMostOnce`**, without that exception,
   does not hold, and cannot: the submit happens inside Claude Code and the ack is saved by the
   helper, and no step makes the two one. The mod chooses to show such a batch again rather
   than lose it (delivery is at least once).
2. **`NothingForged`**: nothing forged is stored, so nothing forged is shown. Checked with the
   lying relay too.
3. **`NoAckBeforeStore`** (honest relay): a genuine delivery is acknowledged to the relay, and so
   deleted there, only once its event is on disk, or its loss is one the extension allows
   (retention passed, retries ran out).
4. **`NoneStranded`**: an event stored in an earlier session's spool and never handed over is
   still on its way to a session.
5. **`CursorSafe`** (honest relay): the saved cursor never passes an event that is neither
   stored, nor still at the relay, nor lost for an allowed reason, so resuming from it skips
   nothing else.

A replayed delivery reaching the session would break `AtMostOnce`; the scenario
`replayRefusedTest` replays one through a lying relay after the replay window of 0.4.1 has passed.

## `wake.qnt`: how often events wake a session

One watch; the helper's wake budget (`src/wake.ts`, kept in `wakes.json`); the hand-over it
gates; the helper dying between any two steps; the person speaking at any time. One unit of time
stands for twenty minutes, the hour for three units, the gap for one, and two wakes an hour.

- **`WithinHour`**: between two messages of the person, no hour holds more wakes than the limit.
- **`Gap`**: two wakes are at least the gap apart.
- **`OneNotice`**: the session is told at most once that waking stopped, until the person speaks.

The wake budget is also checked, without the hand-over, by a property test over generated
sequences of events, waits, restarts and messages (`test/properties-test.ts`).

## `relay.qnt`: one mailbox per server

Two MCP servers in one project, each with a webhook address (a watch's hook) at the relay, in a
mailbox that holds at most `CAP` deliveries. Server `a` is hostile and posts well-formed junk to
its own address at any time; the relay stores it, because it holds no secret and cannot tell.
Server `b` posts genuine deliveries. Claude Code closes and opens at any time; while it is open
the mod collects, in the order each mailbox stored. Until 0.6.0 a project's watches shared one
mailbox (`p`); from 0.7.0 each server has its own, and a watch whose address is still in the
shared one moves to its server's own when it next runs.

| In the model | In the code |
| --- | --- |
| `box`, `CAP`; `Junk`, `Genuine` refused when full | `Mailbox.deliver` (`mod/relay/src/mailbox.ts`): `MAX_QUEUED`, `503` with `Retry-After` |
| `home` | the key of each server's mailbox in `relay-mailbox.json` (`serverMailboxKey`, `src/relay.ts`) and the address in each watch |
| `Collect` | `RelayClient` (`src/relay.ts`): what a mailbox holds is handed over on each connection, judged, acknowledged and deleted |
| `Drain`, then `Move` | `WatchManager.#migrate` (`src/watcher.ts`): the old address is asked for again, which collects what the old mailbox holds for it, then the old subscription is ended, the old address retired, and the watch subscribes from its cursor at a new address in its server's mailbox; the project's old key is forgotten once no watch is left there |

Not modelled: the retention time (a delivery left uncollected is dropped after it); the sizes in
bytes (`MAX_QUEUED_BYTES`); a server's retries after a `503`; the rate limits; and the moments,
inside the move, between ending the old subscription and retiring the old address (the code
keeps collecting from the old address until it is retired, and the relay hands over what it
stores while the mod is connected before it acts on the retirement, so `Move` requires that
nothing of the watch's is left in the old mailbox).

- **`NoCrossRefusal`**: a genuine delivery is never refused for room that another server's posts
  take up. **`NoCrossRefusalAtOwn`**: the same, for an address in its server's own mailbox.
- **`NothingLost`**: a genuine delivery a mailbox took is collected, or still held: moving a
  watch loses none.
- **`CollectedOnce`**: each genuine event is collected at most once.

## TLC, configuration by configuration

Each `.cfg` file is one run; its first lines say what it is. The bounds of `delivery`: `N`
events, the clock from 0 to `MAX_TIME` (one unit stands for five minutes; `FRESH` is 1 and
`SLACK` 2, as in `delivery.qnt`), `MAX_SESSIONS` Claude Code sessions one after another, and
`MAX_SEQ` deliveries ever stored at the relay (genuine, retried, forged or replayed together).
Within them, every step of the model can happen in any order: the helper stopping between any
two steps, Claude Code closing and the next session opening, the server's history expiring, and
for webhook the server retrying, giving up and losing the subscription, the relay dropping
deliveries, forgers and replayers. For poll and push the clock and the relay are held at 0
(`MAX_TIME`, `MAX_SEQ`): in those modes only `Tick`, `Forge` and `RelayDrop` touch them, and no
other step and no invariant reads them. `wake` runs at `wake.qnt`'s own bounds: the clock
from 0 to 9, `HOUR` 3, `GAP` 1, `PER_HOUR` 2.

Two devices keep the runs finite and within reach, both in `MCDelivery.tla` and `MCWake.tla`:

- a **view** (TLC's `VIEW`): TLC tells states apart by everything except what no step reads.
  The history (`hist`) is written and never read but by the invariants, which need only how
  often each event was shown (0, 1 or more), which genuine events were acknowledged, and
  `hist.cut`; a delivery in `srv.sent` is read only by `Replay`, which gives its copy a new
  relay sequence number, so the number is left out; in `wake`, any count of notices past 2 is
  taken as 2. Two states with the same view have the same invariants, and their steps lead to
  states with the same view.
- two **state constraints**, each in one configuration of 0.4.1 that must find a violation,
  which keep TLC to the part of the model a defect is in: past another, as short, that it would
  find first, or within the state folder's limit. A run under a constraint shows that the defect
  is reachable, and says nothing about what holds.

The bounds are where the runs stay under 300 MB of TLC's state files (the limit `check.mjs`
sets by default). The webhook model grows fast: with 2 events and the clock from 0 to 1 (1
session, 2 deliveries), TLC passed 22 million distinct states (on 0.5.0's model) and was
stopped at that limit.

Results on an Apple M1 Max (32 GB, macOS 15.4.1), TLC 1.7.4 on Temurin 21, one worker (so
the search is breadth first exactly and a trace is a shortest one), 24 November 2026. The
`delivery.qnt` and `wake.qnt` runs are of 0.5.1's models, which 0.6.0 and 0.7.0 leave as they
are; the `relay.qnt` runs are of 0.7.0's. "States"
is distinct states, as the view tells them apart; "Depth" is the longest of the shortest paths
from an initial state, counting that state as 1. Where TLC finds a violation it stops there:
"States" is how many it had found by then, and "Depth" the number of states in its trace.

**0.5.1, what holds:**

| Configuration | Bounds | Invariants | Result | States | Depth |
| --- | --- | --- | --- | --- | --- |
| `WakeKept` | `wake.qnt`'s | `WithinHour`, `Gap`, `OneNotice` | hold | 451,035 | 60 |
| `Poll` | poll, 3 events, 3 sessions | all five: `AtMostOnce`, `NothingForged`, `NoAckBeforeStore`, `NoneStranded`, `CursorSafe` | hold | 2,934,585 | 48 |
| `Push` | push, 3 events, 3 sessions | all five | hold | 781,478 | 39 |
| `Webhook` | webhook, honest relay, 1 event, clock 0 to 2, 2 sessions, 2 deliveries | all five | hold | 4,082,108 | 32 |
| `WebhookTwo` | webhook, honest relay, 2 events, clock at 0 (a retry is then the same delivery), 1 session, 2 deliveries | all five | hold | 9,978,241 | 38 |
| `WebhookLying` | webhook, lying relay, 1 event, clock 0 to 2, 1 session, 2 deliveries | `AtMostOnce`, `NothingForged`, `NoneStranded` | hold | 768,948 | 26 |
| `WakeNotice` | `wake.qnt`'s | `OneNotice` | holds (violated on 0.5.0's model) | 451,035 | 60 |
| `PollSeenForgotten` | poll, 1 event, 2 sessions | `AtMostOnce` | holds (violated on 0.5.0's model) | 1,594 | 21 |
| `PushSeenForgotten` | push, 1 event, 2 sessions | `AtMostOnce` | holds (violated on 0.5.0's model) | 673 | 18 |
| `WebhookSeenForgotten` | webhook, 1 event, clock at 0, 2 sessions, 2 deliveries | `AtMostOnce` | holds (violated on 0.5.0's model) | 365,472 | 29 |
| `PollCarriedTwice` | poll, 1 event, 3 sessions | `AtMostOnce` | holds (violated on 0.5.0's model, which settled one session at a time) | 6,071 | 24 |

The last five lie within the bounds of the ones above them; they are kept as the places where
TLC found the cases below.

`relay.qnt`, 0.7.0 (`CAP` 4 deliveries a mailbox, 6 genuine deliveries; junk at any time):

| Configuration | Bounds | Invariants | Result | States | Depth |
| --- | --- | --- | --- | --- | --- |
| `RelayOwn` | watches made with 0.7.0, each in its server's own mailbox | `NoCrossRefusal`, `NothingLost`, `CollectedOnce` | hold | 450 | 18 |
| `RelayMigrating` | an existing user's watches, starting in the project's mailbox, moving at any time Claude Code is open | `NoCrossRefusalAtOwn`, `NothingLost`, `CollectedOnce` | hold | 16,382 | 23 |

**Documented limits, reachable:**

| Configuration | Bounds | Invariant | Result | States | Depth |
| --- | --- | --- | --- | --- | --- |
| `Strict` | poll, 1 event, 2 sessions | `StrictAtMostOnce` | violated, as documented: the exception in `AtMostOnce` | 549 | 11 |
| `RelayMigratingShared` | as `RelayMigrating` | `NoCrossRefusal` | violated, as documented: until a watch has moved, its address is in the shared mailbox | 114 | 6 |

**A variant with a protection taken out**, so that the check is seen to need it:

| Configuration | Bounds | Invariant | Result | States | Depth |
| --- | --- | --- | --- | --- | --- |
| `RelayNoDrain` | as `RelayMigrating`, moving without collecting the old mailbox first | `NothingLost` | violated | 16 | 3 |

**0.4.1, the defects the scenarios show, found again:**

| Configuration | Bounds | Invariant | Result | States | Depth |
| --- | --- | --- | --- | --- | --- |
| `WakeBefore`, `WakeBeforeHour` | `wake.qnt`'s | `Gap`; `WithinHour` | violated (`twiceBeforeTest`) | 167; 1,578 | 8; 12 |
| `WakeBeforeNotice` | `wake.qnt`'s | `OneNotice` | violated (the same restart, with the notice) | 29,283 | 18 |
| `PollBefore` | as `Poll` | `AtMostOnce` | violated (`handOverTwiceBeforeTest`) | 1,568 | 10 |
| `PushBeforeStored` | as `Push`, constrained away from the helper being down with a batch submitted and not acknowledged | `AtMostOnce` | violated (`storedTwiceBeforeTest`) | 753 | 10 |
| `PollBeforeStranded` | as `Poll` | `NoneStranded` | violated (`strandedBeforeTest`) | 123 | 6 |
| `WebhookBeforeB1`, `WebhookBeforeB1Cursor` | webhook, 2 events, clock 0 to 3, 1 session, 2 deliveries, constrained to runs with no forger, crash, close, lapse, loss or hand-over | `NoAckBeforeStore`; `CursorSafe` | violated (`refusedAsOldBeforeTest`, B1) | 403,642; 416,514 | 17; 17 |

**0.6.0, P3 of the security review, found:**

| Configuration | Bounds | Invariant | Result | States | Depth |
| --- | --- | --- | --- | --- | --- |
| `RelayShared` | as `RelayOwn`, one mailbox for the project (`sharedRefusedBeforeTest`) | `NoCrossRefusal` | violated: `a`'s junk fills the mailbox, and `b`'s genuine delivery is refused | 58 | 6 |

Without its constraint, the push run finds `handOverTwice` first (it is as short), and the B1
run passed the state folder's limit before finding anything. Each trace TLC gives here is the
scenario's fault, by the same steps or fewer.

### What TLC found in 0.5.0's models, and what 0.5.1 changed

On 0.5.0's models (24 November 2026) TLC found three cases that random simulation had not
reached (the runs below; of 300 random runs of `wake.qnt` from `init`, of up to 40 steps, not
one reached the notice at all). Each was replayed as a Quint scenario on that model, and Quint
reproduced it. Two were in the code too, by reading, and 0.5.1 fixes them; the third was in the
model only, and the model now does as the code does. The scenarios are now `noticeOnceTest`,
`seenKeptTest` (with `seenKeptWebhookTest`) and `carriedOnceTest`, which show each case not
happening.

1. **The notice that waking stopped could be given twice** (`OneNotice`, `wake.qnt`). Shortest
   trace (18 states): two batches handed over and acknowledged, at 0 and at 1, the hour's two
   wakes; at 2 an event arrives, `/take` hands over the notice, the hooks module submits it, and
   the helper dies before the `/ack`; the next helper, told of it by the hooks module, did not
   know it was the notice (its `/ack` has no `taken`, and a notice does not move the position),
   so it neither paused waking nor marked it given, and its next `/take` handed the notice over
   again: one more turn past the limit each time the helper died there. **Fixed in 0.5.1**: the
   budget keeps on disk (`noticeHanded` in `wakes.json`) that the notice was handed over, and an
   ack at the position the notice left, while that is set, pauses waking as the first helper's
   ack would have (`src/wake.ts`, `/ack` in `src/helper.ts`; test: `test/wake-test.ts`, "the
   notice the helper before this one handed over, ..."). In the model: `remembered` says which
   of the two was submitted, `noticeHanded` is on the budget, and `AckRemembered` pauses.
2. **An event could be shown again after a session ended** (`AtMostOnce`, `delivery.qnt`; poll,
   push and webhook alike). Shortest trace (16 states, poll): the event is written to the first
   session's spool, handed over, shown and acknowledged, before the watch is saved after it;
   Claude Code closes; the next session's helper counts the event as seen (it reads the first
   session's spool), in memory only; the first session is taken off the list; the helper
   restarts, and neither the saved watch, nor its own spool, nor the list has the event, so the
   next poll stores and shows it again. In the code, `#recover` saved the watch only after
   `project.unlist(...)`: a stop between the two, or a failed save, did the same. **Fixed in
   0.5.1**: `#recover` saves the watch first, and takes sessions off the list only once that
   save succeeded (`src/watcher.ts`; test: `test/recovery-test.ts`, "seen ids read in an
   earlier session's spool are saved before it is taken off the list; ..."). In the model:
   `SaveSeen`, which `Settle` waits for.
3. **An event carried to a new session could be carried again** (`AtMostOnce`, three
   sessions). Shortest trace (16 states): the first session stores the event and closes before
   handing it over; the second carries it, shows it, and closes before it settles the first;
   the third settled the second first (taking off the list, with it, the record that the event
   was handed over), then carried the event from the first, still listed, and showed it again.
   The code never did this: `#recover` reads every listed session and works out what to carry
   before it takes any off the list, and takes them off together. **The model now does the
   same**: `Settle` takes every listed earlier session off at once, once what waited there is
   here or was handed over.

With 0.5.1 in the model, `AtMostOnce` holds at every bound above (`Poll`, `Push`, `Webhook`,
`WebhookTwo` and `WebhookLying`).

### What Quint's simulation found, and its scenarios

Against 0.4.1 (`initBefore` and the per-mode `...Before` inits), each a scenario in the file:

| Scenario | Invariant broken | What happens | Fixed in 0.5.0 by |
| --- | --- | --- | --- |
| `handOverTwiceBeforeTest` | `AtMostOnce` | The helper dies after the hooks module submitted a batch and before the ack; the next helper hands the same batch over again. | The hooks module acknowledges what it last submitted, with the spool it came from, before the next take (`mod/hooks/register.ts`, `/ack` in `src/helper.ts`). |
| `storedTwiceBeforeTest` | `AtMostOnce` | The helper dies between writing an event to the spool and saving the watch; the server sends it again and it is written again. | A starting helper counts the events in its own and listed spools as seen (`#recover`). |
| `strandedBeforeTest` | `NoneStranded` | Claude Code closes with an event stored and not yet shown (its wake held back by the gap or the hourly limit); the next session never sees it. | Sessions are listed per project; the next one appends what they stored and never showed (`#recover`). |
| `refusedAsOldBeforeTest` | `NoAckBeforeStore`, `CursorSafe` | A delivery that could not be stored stays at the relay; one signed more than ten minutes later is taken; on the next connection the first is refused as a replay and acknowledged, so its event is lost (`docs/conformance.md`, B1 of 0.4.1). | The replay memory refuses by id alone, up to 1,000 ids over 8 days, then by a floor (`ReplayGuard`, `src/webhooks.ts`). |
| `twiceBeforeTest` (`wake.qnt`) | `WithinHour`, `Gap` | A helper that died between the submit and the ack left the next helper with no record of that wake, so it handed the batch over again and counted one wake for two. | The batch the hooks module is told of is counted (the same change as `handOverTwice`). |

Random simulation of 0.4.1 found the first three of `delivery.qnt` within seconds; it did not
find the fourth in 10,000 runs of up to 50 steps, which is why every case is also a scenario.

Against 0.5.0's models (`quint run`, 24 November 2026): in 20,000 runs of up to 60 steps each,
`Safety` (all five invariants) held for poll, push and webhook through an honest relay, and
`AtMostOnce` and `NothingForged` held with the lying relay; `StrictAtMostOnce` was broken, by
the documented case. In 30,000 runs of `wake.qnt` of up to 40 steps, none of the three wake
invariants broke. TLC found three cases these runs missed (above). Against 0.5.1's models, at the CI job's sizes:
5,000 runs of up to 60 steps for each of poll, push and webhook (`Safety`) and for the lying
relay (`AtMostOnce`, `NothingForged`), and 10,000 of `wake.qnt` of up to 40 steps (`Kept`): no
violation. Against 0.7.0's `relay.qnt`: 5,000 runs of up to 30 steps from `init`
(`NoCrossRefusal`) and from `migrating` (`NoCrossRefusalAtOwn`): no violation.
