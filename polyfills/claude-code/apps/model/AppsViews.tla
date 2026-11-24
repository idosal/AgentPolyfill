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
    Fickle,      \* Claude Code may stop (and start again) using a server at any time
    AppTraffic,  \* the views' apps make requests (off: the views' life alone)
    Others       \* another local program tries the helper's endpoint

ASSUME /\ LiveMax \in Nat \ {0}
       /\ MaxOpens \in Nat \ {0}
       /\ Remote \subseteq Servers
       /\ CallServer \in [Calls -> Servers]
       /\ FixRecheck \in BOOLEAN /\ FixOrder \in BOOLEAN /\ Fickle \in BOOLEAN /\ AppTraffic \in BOOLEAN /\ Others \in BOOLEAN

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
         "EffectForClosedView", "EffectForOtherInstance", "OrphanPage"}

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
    seen     \* the tags of violations committed so far

vars == <<epoch, ccUses, known, fresh, status, inst, hpage, hopen, early, net, resp, outq, busy, appq, seen>>

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
    /\ seen = {}

LiveSet == {c \in Calls : status[c] \in {"opening", "live"}}

(***************************************************************************)
(* usedByClaudeCode(server), mod/hooks/helper.ts: a kept verdict while it  *)
(* is fresh, else $.mcp.connect, which says connected under exactly that   *)
(* name or not. Says the answer, and what the mod keeps.                   *)
(***************************************************************************)
Answer(s) == IF fresh[s] THEN known[s] = "yes" ELSE ccUses[s]
Asked(s) ==
    /\ known' = [known EXCEPT ![s] = IF Answer(s) THEN "yes" ELSE "no"]
    /\ fresh' = [fresh EXCEPT ![s] = TRUE]
\* usedByClaudeCode(server, true): asked afresh, the kept verdict not used (an
\* app's own traffic, 0.1.2).
AskedFresh(s) ==
    /\ known' = [known EXCEPT ![s] = IF ccUses[s] THEN "yes" ELSE "no"]
    /\ fresh' = [fresh EXCEPT ![s] = TRUE]

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
    /\ UNCHANGED <<epoch, known, fresh, status, inst, hpage, hopen, early, net, resp, appq, seen, outq, busy>>

\* A kept verdict ages out (5 s).
Expire(s) ==
    /\ fresh[s]
    /\ fresh' = [fresh EXCEPT ![s] = FALSE]
    /\ UNCHANGED <<epoch, ccUses, known, status, inst, hpage, hopen, early, net, resp, appq, seen, outq, busy>>

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
    /\ UNCHANGED <<epoch, ccUses, known, fresh, status, inst, hpage, hopen, early, resp, appq, seen>>

\* Opening a view for c (status none: Claude's call runs; closed: reopen, or a
\* sleeping view back in sight). Discovery and /open both name the server, so
\* the mod asks usedByClaudeCode first and goes on only on a yes. Older views
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
                 \* Discovery reached the server (helper /discover): sent under the yes.
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
    /\ UNCHANGED <<epoch, ccUses, known, fresh, inst, hpage, hopen, early, resp, busy, appq, seen>>

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
    /\ UNCHANGED <<epoch, ccUses, known, fresh, inst, hpage, hopen, early, appq, seen>>

\* /clear or the end of the session: verdicts forgotten, every view closed
\* (and gone with the transcript it was drawn in), /close for those open.
SessionEnd ==
    /\ epoch = 0
    /\ epoch' = 1
    /\ known' = [s \in Servers |-> "none"]
    /\ fresh' = [s \in Servers |-> FALSE]
    /\ status' = [c \in Calls |-> IF status[c] = "none" THEN "none" ELSE "gone"]
    /\ Post({[kind |-> "close", id |-> c, n |-> inst[c], tok |-> TRUE] : c \in LiveSet})
    /\ UNCHANGED <<ccUses, inst, hpage, hopen, early, resp, busy, appq, seen>>

\* Claude's own call returns: its result goes to its view (/result), on the
\* page the helper holds for the id.
ToolResult(c) ==
    /\ status[c] = "live"
    /\ hpage[c] # None
    /\ seen' = seen \cup GotTags(c, CallServer[c], hpage[c])
    /\ UNCHANGED <<epoch, ccUses, known, fresh, status, inst, hpage, hopen, early, net, resp, appq, outq, busy>>

\* The mod takes an app request from the helper's stdout (onHelperMessage,
\* 'request'). It finds the view by id and acts only while that view is live
\* (isLive). With the fix, the app's own traffic to its server (reads, and
\* calls of app-only tools) also waits for Claude Code's verdict on that
\* server; a model-visible tool goes over Claude Code's own connection
\* ($.mcp.call), which Claude Code itself decides about.
AppHandled(c) ==
    LET q == appq[c]
        s == CallServer[c]
        helperSends == q.kind \in {"read", "apptool"}
        gate == FixRecheck /\ helperSends
        liveHere == status[c] \in {"opening", "live"}
        yes == ~gate \/ ccUses[s]
        goes == liveHere /\ yes /\ hpage[c] = q.n
        \* What the run commits: the helper's traffic to the server, and the
        \* answer to the page (the same page instance that asked).
        \* Gated, the send follows this check's yes; ungated, it follows whatever
        \* the mod last heard.
        tags == (IF helperSends THEN SendTags(s, gate, ~gate /\ known[s] = "no") ELSE {})
                \cup GotTags(c, s, q.n)
                \cup (IF inst[c] # q.n THEN {"EffectForOtherInstance"} ELSE {})
    IN
    /\ q.kind # "none"
    /\ appq' = [appq EXCEPT ![c] = NoReq]
    /\ IF gate /\ liveHere THEN AskedFresh(s) ELSE UNCHANGED <<known, fresh>>
    /\ seen' = IF goes THEN seen \cup tags ELSE seen
    /\ UNCHANGED <<epoch, ccUses, status, inst, hpage, hopen, early, net, resp, outq, busy>>

---------------------------------------------------------------------------
(* The helper *)

\* Another program on this machine reaches the helper's endpoint (the socket is
\* 0600, so only the same user; TCP on Windows) but has not got the token,
\* which went to the mod alone, on the helper's stdout.
Foreign(c) ==
    /\ Others
    /\ \E k \in {"open", "discover"} :
          net' = net \cup {[kind |-> k, id |-> c, n |-> Forged, tok |-> FALSE]}
    /\ UNCHANGED <<epoch, ccUses, known, fresh, status, inst, hpage, hopen, early, resp, appq, seen, outq, busy>>

