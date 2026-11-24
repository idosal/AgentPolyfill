# Verification beyond example tests

The example tests (`npm test`, `npm run test:mod`, the conformance suite, the
runs against real servers) check cases someone thought of. Two more methods
check what nobody listed: a model of the part where a bug would matter most,
explored state by state, and properties of the parsers and decisions that a
server's input reaches, checked on generated inputs. This page says what each
one checks and what it does not.

Nothing here is a proof that the mod's code is correct. The model is checked,
not the code. The property tests run the real code, on many inputs, not all.

## The model of the skill gate

**What it covers.** The state machine that decides what a server's skill may
do in a conversation: listing; the permission check of `load_skill` (an
approval kept from before, bound to the manifest hash and the server's
location; else the person is asked; else, with nobody to ask, Claude Code's
own rules decide); the load, which takes exactly the approved set or nothing;
the digest check of every file read; the record of which skills the
conversation is acting on, and whether each was approved; the gate on every
other tool call; the cross-server resource read; a resume, which reads that
record back from the conversation; the person disabling the skill and enabling
it again, at any moment, here or in another session, and the skill's line
entering the model's context; and the rules that decide which servers are used
at all.

**Where it is.** [`verification/skillGate.qnt`](../verification/skillGate.qnt)
(Quint); [`verification/SkillGate.tla`](../verification/SkillGate.tla), the
same in TLA+ for the TLC model checker, written by hand from the Quint file
(Quint's own translation to TLA+ needs Apalache, which was not installed); and
[`verification/model.ts`](../verification/model.ts), the same machine in
TypeScript, with a checker of its own that explores every reachable state.
The three are written to match, action for action and invariant for
invariant, and are kept in step by hand; two checks below tie them together.

**What stands for what in the code:**

| In the model | In the code |
|---|---|
| `srvEntry`, `srvBody`, `srvFile`: the server changes each at any moment, separately | a server that is stale, inconsistent or hostile |
| `List`, `registry` | `SkillsHost.list` and the registry it fills |
| `Check` | `tool.check` for `load_skill` in `register.ts`, `App.entry` and `SkillsHost.entry` |
| `Run` (and its `expect`, the retry from `skills/get`) | `serve` in `register.ts`, `SkillsHost.load` |
| `Unchecked` | a `load_skill` call that reached the tool with no permission check (another mod's `$.tool.call`) |
| `ReadFile`, `held` | `read_skill_file`, `SkillsHost.readFile` and the held entry |
| `Tool` (`act`, `read-own`, `read-other`) | `tool.check` for every other tool: anything outside the allowed list, and Claude Code's resource reads |
| `acting`; `convoAny`, `convoU` | `state.acting` / `loadedHere` and `note`; the conversation itself |
| `Resume` | Claude Code starting again on the conversation, perhaps without a person, perhaps with the server elsewhere; `actingSkills` reads it back |
| `HelperRestart`, `Clear`, `Forget`, `ElsewhereYes` | the helper restarting; `/clear`; `/mcp-skills forget`; a yes given in another session on the machine |
| `off`; `Disable`, `Enable` | the disabled skills in the mod's store (`storedOff`, `syncDisabled` in `register.ts`); `/mcp-skills disable` and `enable`, in this session or another, since every session reads the same store |
| `Check` and `Run` with `off` | the refusal in `tool.check` for `load_skill`, and the one in `serve` for each of the mod's tools, before the helper is asked and again after it answers |
| `Offer` | the skill's line entering the model's context: the skill listing (`prompt.attachment`, composed after the helper was told the list as the store holds it, `applyCatalog`) and `list_skills` |
| `used` and its facts | `discoverServers` in `config.ts`, then Claude Code's verdict through `$.mcp.connect` |

**The invariants, in plain words:**

- **ApprovedContent.** A skill's text reaches the model as approved only if the
  person said yes to exactly that set of files (every URI and digest), at that
  server's location, in this check or earlier. A dynamic skill's text only
  with a yes given in this load's own check.
- **Verified.** A file whose bytes do not match the entry it is read under is
  never used.
- **KeptIsConsented**, **NoKeptYesForDynamic.** An approval is kept only for
  exactly what the person said yes to, and never for a dynamic skill. With
  ApprovedContent this is what "a changed `resources` set always revokes" means
  here: no approval for one set is ever used for another.
- **Gate.** While text of a skill nobody approved is in the conversation, no
  tool outside the allowed list runs without the person's yes for that call;
  with nobody present, none runs.
- **CrossServerRead.** While a skill is in the conversation, a resource read
  from another server runs only with the person's yes for that call.
- **NobodyAnswers**, **HeldImpliesActing**, **ActingMatchesConversation.**
  Consistency: no yes without a person; the helper holds an entry only for a
  skill the conversation acts on; the hooks module's record matches the
  conversation.
- **DisabledNeverReaches.** While the person has the skill disabled, nothing of
  it enters the model's context: not its line in a listing, not its
  `SKILL.md`, not a file. And disabling it does not end the window of a skill
  already loaded (a model that let it would break ActingMatchesConversation).
- **ServerRule.** A repository's own settings never approve its servers when
  its trust is inherited from a folder around it; a server from an untrusted
  folder, or one that was rejected, is never used; nothing Claude Code does not
  use is used.

**The bound.** One server serving one skill, each part of which can be in 3
versions (4 in a second run); two locations for that server; a second server to
read resources from; a skill with a manifest, and a dynamic one; the skill
enabled or disabled; any number of
steps (each checker runs until no new state appears). Every combination of the
7 facts behind `ServerRule` (192). The two servers are interchangeable in the
code (approvals and the gate are keyed by server), which is why one skill
server is enough for these invariants; the same URI on two servers is checked
by the example tests (U1, U2).

**What was checked, and with what:**

| Check | Result |
|---|---|
| `node verification/model.ts`: every reachable state, breadth first, every invariant in every state and on every step | manifest: 290,304 states, 5,974,992 transitions, depth 17; dynamic: 12,960 states. Every invariant holds |
| the same with `--versions=4` | manifest: 1,768,960 states, 41,973,248 transitions, depth 17 (the same depth: a third version already reaches every behaviour); dynamic: 48,128. Every invariant holds |
| 0.3.0's rule (`--old`) | **Gate fails.** Shortest trace: another mod loads the skill unchecked (unapproved); the person then approves the same skill; its load replaced the unapproved record, so a command ran beside the unapproved text. With the versions changing in between, the unapproved text can differ from what was approved. Fixed in 0.3.1: a skill loaded unapproved stays unapproved until the conversation is cleared |
| a read-back that misses a load (`--lossy`, the documented limit of W1) | **Gate fails**, as expected: after a resume that misses the load, a command runs beside unapproved text. This is the limit SECURITY.md states, not a new finding |
| each of 13 protections taken out of the model, one at a time (`test/model-test.ts`) | every one is caught: no `expect` at the run, no location in the approval, no verification, no hash check on the retry, no gate, no cross-server gate, a yes kept for a dynamic skill, a repository approving itself under inherited trust; and, for disabling (0.3.2), no refusal at the run (shortest trace: `Disable`, `Unchecked`), a run that trusts its check (`Check`, `Disable`, `Run`: the person disabled the skill while its load waited), no refusal at a read (`Unchecked`, `Disable`, `ReadFile`), a listing that ignores the list (`List`, `Disable`, `Offer`), all breaking DisabledNeverReaches; and a disable that ends the window, breaking ActingMatchesConversation |
| `quint typecheck verification/skillGate.qnt` | passed for 0.3.1's model. **Not run for 0.3.2's** (the actions for disabling were added by hand, in step with the TLA+ file): Quint is not installed on this machine and nothing was downloaded. The CI job `model` runs it |
| `quint run` (Quint's simulator, TypeScript backend), 20,000 random traces of up to 25 steps, per instance | for 0.3.1's model: `manifest`, `dynamic`: no violation. `rule030`: Gate violated. `lossy`: Safety violated. Not run for 0.3.2's |
| TLC 1.7.4 on `SkillGate.tla` (`node verification/check.mjs`): every reachable state, breadth first, every invariant in every state. A state here is the gate's state with what the last step did (`ev`, `kept`), so there are more of them than the explorer counts | manifest, 3 versions: 1,398,168 states, depth 19; 4 versions: 8,347,904, depth 19. Dynamic, 3 versions: 68,688, depth 12; 4 versions: 257,536, depth 12. Every invariant holds, `DisabledNeverReaches` and `ServerRule` included |
| TLC on 0.3.0's rule (`Rule030.cfg`) and on the lossy read-back (`Lossy.cfg`), 3 versions | **Gate fails** in both, with the same shortest traces as the explorer's: `Unchecked`, `Check` (the person says yes), `Run`, `Tool`; and `Unchecked`, `Resume` (the read-back misses the load), `Tool` |
| TLC counting the gate's states alone (`VIEW st`, the `*States.cfg` configurations), against the explorer's count | 290,304 and 1,768,960 (manifest, 3 and 4 versions), 12,960 and 48,128 (dynamic): the same as `model.ts`, at both bounds |
| `node verification/conform.mjs`: 300 random Quint traces of up to 25 steps per instance, each replayed in `SkillGate.tla` with TLC | for 0.3.1's model: all 1,200 traces (30,000 steps) are behaviours of the TLA+ model. **Not run for 0.3.2's**: it needs Quint (above) |

TLC's runs: an Apple M1 Max (32 GB, macOS 15.4.1), TLC 1.7.4 on Temurin 21,
one worker, 24 November 2026; the largest, manifest with 4 versions, took 12
minutes. TLC counts the initial state as depth 1, the explorer counts steps.

**What this shows.** In the model, within that bound, the invariants hold in
every reachable state and on every step, and they are not vacuous (each
mutant breaks one, and 0.3.0's rule and the lossy read-back break `Gate`).
Two checkers that share no code, the explorer and TLC, each explored every
state to that bound, and they agree on the result and on the number of the
gate's states. Both results are exhaustive for the model at that bound and
say nothing past it; Quint's simulation is a sample.

**What it does not show.**

- That the code does what the model says. The model was written from the
  code, and its correspondence is by reading, not checked by a tool. The
  example tests check the code; two of them (in `gates.test.ts`) check the
  case the model found.
- Anything outside the model: Claude Code itself (that a hook's `ask` reaches
  a person, that a `deny` is honoured, what bypass-permissions mode does),
  other mods' `$.tool.call`, the MCP SDK, the network.
- What the person decides. The model lets the person say yes or no to
  anything; it shows that a yes is bound to what was shown, not that the
  person read it.
- The parts of disabling that are steps of their own in the code: the helper
  holds a copy of the list, and the hooks module reads the store again after
  the helper answers. The model takes each of `Check`, `Run`, `ReadFile` and
  `Offer` as one step that reads the store; that the code makes them so (a
  listing made under an older list is not used, a load disabled while the
  helper fetched it is dropped) is checked by the example tests in
  `gates.test.ts` (H1), not by the model.
- More than one skill per server, nested skills, or parallel tool calls. Each
  skill has its own approval, keyed by its own URI, and the gate takes any
  unapproved skill: these are checked by the example tests, not the model.
- That the three files are one machine, beyond what is checked: TLC on
  `SkillGate.tla` reaches as many states of the gate as `model.ts` does, at
  both bounds (the number, not the states one by one, is compared), and, for
  0.3.1's model, every sampled Quint trace was a behaviour of `SkillGate.tla`;
  the rest is by reading. For 0.3.2's actions (disabling), the Quint file was
  neither typechecked nor sampled here, so that it says the same as the other
  two rests on reading alone until CI runs. TLC checked the TLA+ file, not
  `skillGate.qnt` itself.

## Properties of what untrusted input reaches

[`test/property-test.ts`](../test/property-test.ts), run by `npm test`. The
inputs come from a seeded generator of the file's own, so each run checks the
same inputs, and a failure names the input. 2,000 inputs per property unless
said.

| Property | Checks the real code |
|---|---|
| A relative reference never leaves the skill: refused in the mod's own words, or a URI inside the skill (no `..`, no empty segment) that resolves to itself | `resolveRef` |
| Any entry, valid or damaged in one of 14 ways, never throws; one that is accepted keeps every rule of "Resources" (its own `SKILL.md` listed, every file inside the skill, the name equal to the last path segment), and is declined exactly past 512 files or 16 MiB | `checkEntry` |
| Anything at all in place of an entry is refused in the mod's words | `checkEntry` |
| The manifest hash does not depend on order or on sizes, and changes when any URI or digest changes, a file is added or one is removed (300 manifests) | `manifestHash` |
| A file passes exactly when its size and SHA-256 match; one changed byte, or one byte more or fewer, fails (500 files) | `verifyFile` |
| Frontmatter written from the entry's matches it; any one field changed or one added does not (500 frontmatters, with nesting, odd scalars and a byte-order mark) | `verifyFrontmatter` |
| Any bytes as a `SKILL.md`, and any shape of read result, fail in the mod's own words or succeed, and never throw anything else | `splitSkillMd`, `verifyFrontmatter`, `contentOf` |
| A server's text cannot close the fence it is shown in, whatever it holds; a description is one line of bounded length (500 texts) | `loadedText`, `fileText`, `oneLine` |
| The bound on one message of an event stream does not depend on how the bytes are cut into chunks; a message well inside it passes and one well past it fails (300 streams, 5 cuttings each) | `boundedFetch` |
| **Exhaustive:** for a project's `.mcp.json` server, every one of the 3,456 combinations of folder trust (none, own, from a parent), the person's approvals, the user's and the repository's settings (each unset, on or off, and lists), who rejected it, and whether it is switched off: used exactly as the documented rule says, and with trust from a parent folder never on the repository's own say | `discoverServers` |

**What they found.** The reference property found that a skill's own top
directory, given back as a full URI (for example as `list_skill_directory`'s
path), was refused as outside the skill. Fixed in 0.3.1. The others found
nothing; the exhaustive check confirms the S2 fix of the security review on
every combination.

**What they do not show.** Generated inputs are many, not all; except for the
exhaustive one, a property that holds on them may still fail on an input the
generator does not make. They test single functions, not the conversation.
