# Formal models

Three models of the parts of this mod where a bug would matter most: how one watch's events get
from an MCP server to a Claude Code session, how often events may wake that session, and whether
one server's webhook posts can crowd out another's at the relay. A fourth models how often events
wake a Codex session in the Codex form, mcp-events for Codex (`polyfills/events/codex`), whose
rules for waking differ ([`wakeCodex.qnt`](#wakecodexqnt-how-often-events-wake-a-codex-session)).
Each is written in [Quint](https://quint-lang.org) (`delivery.qnt`, `wake.qnt`, `relay.qnt`,
`wakeCodex.qnt`) and, by hand from the Quint file, in TLA+ (`Delivery.tla`, `Wake.tla`,
`Relay.tla`, `WakeCodex.tla`) for the TLC model checker.

**What has been checked, exactly.**

- **TLC 1.7.4** (`node model/check.mjs`) visits every state of the TLA+ models that is
  reachable within each configuration's bounds, breadth first, and checks the invariants in
  each (some are also kept to part of the model: two configurations of 0.4.1 that must find a
  violation, and one of the Codex model, of 0.1.2, [said below](#wakecodexqnt-checked)).
  Within those bounds that is exhaustive; past them it says nothing, and the bounds are small:
  poll and push with 3 events and 3 sessions, webhook with 1 event, or with 2 and the clock
  stopped ([the bounds](#tlc-configuration-by-configuration)); the Codex wake model with one
  watch and the clock to four hours ([its bounds](#wakecodexqnt-checked)).
- **Quint's own tools**: the scenarios (`quint test`), and `quint run`, Quint's random
  simulator, which samples runs. Simulation is not exhaustive at any bound.
- **That the TLA+ models are the Quint models**, in part. `node model/conform.mjs` replays
  traces Quint generates (random runs from every init, and every scenario) in the TLA+ models
  with TLC: all 3,357 traces (603 of `wake.qnt`, 333 of `delivery.qnt`, 1,204 of `relay.qnt`,
  1,217 of `wakeCodex.qnt`; 122,601 steps) are behaviours of the TLA+ models. That checks one direction (what Quint can do, TLA+ can do), on
  samples. For the other, each counterexample TLC found on 0.5.0's models, and on
  `wakeCodex.qnt`, was also replayed as a scenario in the Quint file, and Quint reproduced it;
  the rest is by reading. The TLA+ is written by hand because Quint's
  own translation (`quint compile --target tlaplus`) needs Apalache.
- **All of it checks the models, not the code.** That a model says what the code does is by
  reading; the tables below say what stands for what.

Run them, from `polyfills/events/claude-code`:

```bash
TLA2TOOLS=/path/to/tla2tools.jar node model/check.mjs     # TLC 1.7.4 (checked on Java 21)
TLA2TOOLS=/path/to/tla2tools.jar node model/conform.mjs   # also needs Quint (QUINT=...)
quint test model/delivery.qnt --backend typescript         # the counterexamples, as scenarios
quint run model/delivery.qnt --init webhook --invariant Safety --max-samples 20000 --max-steps 60 --backend typescript
quint test model/wake.qnt --backend typescript
quint run model/wake.qnt --invariant Kept --max-samples 30000 --max-steps 40 --backend typescript
quint test model/relay.qnt --backend typescript
quint test model/wakeCodex.qnt --backend typescript
quint run model/wakeCodex.qnt --invariant Kept --max-samples 20000 --max-steps 40 --backend typescript
```

(Quint 0.34.0, `npx @informalsystems/quint@0.34.0`.) In Quint, `init` in each model is the
client from 0.5.1; `initBefore` (and `pollBefore`, `webhookBefore`, ...) is the client as it
was in 0.4.1, so the faults that version had can be shown again. In TLA+ the constant `FIX`
says which (and `MODES`, `EVILS` which of Quint's inits). `wakeCodex.qnt` has inits of its own
([below](#wakecodexqnt-how-often-events-wake-a-codex-session)).

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

Results with TLC 1.7.4 on Temurin 21, one worker (so the search is breadth first exactly
and a trace is a shortest one). The
`delivery.qnt` and `wake.qnt` runs are of 0.5.1's models, which 0.6.0 and 0.7.0 leave as they
are; the `relay.qnt` runs are of 0.7.0's. The `wakeCodex.qnt` runs (of mcp-events for Codex
0.1.3, and 0.1.2's defects) are in [its own section](#wakecodexqnt-checked). "States"
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

**0.6.0, one mailbox for the project's watches:**

| Configuration | Bounds | Invariant | Result | States | Depth |
| --- | --- | --- | --- | --- | --- |
| `RelayShared` | as `RelayOwn`, one mailbox for the project (`sharedRefusedBeforeTest`) | `NoCrossRefusal` | violated: `a`'s junk fills the mailbox, and `b`'s genuine delivery is refused | 58 | 6 |

Without its constraint, the push run finds `handOverTwice` first (it is as short), and the B1
run passed the state folder's limit before finding anything. Each trace TLC gives here is the
scenario's fault, by the same steps or fewer.

### What TLC found in 0.5.0's models, and what 0.5.1 changed

On 0.5.0's models TLC found three cases that random simulation had not
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

Against 0.5.0's models (`quint run`): in 20,000 runs of up to 60 steps each,
`Safety` (all five invariants) held for poll, push and webhook through an honest relay, and
`AtMostOnce` and `NothingForged` held with the lying relay; `StrictAtMostOnce` was broken, by
the documented case. In 30,000 runs of `wake.qnt` of up to 40 steps, none of the three wake
invariants broke. TLC found three cases these runs missed (above). Against 0.5.1's models, at the CI job's sizes:
5,000 runs of up to 60 steps for each of poll, push and webhook (`Safety`) and for the lying
relay (`AtMostOnce`, `NothingForged`), and 10,000 of `wake.qnt` of up to 40 steps (`Kept`): no
violation. Against 0.7.0's `relay.qnt`: 5,000 runs of up to 30 steps from `init`
(`NoCrossRefusal`) and from `migrating` (`NoCrossRefusalAtOwn`): no violation.

## `wakeCodex.qnt`: how often events wake a Codex session

mcp-events for Codex (`polyfills/events/codex`, 0.1.5 here; since 0.1.3, 0.1.4 hardened the relay
and 0.1.5 is for two helper processes, neither of which the model has, as said below) shares the Events client and the
wake budget with this mod (`polyfills/events/core`), and wakes a session in its own way. No hooks
module takes the batch: the helper runs `codex queue`, which puts a message in the session's
queue, and a turn starts with it. The helper learns that it worked only when `codex queue` ends.
It sees the person only in the turn metadata Codex puts on each tool call. The pause past the
hour's wakes also lifts by itself, an hour after it began. And `codex queue` cannot reach some
sessions at all (a ChatGPT desktop-app chat), which the helper then stops trying to wake.

One session, one watch; the budget (`core/src/wake.ts`, kept in `wakes.json`) with its
`liftAfterMs`; the hand-over (`codex/src/threads.ts`, `codex/src/waker.ts`); which calls count as
the person's (`codex/src/meta.ts`); the helper dying between any two steps; events arriving at
any time; tool calls at any time, from turns the person started and from turns they did not. One
unit of time stands for fifteen minutes: the hour is four units, the gap one, the pause lifts
after four, and two wakes an hour.

| In the model | In the code |
| --- | --- |
| `Take` | `ThreadSession.#handOver` (`codex/src/threads.ts`): `Delivery.take`, then `WakeBudget.gate`; past the hour's wakes `handNotice` (kept on disk) and the notice, else the batch, whose hand-over `handBatch` records on disk (`handed` in `wakes.json`); then `codex queue` is run. Not while `unwakeable` is set, and one at a time |
| `QueueOk` | `codex queue` (`queueMessage`, `codex/src/waker.ts`) puts the message in the session's queue: a turn starts. The helper has not heard so yet |
| `QueueFails`; `QueueRefused` | `codex queue` fails and the helper hears so (it tries again later); it answers "no rollout found" (`unreachable`), and the helper sets `unwakeable`, in memory, and stops trying. Either way Codex did not take it: a batch's record is dropped (`dropHanded`), and the notice is no longer handed over (`dropNotice`) |
| `QueueUnknown` | `codex queue` does not finish within its minute (`maybe`): it may have queued the message. A batch is marked handed over and counted, as in `Heard`; the notice pauses waking |
| `Heard` | `#queue` returns ok: a batch is marked handed over (`Delivery.ack`), then counts as a wake (`WakeBudget.woke`, which clears the record in the same write); the notice pauses waking (`WakeBudget.pause`, which sets `pausedAt`). A helper ending between the two leaves the record, as one ending before it heard back does |
| `Lift` | `WakeBudget.gate` on a paused budget once `pausedAt + liftAfterMs` has passed: no longer paused, and the hour's wakes forgotten. The gate is asked on each stored event and before each hand-over; the model lets it come at any time the helper runs |
| `HelperDies`, `HelperStarts` | the helper ends (Codex closed its input, or it was killed), and a new `ThreadSession` reads `wakes.json` and `delivered.pos`. `noticeHanded` on disk makes it start paused (`ThreadSession.start`, from 0.1.5; the constructor before); then a recorded batch is marked handed over and counted as a wake, at the time the new helper starts (`ThreadSession.start`) |
| `CallIn(person, trigger)` | a `tools/call` (`codex/src/helper.ts`): `isThePersons` on `x-codex-turn-metadata.turn_trigger`, and if so `ThreadSession.spoke`, `WakeBudget.spoke`. `person` is whether the person started the turn; `trigger` is what Codex says started it: on the person's turns `user`, `composer`, `exec` or `realtime` (`voice` until 0.1.7), or no metadata (`"none"`, a Codex before 0.172); on other turns `queue` (a wake, this plugin's among them), a trigger neither rule names (`hook`), or no metadata |
| `local` | whether `codex queue` can reach the session at all |

From 0.1.7, `Take` has one more condition, which the model doesn't have. No hand-over is made
unless the latest call from a turn the queue didn't start was from a turn the person started in
Codex's own app (`shown-by.json`, `codex/src/meta.ts` `shownBy`). A condition on a step
only takes behaviours away, and each property below is about what must never happen, so each
still holds with it.

`init` is 0.1.3, the session reachable or not. `initUnrecorded` is 0.1.2: no record of the
hand-over, a timeout a failure like any other, and a notice whose `codex queue` failed still kept
as handed over. `initBefore` is 0.1.3 with the allowlist of the person's triggers taken out: 0.1.0's rule,
under which a call with no turn metadata, or with a trigger its denylist did not name, was the
person's, and 0.1.0's pause, which lifted only on such a call. `initShortLift` is 0.1.3 with a
pause that lifts after a quarter of an hour. In TLA+ the constants `ALLOW`, `LIFT` and `RECORD`
say which.

- **`WithinHour`**: between two calls the code takes as the person's, made in turns the person
  started, no hour holds more wakes than the limit. The count runs on across the pause lifting
  by itself: the lift does not start it again.
- **`Gap`**: two wakes are at least the gap apart.
- **`OnlyThePerson`**: a call from a turn the person did not start never ends the pause or starts
  the hour again. A woken turn's call cannot lift the pause.
- **`QuietAfterNotice`**: once the session is told that waking stopped, or waking pauses, no wake
  comes until the person's own call, or until the pause's time has passed.
- **`OneNotice`**: the session is told at most once in a pause that waking stopped.
- **`NoWakeUnwakeable`**: a helper that heard "no rollout found" runs `codex queue` for that
  session no more, and a session `codex queue` cannot reach is never woken. (The first holds by
  the check at the top of `#handOver`, which the model has; TLC checks that no other path runs
  it.)
- **`Stored`**: the position the hand-over has reached never passes the store. That events are
  stored whatever the budget says, and whether or not the session can be woken, is in the
  model's steps rather than checked (`Arrive` waits only for the helper, as the watches store
  without asking the budget); `unwakeableTest` shows it.
- **`AtMostOnce`**: no wake announces an event that an earlier wake announced.
- **`NoStalePause`**: a helper never starts paused by a notice that `codex queue` said it did not
  take. Such a pause is one the session was never told of, and a call of the person's made since
  would not end it.
- **`OnlyUnheardSkipped`**: the position passes an event that no wake carried only for a batch
  handed to `codex queue` that the helper never heard back about (it ended, or `codex queue` timed
  out) and that Codex had not taken. No other step skips one.
- **`NothingLost`**, a documented limit of 0.1.3: the position never passes an event that no wake
  carried. It does not hold, and is not meant to: delivery is at most once, so the case
  `OnlyUnheardSkipped` allows skips its batch (its events are still stored, for `recent_events`).
  0.1.2 kept `NothingLost` by being at least once, and broke `Gap`, `WithinHour` and `AtMostOnce`
  for it ([below](#what-tlc-found-in-mcp-events-for-codex-012)).
- **`NeverRetried`**, a documented limit: no `codex queue` is run for a
  session after it answered "no rollout found". It does not hold, and is not meant to:
  `unwakeable` is kept in memory, so a new helper tries once more, and is refused again.

Not modelled: several watches (each has its own gap; a wake takes every watch's events); two
helper processes with the same session open, a second window (below); a `codex queue` that outlives the helper that ran it (its effect is that of the helper dying after
`QueueOk`, which the model has, when it takes the message before the next helper starts; later
than that is not modelled); a record that cannot be written (the batch is then not handed over);
the retries' back-off and the timers (every step may come at any time instead); a batch of blank
lines; a pause saved by a version before 0.1.1, with no `pausedAt` (it counts from when it is
first read); `MCP_EVENTS_WAKES_PER_HOUR=0`. Taken as given: Codex marks a turn
it started from the queue `queue`, never one of the person's triggers, and neither the model nor a
hook can set `_meta`; a `codex queue` that answers that it failed did not queue the message.

Two helper processes are not modelled: the model has one at a time, and `HelperStarts` reads the
budget from disk. The code makes the second window's helper fit that, and its tests
(`codex/test/two-windows-test.ts`) check it instead. Only the helper that runs the watches writes
`wakes.json` (`ThreadSession.spoke` in the other one changes nothing), and one taking the watches
over reads `wakes.json` again first (`WakeBudget.reload` in `ThreadSession.start`), as does its
event store before giving an id. Before 0.1.5 a takeover went by what it had read when it first
saw the session, and handed a recorded batch over again; and the person's call in the other window
saved that stale count over the record. Each test fails on 0.1.3.

### `wakeCodex.qnt`, checked

Why an hour of four units, where `wake.qnt` has three: the notice takes a gap's slot after the
hour's last wake, so with three units even a pause that lifted after one could not put a third
wake within an hour, and `WakeCodexShortLift` would find nothing. With four it does, and the check
can tell the code's lift (an hour) from a short one. In general a lift shorter than the hour less
the hour's wakes times the gap lets more wakes into an hour; the code's lift is the hour itself.

`MCWakeCodex.tla` has two views and one action constraint:

- **`View`**: the event counts (`stored`, `pos`, `upto`, `carried`, `excused`, and the record's
  end) are read only as differences, so they are counted from `pos`; `upto` is read only while a
  batch is queued; `carried` and `excused` only as to how far above `pos` they are, or that they
  are below it.
- **`ViewQuiet`**: `View`, and `shown` and `spoke` left out: no step reads them (`spoke` is written
  from `shown`'s length), and only `WithinHour` and `Gap` do, which the configurations using it
  do not check. It keeps 0.1.2's runs finite: with the helper dying after `codex queue` took a
  batch, `shown` can grow without bound at one moment (below). In 0.1.3 it cannot.
- **`ViewOld`**, for `WakeCodexHeard`: `View`, and the history only 0.1.3's invariants read
  (`dup`, `excused`, `noticeFailed`, `stale`) left out. With it, 0.1.2 has exactly the states it
  had before 0.1.3 was modelled (5,466,060): the 0.1.3 steps and fields leave 0.1.2 as it was.
- **`HeardBeforeDying`** (`ACTION_CONSTRAINT`), for `WakeCodexHeard` only: the helper does not
  die between `codex queue` taking a batch and the helper hearing so. A run under it says nothing
  about that step. No 0.1.3 configuration uses it.

TLC 1.7.4 on OpenJDK 23, one worker (the counts do not depend on the Java):

| Configuration | Bounds | Invariants | Result | States | Depth |
| --- | --- | --- | --- | --- | --- |
| `WakeCodexKept` | 0.1.3; the clock from 0 to 12 (three hours: the pause lifts twice), at most 2 events waiting; reachable and not; the helper dying between any two steps | all ten | hold | 15,105,481 | 77 |
| `WakeCodexLong` | 0.1.3; the clock from 0 to 16 (four hours), at most 3 events waiting (`ViewQuiet`) | all but `WithinHour` and `Gap` | hold | 690,380 | 46 |
| `WakeCodexHeard` | 0.1.2; as `WakeCodexKept`, under `HeardBeforeDying` (`ViewOld`) | 0.1.2's seven (`NothingLost` among them) | hold | 5,466,060 | 75 |
| `WakeCodexHour`, `WakeCodexGap`, `WakeCodexTwice` | 0.1.2; the clock from 0 to 10, 2 events | `WithinHour`; `Gap`; `AtMostOnce` | violated: [found in 0.1.2](#what-tlc-found-in-mcp-events-for-codex-012) | 3,467; 413; 290 | 12; 8; 8 |
| `WakeCodexStale` | as `WakeCodexHour` | `NoStalePause` | violated: [found in 0.1.2](#what-tlc-found-in-mcp-events-for-codex-012) | 4,422 | 16 |
| `WakeCodexSkipped` | 0.1.3; as `WakeCodexHour` | `NothingLost` | violated, as documented (at most once) | 31 | 4 |
| `WakeCodexRetried` | 0.1.3; as `WakeCodexHour` | `NeverRetried` | violated, as documented | 192 | 7 |
| `WakeCodexBefore`, `WakeCodexBeforeHour` | 0.1.3 with 0.1.0's rule and pause; as `WakeCodexHour` | `OnlyThePerson`; `WithinHour` | violated (`deniedBeforeTest`) | 65; 21,827 | 5; 15 |
| `WakeCodexShortLift` | 0.1.3 with the pause lifting after a quarter of an hour; as `WakeCodexHour` | `WithinHour` | violated (`shortLiftTest`) | 58,560 | 18 |

0.1.2's configurations must find its defects again, so that the check is seen to need what 0.1.3
changed. `WakeCodexStale`'s trace (16 states) is two wakes, the notice's `codex queue` failing,
and the helper restarting: it starts paused, though the session was never told; with the person
writing in between (`staleNoticeTest`) their message is passed over too. `WakeCodexSkipped`'s
(4 states) is a batch whose `codex queue` timed out: counted as handed over, and never shown.
The last three must find a violation so that the check is seen to need the allowlist and the
lift's length. `WakeCodexBefore`'s trace, in 5 states: a first
wake counted (here after a timeout), then a call from a turn the person did not start, with no
turn metadata (or a `hook` trigger), starts the hour again. `WakeCodexBeforeHour`'s (15 states): two wakes, such a
call, and a third wake at once. `WakeCodexShortLift`'s (18 states): two wakes, the notice, the
pause lifting a quarter of an hour later, and a third wake within the hour.

Quint (0.34.0): the scenarios (`quint test model/wakeCodex.qnt`) show the lift (`liftTest`), a
woken turn's call ending nothing (`wokenTurnTest`), the person's ending the pause (`personTest`),
the notice not given twice across a restart (`noticeUnheardTest`), a session that cannot be
reached (`unwakeableTest`, `retriedTest`), the variants (`deniedBeforeTest`, `shortLiftTest`);
0.1.3's hand-over across a restart (`unheardTest`), at most once (`unannouncedTest`,
`unknownTest`, `unknownSkippedTest`), and the notice (`noticeFailedTest`, `noticeInFlightTest`);
and, from `initUnrecorded`, what 0.1.2 did (`unheardTwiceTest`, `unheardHourTest`,
`staleNoticeTest`). In 20,000 random runs of up to 40 steps from `init`, `Kept` held (the CI job
runs 10,000), and `NothingLost` broke at once (the documented limit). From `initUnrecorded`,
`Kept` broke within the first runs, and from `initBefore` `OnlyThePerson`. From `initShortLift`,
`WithinHour` did not break in 20,000 runs; TLC finds it (`WakeCodexShortLift`).
`node model/conform.mjs` replays 1,217 traces of `wakeCodex.qnt` (300 random runs of up to 40
steps from each of the four inits, and the 17 scenarios; 48,209 steps) in `WakeCodex.tla`, and
each is a behaviour of it.

This checks the model, not the code: that `wakeCodex.qnt` does what the Codex form does is by
reading `core/src/wake.ts`, `codex/src/threads.ts`, `codex/src/helper.ts`, `codex/src/meta.ts`
and `codex/src/waker.ts` at 0.1.5, with the table above. The tests in `codex/test/wake-test.ts`
("a hand-over the helper never heard back about") run the three cases on the code itself: a
helper killed after `codex queue` took a batch, a `codex queue` that times out, and a notice
whose `codex queue` failed before the person wrote and the helper restarted. Each fails on 0.1.2.

The Copilot form (`../copilot`) runs this same `ThreadSession` and wake budget, unchanged. Two of
the model's inputs differ there, and the model was not rerun for them: the hand-over goes through
`session.send` (`copilot/src/waker.ts`), whose "no answer within a minute" counts as handed over, as
a `codex queue` timeout does; and the person is seen in every `user.message` without an automation
source, not in a tool call's turn metadata, so the pause can end at the person's message itself.
`copilot/test/extension-test.ts` checks both on the code.

### What TLC found in mcp-events for Codex 0.1.2

**A wake that `codex queue` took, and that the helper never heard of, is not counted**
(`Gap`, `WithinHour`, `AtMostOnce`; fixed in 0.1.3). Shortest trace (`WakeCodexGap`, 8 states):
an event is stored; the helper takes it and runs `codex queue`, which queues it, and the session is
woken; the helper dies before `codex queue` returns; the next helper finds the batch not marked
handed over (0.1.2's delivery was at least once) and hands it over again at once. The session is
woken twice, and the budget counts one wake or none. Each such death adds a wake that neither the
gap nor the hour knows of: `WakeCodexHour` (12 states) has three at one moment, after two deaths.

In 0.1.2, `#handOver` recorded the wake (`budget.woke`) and the position (`delivery.ack`) only
after `codex queue` returned, and nothing on disk said that a batch was handed to it. The helper
ends when Codex closes its input, and `stop()` does not wait for a wake in progress, so the moment
is the one between Codex queueing the message and `woke()`. The notice had a guard against the
same thing (`noticeHanded`, after which a new helper starts paused); a batch had none. In this mod
the same case was 0.4.1's `twiceBeforeTest`, fixed in 0.5.0 by counting the batch the hooks module
says it submitted. Only the helper ending at that moment causes it, not anything a server sends,
and each time adds at most one wake. With that one step left out (`WakeCodexHeard`), 0.1.2's seven
invariants hold.

0.1.3 records the hand-over before `codex queue` runs (`WakeBudget.handBatch`, `handed` in
`wakes.json`, saved whole: written beside the file, flushed, and renamed over it). Codex saying it
did not take the batch drops the record; hearing that it did marks the batch handed over, then
counts the wake, which clears the record in the same write. A new helper that finds a record marks
that batch handed over and counts it as a wake (`ThreadSession.start`), and a `codex queue` that
times out (`maybe`) is counted the same way. Delivery is at most once: a batch whose `codex queue`
Codex never took, from a helper that ended or timed out, goes unannounced, and its events stay
stored (`NothingLost`, `WakeCodexSkipped`, the documented limit). `WakeCodexKept`, with the helper
dying between any two steps, holds.

**A notice `codex queue` did not take pauses the next helper** (`NoStalePause`, `WakeCodexStale`;
fixed in 0.1.3): the notice's `codex queue` fails, the person then speaks, and the helper restarts
before the next wake. 0.1.2 kept `noticeHanded` set after the failure, so the new helper started
paused, with no notice given and the person's message passed over, until the pause's hour was up
(`staleNoticeTest`). 0.1.3 clears it when `codex queue` says it failed (`WakeBudget.dropNotice`),
and the notice is tried again (`noticeFailedTest`).

**What TLC found in the first form of that fix.** The fix first made the person's call clear
`noticeHanded` (`WakeBudget.spoke`). TLC found `QuietAfterNotice` broken by it (17 states): the
person speaks while the notice's `codex queue` runs, Codex takes the notice (the session is told,
after the person's call, that waking stopped), and the helper dies before it hears so. The record
of the notice was gone, so the new helper did not start paused, and woke the session at once. A
notice in `codex queue` is now cleared only by its answer, and a helper that starts before the
answer counts it as given (`noticeInFlightTest`).