\* server.rs answer(): a request without the token is refused before its body.
Refuse(m) ==
    /\ m \in net /\ ~m.tok
    /\ net' = net \ {m}
    /\ UNCHANGED <<epoch, ccUses, known, fresh, status, inst, hpage, hopen, early, resp, appq, seen, outq, busy>>

\* views.rs open(): one open per id at a time (its lock); a close kept from an
\* earlier open is dropped; an id it already holds a page for answers
\* "existing"; else the page is made and the UI resource read from the server.
HelperOpen(m) ==
    /\ m \in net /\ m.tok /\ m.kind = "open"
    /\ hopen[m.id] = None
    /\ net' = net \ {m}
    /\ early' = early \ {m.id}
    /\ IF hpage[m.id] # None
       THEN /\ resp' = resp \cup {[id |-> m.id, n |-> m.n, ok |-> TRUE]}
            /\ UNCHANGED <<hopen, seen>>
       ELSE /\ hopen' = [hopen EXCEPT ![m.id] = m.n]
            /\ seen' = seen \cup SendTags(CallServer[m.id], TRUE, FALSE)
            /\ UNCHANGED resp
    /\ UNCHANGED <<epoch, ccUses, known, fresh, status, inst, hpage, appq, outq, busy>>

\* The open is done: closed while it opened (closed_early), or its page is up.
HelperOpened(c) ==
    /\ hopen[c] # None
    /\ hopen' = [hopen EXCEPT ![c] = None]
    /\ IF c \in early
       THEN /\ early' = early \ {c}
            /\ resp' = resp \cup {[id |-> c, n |-> hopen[c], ok |-> FALSE]}
            /\ UNCHANGED hpage
       ELSE /\ hpage' = [hpage EXCEPT ![c] = hopen[c]]
            /\ resp' = resp \cup {[id |-> c, n |-> hopen[c], ok |-> TRUE]}
            /\ UNCHANGED early
    /\ seen' = IF hopen[c] = Forged THEN seen \cup {"ForeignEffect"} ELSE seen
    /\ UNCHANGED <<epoch, ccUses, known, fresh, status, inst, net, appq, outq, busy>>

