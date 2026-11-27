# Conformance: ARD's client rules, for Muse Code

The Muse form (0.1.1, on Muse Code 1.4.25) runs the Codex form's discovery, in a
bundle of its own, against ARD v0.91 (a draft). Its discovery and card checks
are the shared code, so the Codex form's [rules](../../codex/README.md#client-rules)
hold for discovery and for each card. The rows below are where Muse differs.
M-1 to M-3 are the Muse tests in
[`../test/adapter.test.ts`](../test/adapter.test.ts).

| Rule | Status in Muse | How | Tests |
|---|---|---|---|
| Q-1 to Q-6 (a search: where the query went, the person's registry, asked first, sent as shown, only where shown, a registry's words on one line) | n/a | No search in Muse: `ard_search` isn't listed, and a call to it is refused. Nothing is sent to a registry. | M-1 |
| Discovery (`ard.json`, `rel="ard"`, the AI Catalog) | met | The shared code, as in Codex. | M-2 |
| Server Cards V-3: no text that displays as something else | met | The shared handling: what is shown, and the command, carry no hidden character. | M-3 |
| Server Cards P-2 | manual handoff | The tool returns a reviewable command. The host permission policy controls shell execution. | M-2 |
| Server Cards P-1, P-3, I-2, I-3, I-4, S-3 | as [Server Cards in Muse](../../../server-cards/muse/docs/conformance.md) | The same planner and command. | — |
| Server Cards H-1 to H-4 | n/a | No hand-over tool. | — |

See the [current host guide](../../../../docs/muse-grok.md).
