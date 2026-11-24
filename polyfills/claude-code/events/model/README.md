# Formal models

Two models, in [Quint](https://quint-lang.org) (a language of the TLA+ family), of the
parts of this mod where a bug would matter most: how one watch's events get from an MCP
server to a Claude Code session, and how often events may wake that session.

**What has been checked, exactly.** Each model's scenarios were run with `quint test`, and its
invariants were checked with `quint run`, Quint's random simulator: it samples executions and
checks the invariants in every state it reaches. **That is simulation, not proof.** No model
checker has been run over these models: TLC needs a `tla2tools.jar` download that was refused
on the machine they were written on, and Apalache needs Java. The CI job `model` in
[`mcp-events-test.yml`](../../../../.github/workflows/mcp-events-test.yml) runs the same
scenarios and simulations, and also `quint verify` (Apalache, a bounded model check); that step
has never run, and until it has, nothing here is model-checked.

Run them (Quint 0.34.0, `npx @informalsystems/quint@0.34.0`):

```bash
quint test delivery.qnt --backend typescript                  # the counterexamples, as scenarios
quint run delivery.qnt --init webhook --invariant Safety --max-samples 20000 --max-steps 60 --backend typescript
quint test wake.qnt --backend typescript
quint run wake.qnt --invariant Kept --max-samples 30000 --max-steps 40 --backend typescript
```

`init` in each is the client from 0.5.0; `initBefore` (and `pollBefore`, `webhookBefore`, ...)
is the client as it was in 0.4.1, so the faults that version had can be shown again.

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
| `Take`, then `Append`, `SaveWatch`, `Commit` | `RelayClient` hands a delivery to `handleDelivery` (`src/webhooks.ts`): verify, `ReplayGuard.begin`, `#deliver` (`src/watcher.ts`: spool append with fsync, then `#saveNow`), `ReplayGuard.commit` and `accepted()` |
| `StoreFails` | `#deliver` throws (spool full, save failed): `handleDelivery` answers 503 and the relay keeps the delivery |
| `FlushAcks`, `Reconnect` | `RelayClient` sends acks together; a closed socket loses queued acks, and the relay sends everything unacknowledged on the next connection |
| `Subscribe` | `events/subscribe` and its refreshes, with the watch's cursor; the answer's cursor is the server's watermark |
| `Poll`, `PollDone`, `Push`, `SaveSoon` | `#poll` and `#push`; a poll's cursor is saved 250 ms later (`#saveSoon`), a push event's with the event |
| `HandTake`, `HandSubmit`, `HandAck` | `/take`, `$.prompt.submit`, `/ack` between `mod/hooks/register.ts` and `src/helper.ts`; `submitted` is the hooks module's memory of what it submitted |
| `HelperCrash`, `HelperStart` | the helper dies and the hooks module starts it again, same session |
| `Close`, `Open` | Claude Code closes (or crashes); a new session opens in the project |
| `Carry`, `Settle`, and the recovered seen ids in `loaded` | `WatchManager.#recover` (`src/watcher.ts`), `ProjectState.list`/`listed`/`unlist` and `peekSpool` (`src/store.ts`) |

Not modelled: two Claude Code windows on one project at once; events the server sends with
`cursor: null` (event types without replay); the 500-id limit on a watch's seen ids and the
1,000-id limit on its replay memory (both are unbounded in the model); the 8-day ceiling; the
B3 admission limits (sizes, depth); `events/list` and its changes.

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

### What checking found

Against 0.4.1 (`initBefore` and the per-mode `...Before` inits), each a scenario in the file:

| Scenario | Invariant broken | What happens | Fixed in 0.5.0 by |
| --- | --- | --- | --- |
| `handOverTwiceBeforeTest` | `AtMostOnce` | The helper dies after the hooks module submitted a batch and before the ack; the next helper hands the same batch over again. | The hooks module acknowledges what it last submitted, with the spool it came from, before the next take (`mod/hooks/register.ts`, `/ack` in `src/helper.ts`). |
| `storedTwiceBeforeTest` | `AtMostOnce` | The helper dies between writing an event to the spool and saving the watch; the server sends it again and it is written again. | A starting helper counts the events in its own and listed spools as seen (`#recover`). |
| `strandedBeforeTest` | `NoneStranded` | Claude Code closes with an event stored and not yet shown (its wake held back by the gap or the hourly limit); the next session never sees it. | Sessions are listed per project; the next one appends what they stored and never showed (`#recover`). |
| `refusedAsOldBeforeTest` | `NoAckBeforeStore`, `CursorSafe` | A delivery that could not be stored stays at the relay; one signed more than ten minutes later is taken; on the next connection the first is refused as a replay and acknowledged, so its event is lost (`docs/conformance.md`, B1 of 0.4.1). | The replay memory refuses by id alone, up to 1,000 ids over 8 days, then by a floor (`ReplayGuard`, `src/webhooks.ts`). |

Random simulation of 0.4.1 found the first three within seconds; it did not find the fourth in
10,000 runs of up to 50 steps, which is why every case is also a scenario.

Against 0.5.0 (`quint run`, 20,000 runs of up to 60 steps each, 24 November 2026): `Safety`
(all five invariants) held for poll, push and webhook through an honest relay; `AtMostOnce` and
`NothingForged` held with the lying relay; `StrictAtMostOnce` was broken, by the case named
above. All the 0.5.0 scenarios pass.

## `wake.qnt`: how often events wake a session

One watch; the helper's wake budget (`src/wake.ts`, kept in `wakes.json`); the hand-over it
gates; the helper dying between any two steps; the person speaking at any time. One unit of time
stands for twenty minutes, the hour for three units, the gap for one, and two wakes an hour.

- **`WithinHour`**: between two messages of the person, no hour holds more wakes than the limit.
- **`Gap`**: two wakes are at least the gap apart.
- **`OneNotice`**: the session is told at most once that waking stopped, until the person speaks.

Against 0.4.1, simulation broke `WithinHour` and `Gap` at once (`twiceBeforeTest`): a helper that
died between the submit and the ack left the next helper with no record of that wake, so it
handed the batch over again and counted one wake for two. 0.5.0 counts the batch it is told of
(the same change as `handOverTwice` above). Against 0.5.0, 30,000 runs of up to 40 steps broke
none of the three.

The wake budget is also checked, without the hand-over, by a property test over generated
sequences of events, waits, restarts and messages (`test/properties-test.ts`).