\* views.rs route("/close"): the page held for the id closes (whichever open it
\* came from); for an open under way, the close is kept for when it is done;
\* else there is nothing to close.
HelperClose(m) ==
    /\ m \in net /\ m.tok /\ m.kind = "close"
    /\ net' = net \ {m}
    /\ busy' = [busy EXCEPT ![m.id] = FALSE]
    /\ IF hpage[m.id] # None
       THEN /\ hpage' = [hpage EXCEPT ![m.id] = None]
            /\ UNCHANGED early
       ELSE /\ early' = IF hopen[m.id] # None THEN early \cup {m.id} ELSE early
            /\ UNCHANGED hpage
    /\ UNCHANGED <<epoch, ccUses, known, fresh, status, inst, hopen, resp, outq, appq, seen>>

\* Discovery asked by a request (only a forged one reaches here: the mod's own
\* discovery is part of Open, under its verdict).
HelperDiscover(m) ==
    /\ m \in net /\ m.tok /\ m.kind = "discover"
    /\ net' = net \ {m}
    /\ seen' = seen \cup SendTags(CallServer[m.id], m.tok, FALSE) \cup {"ForeignEffect"}
    /\ UNCHANGED <<epoch, ccUses, known, fresh, status, inst, hpage, hopen, early, resp, appq, outq, busy>>

\* Chrome stops, or the app's page crashes: the page goes, and the mod is told
\* ('closed') and closes the view of that id.
Crash(c) ==
    /\ hpage[c] # None
    /\ hpage' = [hpage EXCEPT ![c] = None]
    /\ status' = [status EXCEPT ![c] = IF @ \in {"opening", "live"} THEN "closed" ELSE @]
    /\ UNCHANGED <<epoch, ccUses, known, fresh, inst, hopen, early, net, resp, appq, seen, outq, busy>>

\* A page's app asks something of the host. Without the fix a read goes from
\* the helper straight to the server; everything else, and with the fix a read
\* too, goes to the mod first (a request on stdout).
AppAsks(c, k) ==
    LET s == CallServer[c] IN
    /\ AppTraffic
    /\ hpage[c] # None /\ hpage[c] # Forged
    /\ appq[c].kind = "none"
    /\ IF k = "read" /\ ~FixRecheck
       THEN /\ seen' = seen \cup SendTags(s, FALSE, known[s] = "no") \cup GotTags(c, s, hpage[c])
            /\ UNCHANGED appq
       ELSE /\ appq' = [appq EXCEPT ![c] = [n |-> hpage[c], kind |-> k]]
            /\ UNCHANGED seen
    /\ UNCHANGED <<epoch, ccUses, known, fresh, status, inst, hpage, hopen, early, net, resp, outq, busy>>

\* A server answers the helper with a redirect to another origin. The helper's
\* HTTP clients follow one only within the server's origin (streamable HTTP:
\* rmcp's same-origin 307/308; SSE: none), so nothing goes elsewhere, headers
\* included. Were it followed, "HeadersElsewhere" would be recorded here.
Redirect(s) ==
    /\ s \in Remote
    /\ UNCHANGED vars

---------------------------------------------------------------------------

Next ==
    \/ \E s \in Servers : CCChange(s) \/ Expire(s) \/ Redirect(s)
    \/ \E c \in Calls : Open(c) \/ Close(c) \/ Dispatch(c) \/ ToolResult(c) \/ AppHandled(c)
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

\* Expected to fail, documented: a /close for an earlier open of an id can reach
\* the helper after the id's reopen found that page and took it ("existing"),
\* and closes it; the mod's view then stays live with no page (it shows its
\* last picture and answers nothing) until it is closed or reopened.
NoDeadViews == Quiet => \A c \in Calls : status[c] = "live" => hpage[c] # None

\* Expected to fail, documented: the mod reuses a yes for up to 5 s, and a
\* request already on its way is not called back, so Claude Code can stop using
\* a server shortly before the helper's last request to it.
SendsOnlyWhileUsed == "SentWhileUnused" \notin seen
\* Expected to fail, documented: the mod finds a view by its id, so a request
\* an earlier open of the same call made can be answered for the reopened view.
\* Same call, same server, same app: nothing it couldn't ask as the reopened view.
SameInstance == "EffectForOtherInstance" \notin seen
=============================================================================
