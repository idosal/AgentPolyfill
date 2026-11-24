----------------------------- MODULE AppsViews -----------------------------
(***************************************************************************)
(* Which server a view's app comes from, what the helper sends to MCP      *)
(* servers, and the views' life, in mcp-apps-cli.                          *)
(*                                                                         *)
(* Actors: Claude Code (whether it uses a server under a name, and its     *)
(* calls), the mod (mod/hooks), the helper (helper-rs), each view's app    *)
(* page, MCP servers, and another program on the same machine that can     *)
(* reach the helper's endpoint but has not got its token.                  *)
(*                                                                         *)
(* What is abstracted, and where it is checked instead:                    *)
(*  - The config gate (helper-rs/src/config.rs, resolve_in) is a pure      *)
(*    decision over a finite set of cases; it is checked exhaustively by   *)
(*    helper-rs/tests/support/gate_exhaustive.rs. Here the mod's own gate          *)
(*    (usedByClaudeCode, $.mcp.connect) is what stands between a name and  *)
(*    the helper, and the config gate only narrows it further.             *)
(*  - ${VAR} expansion is the operator Expanded below, the same rule as    *)
(*    config.rs expand_str (checked by property tests there).              *)
(*  - Consent for an app's requests is the other module, AppsConsent; here *)
(*    an app tool call that reaches the server was consented to.           *)
(*  - Requests between the mod and the helper are separate HTTP requests:  *)
(*    they may arrive in any order. Lines on the helper's stdout reach the *)
(*    mod in order, and are taken as handled when they are read.           *)
(*  - A request the helper writes to a server waits, from 0.1.3, for       *)
(*    Claude Code's verdict asked for that request (mcp.rs, admit): the    *)
(*    mod's $.mcp.connect and the helper's write are one step here. In the *)
(*    code they are one local round trip apart (the mod's /reply), which   *)
(*    this model does not see. Likewise a /revoke the mod sends on a no is *)
(*    applied in the step the mod hears the no.                           *)
(*                                                                         *)
(* Each violation is recorded in `seen` at the step that commits it, so an *)
(* invariant is "this tag never appears".                                  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS
    Servers,     \* MCP server names, e.g. {"s1", "s2"}
    Calls,       \* Claude's calls to tools that have an app; each is a view id (tool_use_id)
    CallServer,  \* [Calls -> Servers]: the server each call's tool belongs to
    LiveMax,     \* LIVE_VIEWS in mod/hooks/views.tsx: 3
    MaxOpens,    \* opens of one call's view at most (the first, then reopen or wake)
    Remote,      \* the servers reached by a URL (http, sse); the others are stdio
    FixRecheck,  \* TRUE: an app's own traffic to its server is let through only
                 \* after Claude Code's verdict on that server says yes (0.1.2)
    FixOrder,    \* TRUE: the mod sends one view id's /open and /close one at a
                 \* time, each after the one before it was answered (0.1.2)
    FixAtSend,   \* TRUE: no yes is kept: every request the helper writes to a
                 \* server waits for a verdict asked for it (0.1.3)
    FixRevoke,   \* TRUE: a no cancels what the helper has in flight to that
                 \* server, and the mod asks again while the helper waits on one (0.1.3)
    FixGen,      \* TRUE: each open of a view has its own generation, carried by
                 \* /open, /close, the page's requests and their answers (0.1.3)
    Fickle,      \* Claude Code may stop (and start again) using a server at any time
    AppTraffic,  \* the views' apps make requests (off: the views' life alone)
    Others       \* another local program tries the helper's endpoint

ASSUME /\ LiveMax \in Nat \ {0}
       /\ MaxOpens \in Nat \ {0}
       /\ Remote \subseteq Servers
       /\ CallServer \in [Calls -> Servers]
       /\ FixRecheck \in BOOLEAN /\ FixOrder \in BOOLEAN /\ Fickle \in BOOLEAN /\ AppTraffic \in BOOLEAN /\ Others \in BOOLEAN
       /\ FixAtSend \in BOOLEAN /\ FixRevoke \in BOOLEAN /\ FixGen \in BOOLEAN

None == 0
Forged == MaxOpens + 1   \* what a request without the token would name

\* Variables an entry's url or headers name: one with a credential's name
\* (ANTHROPIC_API_KEY, GITHUB_TOKEN, ...) and one with a name of the person's own.
EnvVars == {"cred", "own"}
\* config.rs, expand_str: in a remote server's url or headers a credential's
\* name reads as empty; a stdio server's environment gets what Claude Code gives it.
Expanded(s) == {v \in EnvVars : ~(s \in Remote /\ v = "cred")}

Tags == {"UnverifiedSend", "SendAfterNo", "SentWhileUnused", "CredentialToRemote",
         "HeadersElsewhere", "TooManyLive", "ForeignEffect", "ResultFromOtherServer",
         "EffectForClosedView", "EffectForOtherInstance", "OrphanPage", "AnsweredAfterNo"}

VARIABLES
    epoch,   \* state.epoch: 0, then 1 after /clear
    ccUses,  \* [Servers -> BOOLEAN]: Claude Code uses the server now, under exactly that name
    known,   \* [Servers -> {"none","yes","no"}]: the mod's latest verdict this session (verdicts)
    fresh,   \* [Servers -> BOOLEAN]: that verdict is still reused (VERDICT_MS, 5 s)
    status,  \* [Calls -> {"none","opening","live","closed","gone"}]: the view in the mod
    inst,    \* [Calls -> 0..MaxOpens]: which open of the call the mod's view is
    hpage,   \* [Calls -> 0..Forged]: the open whose page the helper holds for the id (0: none)
    hopen,   \* [Calls -> 0..Forged]: the open the helper is carrying out for the id (its lock)
    early,   \* ids whose close came while their open was under way (closed_early)
    net,     \* requests to the helper in flight, in any order
    resp,    \* the helper's answers to /open in flight
    outq,    \* [Calls -> Seq(Msg)]: with FixOrder, the id's requests not sent yet
    busy,    \* [Calls -> BOOLEAN]: with FixOrder, the id's request sent and not yet answered
    appq,    \* [Calls -> request]: an app request the helper passed to the mod (kind "none": none)
    infl,    \* [Calls -> 0..Forged]: the page whose app request the helper wrote to the
             \* server and has no answer for yet (0: none)
    cut,     \* ids whose open under way was cancelled by a no on its server (FixRevoke)
    seen     \* the tags of violations committed so far

vars == <<epoch, ccUses, known, fresh, status, inst, hpage, hopen, early, net, resp, outq, busy, appq, infl, cut, seen>>

Kinds == {"read", "apptool", "tool"}
\* read: resources/read (or list, templates); apptool: tools/call of a tool only
\* apps may call (the helper's own connection); tool: tools/call of a tool the
\* model also sees (Claude Code's connection, $.mcp.call).

\* An empty slot in appq.
NoReq == [n |-> 0, kind |-> "none"]

Msg == [kind : {"open", "close", "discover"}, id : Calls, n : 0..Forged, tok : BOOLEAN]

TypeOK ==
    /\ epoch \in 0..1
    /\ ccUses \in [Servers -> BOOLEAN]
    /\ known \in [Servers -> {"none", "yes", "no"}]
    /\ fresh \in [Servers -> BOOLEAN]
    /\ status \in [Calls -> {"none", "opening", "live", "closed", "gone"}]
    /\ inst \in [Calls -> 0..MaxOpens]
    /\ hpage \in [Calls -> 0..Forged]
    /\ hopen \in [Calls -> 0..Forged]
    /\ early \subseteq Calls
    /\ net \subseteq Msg
    /\ resp \subseteq [id : Calls, n : 0..Forged, ok : BOOLEAN]
    /\ outq \in [Calls -> Seq(Msg)]
    /\ busy \in [Calls -> BOOLEAN]
    /\ appq \in [Calls -> [n : 0..Forged, kind : Kinds \cup {"none"}]]
    /\ infl \in [Calls -> 0..Forged]
    /\ cut \subseteq Calls
    /\ seen \subseteq Tags

Init ==
    /\ epoch = 0
    /\ ccUses \in IF Fickle THEN [Servers -> BOOLEAN] ELSE {[s \in Servers |-> TRUE]}
    /\ known = [s \in Servers |-> "none"]
    /\ fresh = [s \in Servers |-> FALSE]
    /\ status = [c \in Calls |-> "none"]
    /\ inst = [c \in Calls |-> None]
    /\ hpage = [c \in Calls |-> None]
    /\ hopen = [c \in Calls |-> None]
    /\ early = {}
    /\ net = {}
    /\ resp = {}
    /\ outq = [c \in Calls |-> <<>>]
    /\ busy = [c \in Calls |-> FALSE]
    /\ appq = [c \in Calls |-> NoReq]
    /\ infl = [c \in Calls |-> None]
    /\ cut = {}
    /\ seen = {}

LiveSet == {c \in Calls : status[c] \in {"opening", "live"}}

(***************************************************************************)
(* usedByClaudeCode(server), mod/hooks/helper.ts: $.mcp.connect, which     *)
(* says connected under exactly that name or not. Before 0.1.3 a yes was   *)
(* kept 5 s (fresh) and reused for discovery and opening; from 0.1.3       *)
(* nothing is kept. Learn says what the mod then knows; Revoked and CutBy  *)
(* what a no cancels (FixRevoke: /revoke, the helper's in-flight requests  *)
(* to the server and an open of its under way).                           *)
(***************************************************************************)
Answer(s) == IF fresh[s] /\ ~FixAtSend THEN known[s] = "yes" ELSE ccUses[s]
Learn(s, yes) ==
    /\ known' = [known EXCEPT ![s] = IF yes THEN "yes" ELSE "no"]
    /\ fresh' = [fresh EXCEPT ![s] = ~FixAtSend]
Revoked(s, yes, f) == IF FixRevoke /\ ~yes THEN [c \in Calls |-> IF CallServer[c] = s THEN None ELSE f[c]] ELSE f
CutBy(s, yes) == IF FixRevoke /\ ~yes THEN {c \in Calls : CallServer[c] = s /\ hopen[c] # None} ELSE {}
\* Asked, kept verdict allowed (before 0.1.3, for discovery and opening).
Asked(s) ==
    /\ Learn(s, Answer(s))
    /\ infl' = Revoked(s, Answer(s), infl)
    /\ cut' = cut \cup CutBy(s, Answer(s))

(***************************************************************************)
(* The helper sends something to server s: what that may break. `checked`: *)
(* the request behind it came with a yes from Claude Code's verdict (the   *)
(* mod asked right before). `knownNo`: the mod's latest verdict on s, when *)
(* the request was made, was no.                                           *)
(***************************************************************************)
SendTags(s, checked, knownNo) ==
    (IF checked THEN {} ELSE {"UnverifiedSend"})
    \cup (IF knownNo THEN {"SendAfterNo"} ELSE {})
    \cup (IF ccUses[s] THEN {} ELSE {"SentWhileUnused"})
    \cup (IF s \in Remote /\ "cred" \in Expanded(s) THEN {"CredentialToRemote"} ELSE {})

\* What a view is given, and whose server it came from (its result, the
\* answers to its app's requests).
GotTags(c, from, n) ==
    (IF from = CallServer[c] THEN {} ELSE {"ResultFromOtherServer"})

---------------------------------------------------------------------------
(* Claude Code's side *)

\* The person switches a server off or on in /mcp, it disconnects, or comes back.
CCChange(s) ==
    /\ Fickle
    /\ ccUses' = [ccUses EXCEPT ![s] = ~@]
    /\ UNCHANGED <<epoch, known, fresh, status, inst, hpage, hopen, early, net, resp, appq, infl, cut, seen, outq, busy>>

\* A kept verdict ages out (5 s).
Expire(s) ==
    /\ fresh[s]
    /\ fresh' = [fresh EXCEPT ![s] = FALSE]
    /\ UNCHANGED <<epoch, ccUses, known, status, inst, hpage, hopen, early, net, resp, appq, infl, cut, seen, outq, busy>>

\* FixRevoke: while the helper waits on s (an app request in flight, an open
\* reading its UI resource), the mod asks Claude Code again (every 0.5 s in
\* the code, any time here), and a no cancels what is in flight.
Watch(s) ==
    /\ FixRevoke
    /\ \E c \in Calls : CallServer[c] = s /\ (infl[c] # None \/ hopen[c] # None)
    /\ Learn(s, ccUses[s])
    /\ infl' = Revoked(s, ccUses[s], infl)
    /\ cut' = cut \cup CutBy(s, ccUses[s])
    /\ UNCHANGED <<epoch, ccUses, status, inst, hpage, hopen, early, net, resp, appq, seen, outq, busy>>

---------------------------------------------------------------------------
(* The mod *)

\* The mod sends requests `ms` (at most one per id) to the helper: at once, or
\* with FixOrder in turn behind the id's earlier ones (helper.ts, viewTurns).
OneOf(ms, c) == IF \E m \in ms : m.id = c THEN <<CHOOSE m \in ms : m.id = c>> ELSE <<>>
Post(ms) ==
    IF FixOrder
    THEN /\ outq' = [c \in Calls |-> outq[c] \o OneOf(ms, c)]
         /\ UNCHANGED net
    ELSE /\ net' = net \cup ms
         /\ UNCHANGED outq

\* With FixOrder, an id's next request goes once the one before it is answered.
Dispatch(c) ==
    /\ FixOrder
    /\ ~busy[c]
    /\ outq[c] # <<>>
    /\ net' = net \cup {Head(outq[c])}
    /\ outq' = [outq EXCEPT ![c] = Tail(@)]
    /\ busy' = [busy EXCEPT ![c] = TRUE]
    /\ UNCHANGED <<epoch, ccUses, known, fresh, status, inst, hpage, hopen, early, resp, appq, infl, cut, seen>>

\* Opening a view for c (status none: Claude's call runs; closed: reopen, or a
\* sleeping view back in sight). Discovery and /open both name the server, so
\* the mod asks usedByClaudeCode first and goes on only on a yes. The open's
\* number (inst) is its generation, with FixGen carried by its /open. Older views
\* past LiveMax close as the new one opens (any of them: the code takes the
\* oldest, and every choice is covered here).
Open(c) ==
    LET s == CallServer[c] IN
    /\ status[c] \in {"none", "closed"}
    /\ inst[c] < MaxOpens
    /\ Asked(s)
    /\ IF Answer(s)
       THEN LET others == LiveSet \ {c}
                excess == Cardinality(others) + 1 - LiveMax
            IN \E victims \in SUBSET others :
                 /\ Cardinality(victims) = IF excess > 0 THEN excess ELSE 0
                 /\ status' = [d \in Calls |->
                                 IF d = c THEN "opening"
                                 ELSE IF d \in victims THEN "closed" ELSE status[d]]
                 /\ inst' = [inst EXCEPT ![c] = @ + 1]
                 /\ Post({[kind |-> "open", id |-> c, n |-> inst[c] + 1, tok |-> TRUE]}
                          \cup {[kind |-> "close", id |-> d, n |-> inst[d], tok |-> TRUE] : d \in victims})
                 \* Discovery reached the server (helper /discover): sent under the
                 \* yes (from 0.1.3, its own, asked by the helper: one step here).
                 /\ seen' = seen \cup SendTags(s, TRUE, FALSE)
                            \cup (IF Cardinality({d \in Calls : status'[d] \in {"opening", "live"}}) > LiveMax
                                  THEN {"TooManyLive"} ELSE {})
       ELSE UNCHANGED <<status, inst, net, outq, seen>>
    /\ UNCHANGED <<epoch, ccUses, hpage, hopen, early, resp, busy, appq>>

\* The mod closes a view: the person closes it, it sleeps out of sight, it rests
\* on the main screen. /close goes to the helper.
Close(c) ==
    /\ status[c] \in {"opening", "live"}
    /\ status' = [status EXCEPT ![c] = "closed"]
    /\ Post({[kind |-> "close", id |-> c, n |-> inst[c], tok |-> TRUE]})
    /\ UNCHANGED <<epoch, ccUses, known, fresh, inst, hpage, hopen, early, resp, busy, appq, infl, cut, seen>>

\* The helper answered an /open. Still the one opening: live (or failed).
\* Closed meanwhile with no newer open of the id: the helper is told again
\* (views.tsx openViewNow, "a close it got before the page existed did nothing").
OpenAnswered(r) ==
    /\ r \in resp
    /\ resp' = resp \ {r}
    /\ busy' = [busy EXCEPT ![r.id] = FALSE]
    /\ IF status[r.id] = "opening" /\ inst[r.id] = r.n
       THEN /\ status' = [status EXCEPT ![r.id] = IF r.ok THEN "live" ELSE "closed"]
            /\ UNCHANGED <<net, outq>>
       ELSE /\ UNCHANGED status
            /\ IF r.ok /\ inst[r.id] = r.n
               THEN Post({[kind |-> "close", id |-> r.id, n |-> r.n, tok |-> TRUE]})
               ELSE UNCHANGED <<net, outq>>
    /\ UNCHANGED <<epoch, ccUses, known, fresh, inst, hpage, hopen, early, appq, infl, cut, seen>>

\* /clear or the end of the session: verdicts forgotten, every view closed
\* (and gone with the transcript it was drawn in), /close for those open.
SessionEnd ==
    /\ epoch = 0
    /\ epoch' = 1
    /\ known' = [s \in Servers |-> "none"]
    /\ fresh' = [s \in Servers |-> FALSE]
    /\ status' = [c \in Calls |-> IF status[c] = "none" THEN "none" ELSE "gone"]
    /\ Post({[kind |-> "close", id |-> c, n |-> inst[c], tok |-> TRUE] : c \in LiveSet})
    /\ UNCHANGED <<ccUses, inst, hpage, hopen, early, resp, busy, appq, infl, cut, seen>>

\* Claude's own call returns: its result goes to its view (/result), on the
\* page the helper holds for the id.
ToolResult(c) ==
    /\ status[c] = "live"
    /\ hpage[c] # None
    /\ seen' = seen \cup GotTags(c, CallServer[c], hpage[c])
    /\ UNCHANGED <<epoch, ccUses, known, fresh, status, inst, hpage, hopen, early, net, resp, appq, infl, cut, outq, busy>>

\* The mod takes an app request from the helper's stdout (onHelperMessage,
\* 'request'). It finds the view by id and acts only while that view is live
\* (isLive); with FixGen only on a request of that view's own open (the
\* request carries its page's generation). With FixRecheck, the app's own
\* traffic to its server (reads, and calls of app-only tools) also waits for
\* Claude Code's verdict on that server, asked afresh (from 0.1.3 after the
\* person's consent, right before the answer); a model-visible tool goes over
\* Claude Code's own connection ($.mcp.call), which Claude Code decides about.
\* What the helper then sends is in flight (infl) until the server answers.
AppHandled(c) ==
    LET q == appq[c]
        s == CallServer[c]
        helperSends == q.kind \in {"read", "apptool"}
        gate == FixRecheck /\ helperSends
        liveHere == status[c] \in {"opening", "live"}
        ours == ~FixGen \/ inst[c] = q.n
        asked == gate /\ liveHere /\ ours
        yes == ~gate \/ ccUses[s]
        goes == liveHere /\ ours /\ yes /\ hpage[c] = q.n
        \* What the run commits: the helper's traffic to the server (its
        \* answer comes later, ServerAnswers), or Claude Code's call and its
        \* answer to the page. Gated, the send follows this check's yes;
        \* ungated, it follows whatever the mod last heard.
        tags == (IF helperSends THEN SendTags(s, gate, ~gate /\ known[s] = "no") ELSE GotTags(c, s, q.n))
                \cup (IF inst[c] # q.n THEN {"EffectForOtherInstance"} ELSE {})
    IN
    /\ q.kind # "none"
    /\ appq' = [appq EXCEPT ![c] = NoReq]
    /\ IF asked THEN Learn(s, ccUses[s]) ELSE UNCHANGED <<known, fresh>>
    /\ infl' = IF goes /\ helperSends THEN [infl EXCEPT ![c] = q.n]
               ELSE IF asked THEN Revoked(s, ccUses[s], infl) ELSE infl
    /\ cut' = IF asked THEN cut \cup CutBy(s, ccUses[s]) ELSE cut
    /\ seen' = IF goes THEN seen \cup tags ELSE seen
    /\ UNCHANGED <<epoch, ccUses, status, inst, hpage, hopen, early, net, resp, outq, busy>>

\* The server answers an app request the helper sent it: the answer goes to
\* the page that asked, if it is still there.
ServerAnswers(c) ==
    LET s == CallServer[c] IN
    /\ infl[c] # None
    /\ infl' = [infl EXCEPT ![c] = None]
    /\ seen' = IF hpage[c] = infl[c]
               THEN seen \cup GotTags(c, s, infl[c]) \cup (IF known[s] = "no" THEN {"AnsweredAfterNo"} ELSE {})
               ELSE seen
    /\ UNCHANGED <<epoch, ccUses, known, fresh, status, inst, hpage, hopen, early, net, resp, appq, cut, outq, busy>>

---------------------------------------------------------------------------
(* The helper *)

\* Another program on this machine reaches the helper's endpoint (the socket is
\* 0600, so only the same user; TCP on Windows) but has not got the token,
\* which went to the mod alone, on the helper's stdout.
Foreign(c) ==
    /\ Others
    /\ \E k \in {"open", "discover"} :
          net' = net \cup {[kind |-> k, id |-> c, n |-> Forged, tok |-> FALSE]}
    /\ UNCHANGED <<epoch, ccUses, known, fresh, status, inst, hpage, hopen, early, resp, appq, infl, cut, seen, outq, busy>>

\* server.rs answer(): a request without the token is refused before its body.
Refuse(m) ==
    /\ m \in net /\ ~m.tok
    /\ net' = net \ {m}
    /\ UNCHANGED <<epoch, ccUses, known, fresh, status, inst, hpage, hopen, early, resp, appq, infl, cut, seen, outq, busy>>

\* views.rs open(): one open per id at a time (its lock); a close kept from an
\* earlier open is dropped; an id it already holds a page for answers
\* "existing" (with FixGen only a page of this open's generation: one of an
\* earlier open is closed, and this open makes its own); else the page is
\* made and the UI resource read from the server, with FixAtSend only on a
\* verdict asked for that read (else the open fails).
HelperOpen(m) ==
    LET c == m.id
        s == CallServer[c]
        existing == hpage[c] # None /\ (~FixGen \/ hpage[c] = m.n)
        yes == ~FixAtSend \/ ccUses[s]
    IN
    /\ m \in net /\ m.tok /\ m.kind = "open"
    /\ hopen[c] = None
    /\ net' = net \ {m}
    /\ early' = early \ {c}
    /\ IF existing
       THEN /\ resp' = resp \cup {[id |-> c, n |-> m.n, ok |-> TRUE]}
            /\ UNCHANGED <<hopen, hpage, seen, known, fresh, infl, cut>>
       ELSE /\ hpage' = [hpage EXCEPT ![c] = None]
            /\ IF FixAtSend
               THEN /\ Learn(s, ccUses[s])
                    /\ infl' = Revoked(s, ccUses[s], infl)
                    /\ cut' = (cut \ {c}) \cup CutBy(s, ccUses[s])
               ELSE /\ UNCHANGED <<known, fresh, infl>>
                    /\ cut' = cut \ {c}
            /\ IF yes
               THEN /\ hopen' = [hopen EXCEPT ![c] = m.n]
                    /\ seen' = seen \cup SendTags(s, TRUE, FALSE)
                    /\ UNCHANGED resp
               ELSE /\ resp' = resp \cup {[id |-> c, n |-> m.n, ok |-> FALSE]}
                    /\ UNCHANGED <<hopen, seen>>
    /\ UNCHANGED <<epoch, ccUses, status, inst, appq, outq, busy>>

\* The open is done: closed while it opened (closed_early), cancelled by a no
\* on its server (FixRevoke), or its page is up.
HelperOpened(c) ==
    LET down == c \in early \/ c \in cut IN
    /\ hopen[c] # None
    /\ hopen' = [hopen EXCEPT ![c] = None]
    /\ cut' = cut \ {c}
    /\ IF down
       THEN /\ early' = early \ {c}
            /\ resp' = resp \cup {[id |-> c, n |-> hopen[c], ok |-> FALSE]}
            /\ UNCHANGED hpage
       ELSE /\ hpage' = [hpage EXCEPT ![c] = hopen[c]]
            /\ resp' = resp \cup {[id |-> c, n |-> hopen[c], ok |-> TRUE]}
            /\ UNCHANGED early
    /\ seen' = seen \cup (IF hopen[c] = Forged THEN {"ForeignEffect"} ELSE {})
                     \cup (IF ~down /\ known[CallServer[c]] = "no" THEN {"AnsweredAfterNo"} ELSE {})
    /\ UNCHANGED <<epoch, ccUses, known, fresh, status, inst, net, appq, infl, outq, busy>>

\* views.rs route("/close"): the page held for the id closes (with FixGen only
\* one of the close's own generation); for an open under way (of its
\* generation), the close is kept for when it is done; else there is nothing
\* to close.
HelperClose(m) ==
    LET c == m.id
        mine(n) == ~FixGen \/ n = m.n
    IN
    /\ m \in net /\ m.tok /\ m.kind = "close"
    /\ net' = net \ {m}
    /\ busy' = [busy EXCEPT ![c] = FALSE]
    /\ IF hpage[c] # None /\ mine(hpage[c])
       THEN /\ hpage' = [hpage EXCEPT ![c] = None]
            /\ UNCHANGED early
       ELSE /\ early' = IF hopen[c] # None /\ mine(hopen[c]) THEN early \cup {c} ELSE early
            /\ UNCHANGED hpage
    /\ UNCHANGED <<epoch, ccUses, known, fresh, status, inst, hopen, resp, outq, appq, infl, cut, seen>>

\* Discovery asked by a request (only a forged one reaches here: the mod's own
\* discovery is part of Open, under its verdict).
HelperDiscover(m) ==
    /\ m \in net /\ m.tok /\ m.kind = "discover"
    /\ net' = net \ {m}
    /\ seen' = seen \cup SendTags(CallServer[m.id], m.tok, FALSE) \cup {"ForeignEffect"}
    /\ UNCHANGED <<epoch, ccUses, known, fresh, status, inst, hpage, hopen, early, resp, appq, infl, cut, outq, busy>>

\* Chrome stops, or the app's page crashes: the page goes, and the mod is told
\* ('closed') and closes the view of that id (with FixGen only if the page
\* was of that view's own open).
Crash(c) ==
    /\ hpage[c] # None
    /\ hpage' = [hpage EXCEPT ![c] = None]
    /\ status' = [status EXCEPT ![c] = IF @ \in {"opening", "live"} /\ (~FixGen \/ inst[c] = hpage[c]) THEN "closed" ELSE @]
    /\ UNCHANGED <<epoch, ccUses, known, fresh, inst, hopen, early, net, resp, appq, infl, cut, seen, outq, busy>>

\* A page's app asks something of the host. Without the fix a read goes from
\* the helper straight to the server; everything else, and with the fix a read
\* too, goes to the mod first (a request on stdout).
AppAsks(c, k) ==
    LET s == CallServer[c] IN
    /\ AppTraffic
    /\ hpage[c] # None /\ hpage[c] # Forged
    /\ appq[c].kind = "none" /\ infl[c] = None
    /\ IF k = "read" /\ ~FixRecheck
       THEN /\ seen' = seen \cup SendTags(s, FALSE, known[s] = "no") \cup GotTags(c, s, hpage[c])
            /\ UNCHANGED appq
       ELSE /\ appq' = [appq EXCEPT ![c] = [n |-> hpage[c], kind |-> k]]
            /\ UNCHANGED seen
    /\ UNCHANGED <<epoch, ccUses, known, fresh, status, inst, hpage, hopen, early, net, resp, infl, cut, outq, busy>>

\* A server answers the helper with a redirect to another origin. The helper's
\* HTTP clients follow one only within the server's origin (streamable HTTP:
\* rmcp's same-origin 307/308; SSE: none), so nothing goes elsewhere, headers
\* included. Were it followed, "HeadersElsewhere" would be recorded here.
Redirect(s) ==
    /\ s \in Remote
    /\ UNCHANGED vars

---------------------------------------------------------------------------

Next ==
    \/ \E s \in Servers : CCChange(s) \/ Expire(s) \/ Redirect(s) \/ Watch(s)
    \/ \E c \in Calls : Open(c) \/ Close(c) \/ Dispatch(c) \/ ToolResult(c) \/ AppHandled(c) \/ ServerAnswers(c)
                        \/ Foreign(c) \/ HelperOpened(c) \/ Crash(c)
                        \/ \E k \in Kinds : AppAsks(c, k)
    \/ \E r \in resp : OpenAnswered(r)
    \/ \E m \in net : Refuse(m) \/ HelperOpen(m) \/ HelperClose(m) \/ HelperDiscover(m)
    \/ SessionEnd

Spec == Init /\ [][Next]_vars

---------------------------------------------------------------------------
(* Safety properties, in plain words *)

\* 1. The helper sends nothing to a server unless the request behind it came
\*    with Claude Code's yes for that server under that name.
GatedSends == "UnverifiedSend" \notin seen
\* 1'. Once the mod has learned that Claude Code doesn't use a server, a request
\*    made after that sends it nothing.
NoSendAfterNo == "SendAfterNo" \notin seen
\* 2. A credential-named variable never reaches a remote server's url or headers,
\*    and a server's headers go nowhere but to its own origin.
NoCredentialToRemote == "CredentialToRemote" \notin seen /\ "HeadersElsewhere" \notin seen
\* 3. At most LiveMax views are live (or opening) at once.
AtMostLiveMax == "TooManyLive" \notin seen /\ Cardinality(LiveSet) <= LiveMax
\* 4. A request without the token changes nothing and reaches no server.
TokenRequired == "ForeignEffect" \notin seen /\ \A c \in Calls : hpage[c] # Forged
\* 5. A view is given results only from the server its app came from.
OwnServerOnly == "ResultFromOtherServer" \notin seen
\* 6. Once nothing is in flight, the helper holds a page only for a view the
\*    mod has live or opening (no hidden app keeps running).
Quiet == net = {} /\ resp = {} /\ \A c \in Calls : hopen[c] = None /\ outq[c] = <<>>
NoOrphanPages == Quiet => \A c \in Calls : hpage[c] # None => status[c] \in {"opening", "live"}

\* 7. Every request the helper writes to a server goes while Claude Code uses
\*    that server under that name (0.1.3: each waits for a verdict asked for
\*    it; 0.1.2 reused a yes for up to 5 s for discovery and opening, and the
\*    helper read an open's UI resource on the /open's yes).
SendsOnlyWhileUsed == "SentWhileUnused" \notin seen
\* 8. Once the mod has heard that Claude Code stopped using a server, nothing
\*    more from that server reaches a view (an answer to its app, the UI
\*    resource of an open under way) until a later yes: what the helper had in
\*    flight to it is cancelled (0.1.3).
NoAnswerAfterNo == "AnsweredAfterNo" \notin seen
\* 9. What a view's app asked is done only for the open that asked it, never
\*    for a later open of the same call (0.1.3: each open has its own generation).
SameInstance == "EffectForOtherInstance" \notin seen

\* 10. Once nothing is in flight, every view the mod has live has its page
\*    (0.1.1 could leave one live with none: a /close for an earlier open of
\*    the id closed the page its reopen had taken, RaceBeforeDead).
NoDeadViews == Quiet => \A c \in Calls : status[c] = "live" => hpage[c] # None
=============================================================================
