---------------------------- MODULE AppsConsent ----------------------------
(***************************************************************************)
(* What an app may make happen, and who said yes: its calls to its         *)
(* server's tools under the appToolCalls setting (rules, ask, allow), for  *)
(* tools the model also sees and tools only apps may call; its messages to *)
(* Claude under appMessages (ask, fill, allow); links it opens and files   *)
(* it saves. mod/hooks/consent.ts (allowTool, askPerson, appMessage,       *)
(* openLink, allowDownload), mod/hooks/helper.ts (onHelperMessage,         *)
(* 'request'), helper-rs/src/views.rs (host_call, download_bounded).       *)
(*                                                                         *)
(* One app's view per session: view 0 in the first session, view 1 after  *)
(* /clear. A view opened while Claude still writes its call waits for      *)
(* Claude Code to let the call run (`approval`). The person's permission   *)
(* rules may change at any time; a check of them may fail. One question   *)
(* is on screen at a time (state.asking), and a request whose turn comes   *)
(* is asked only if its session and view still stand.                     *)
(*                                                                         *)
(* Each violation is recorded in `seen` as the step that commits it runs.  *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS
    Reqs,       \* the app's requests, e.g. {1, 2}
    ToolModes,  \* the appToolCalls settings explored (one behaviour has one)
    MsgModes,   \* the appMessages settings explored
    Asked       \* the kinds of request the app makes, a subset of Kinds

Tools == {"m", "a"}  \* m: a tool the model sees too; a: a tool only apps may call
Verdicts == {"allow", "ask", "deny", "fail"}   \* $.tool.check; fail: it throws
Kinds == {"tool-m", "tool-a", "message", "link", "download"}
ASSUME ToolModes \subseteq {"rules", "ask", "allow"} /\ MsgModes \subseteq {"ask", "fill", "allow"} /\ Asked \subseteq Kinds
Phases == {"idle", "waiting", "queued", "asking", "allowed", "replied", "done"}
Outcomes == {"none", "refused", "ran", "sent", "filled", "opened", "saved"}
Whys == {"none", "rule", "setting", "person", "grant"}

Tags == {"RunWithoutConsent", "RunDespiteDeny", "RunUnapproved", "AskSkipped",
         "LinkWithoutYes", "SaveWithoutYes", "MessageWithoutYes", "Unapproved",
         "GrantFromOtherSession", "AskedForGoneView"}

VARIABLES
    mode,      \* appToolCalls: "rules" (default), "ask", "allow"
    msgMode,   \* appMessages: "ask" (default), "fill", "allow"
    rule,      \* [Tools -> Verdicts]: what the person's rules say now (or that the check fails)
    epoch,     \* the session: 0, then 1 after /clear
    vstatus,   \* [0..1 -> {"none","live","closed"}]: each session's view
    approval,  \* [0..1 -> {"pending","yes","no"}]: whether Claude Code let its call run
    grants,    \* [Tools -> {-1, 0, 1}]: "Allow X this session", and the session it was given in
    linkGrant, \* the session "Open links this session" was given in, or -1
    msgGrant,  \* the session "Send messages this session" was given in, or -1
    asking,    \* the request whose question is on screen, or 0
    rq,        \* [Reqs -> request]
    seen

vars == <<mode, msgMode, rule, epoch, vstatus, approval, grants, linkGrant, msgGrant, asking, rq, seen>>

Req0 == [phase |-> "idle", kind |-> "tool-m", view |-> 0, ep |-> 0, verdict |-> "ask",
         why |-> "none", answer |-> "none", outcome |-> "none"]

TypeOK ==
    /\ mode \in {"rules", "ask", "allow"}
    /\ msgMode \in {"ask", "fill", "allow"}
    /\ rule \in [Tools -> Verdicts]
    /\ epoch \in 0..1
    /\ vstatus \in [0..1 -> {"none", "live", "closed"}]
    /\ approval \in [0..1 -> {"pending", "yes", "no"}]
    /\ grants \in [Tools -> {-1, 0, 1}]
    /\ linkGrant \in {-1, 0, 1} /\ msgGrant \in {-1, 0, 1}
    /\ asking \in Reqs \cup {0}
    /\ \A r \in Reqs : rq[r].phase \in Phases /\ rq[r].kind \in Kinds /\ rq[r].outcome \in Outcomes
                       /\ rq[r].why \in Whys
    /\ seen \subseteq Tags

Init ==
    /\ mode \in ToolModes
    /\ msgMode \in MsgModes
    /\ rule \in IF Asked \cap {"tool-m", "tool-a"} # {} THEN [Tools -> Verdicts] ELSE {[t \in Tools |-> "ask"]}
    /\ epoch = 0
    /\ vstatus = [e \in 0..1 |-> IF e = 0 THEN "live" ELSE "none"]
    \* Opened as Claude Code ran the call (yes), or early, while Claude wrote it.
    /\ approval \in [0..1 -> {"pending", "yes"}]
    /\ grants = [t \in Tools |-> -1]
    /\ linkGrant = -1 /\ msgGrant = -1
    /\ asking = 0
    /\ rq = [r \in Reqs |-> Req0]
    /\ seen = {}

\* isLive(view): in the map, live or opening, and of this session.
Live(v) == vstatus[v] = "live" /\ v = epoch
ToolOf(k) == IF k = "tool-m" THEN "m" ELSE "a"
IsTool(k) == k \in {"tool-m", "tool-a"}
Set(r, f) == rq' = [rq EXCEPT ![r] = f]
Refused(r) == [rq[r] EXCEPT !.phase = "done", !.outcome = "refused"]

---------------------------------------------------------------------------
(* The person, Claude Code, the session *)

\* The person edits their permission rules (or a check starts to fail).
RuleChange(t, v) ==
    /\ Asked \cap {"tool-m", "tool-a"} # {}
    /\ rule' = [rule EXCEPT ![t] = v]
    /\ UNCHANGED <<mode, msgMode, epoch, vstatus, approval, grants, linkGrant, msgGrant, asking, rq, seen>>

\* Claude Code lets the early view's call run, or doesn't (denied, stopped).
Approve(v, yes) ==
    /\ approval[v] = "pending"
    /\ approval' = [approval EXCEPT ![v] = IF yes THEN "yes" ELSE "no"]
    /\ UNCHANGED <<mode, msgMode, rule, epoch, vstatus, grants, linkGrant, msgGrant, asking, rq, seen>>

\* The view closes (the person, a newer view, sleep, Chrome stopped).
CloseView(v) ==
    /\ vstatus[v] = "live"
    /\ vstatus' = [vstatus EXCEPT ![v] = "closed"]
    /\ UNCHANGED <<mode, msgMode, rule, epoch, approval, grants, linkGrant, msgGrant, asking, rq, seen>>

\* /clear: session grants end (allowedForSession, linksAllowed, messagesAllowed
\* cleared), the view closes, and the next session's view opens. A question
\* already on screen stays there until answered.
SessionEnd ==
    /\ epoch = 0
    /\ epoch' = 1
    /\ vstatus' = [e \in 0..1 |-> IF e = 0 THEN (IF vstatus[0] = "none" THEN "none" ELSE "closed") ELSE "live"]
    /\ grants' = [t \in Tools |-> -1]
    /\ linkGrant' = -1 /\ msgGrant' = -1
    /\ UNCHANGED <<mode, msgMode, rule, approval, asking, rq, seen>>

---------------------------------------------------------------------------
(* The app, the helper and the mod *)

\* The app asks; the helper passes it to the mod (ui/allow-tool, ui/message,
\* ui/open-link, ui/allow-download). The helper refuses a tool whose
\* visibility leaves out "app" before this, and the mod one its server
\* doesn't list; both are tested, not modelled.
Ask(r, k) ==
    /\ rq[r].phase = "idle"
    /\ vstatus[epoch] = "live"
    /\ Set(r, [Req0 EXCEPT !.phase = "waiting", !.kind = k, !.view = epoch])
    /\ UNCHANGED <<mode, msgMode, rule, epoch, vstatus, approval, grants, linkGrant, msgGrant, asking, seen>>

\* onHelperMessage: a request waits for the view's call to be let run, and is
\* refused if it isn't, or if the view is no longer live. Then, by kind:
\* allowTool's first part (the rules, every time; a deny wins; a session grant;
\* the setting), appMessage, openLink and allowDownload up to their question.
Take(r) ==
    LET q == rq[r]
        v == q.view
        t == ToolOf(q.kind)
        verdict == rule[t]
        checked == verdict # "fail"
    IN
    /\ q.phase = "waiting"
    /\ approval[v] # "pending"
    /\ IF approval[v] = "no" \/ ~Live(v)
       THEN Set(r, Refused(r)) /\ UNCHANGED seen
       ELSE IF IsTool(q.kind)
       THEN IF checked /\ verdict = "deny"
            THEN Set(r, Refused(r)) /\ UNCHANGED seen
            ELSE IF grants[t] # -1
            THEN Set(r, [q EXCEPT !.phase = "allowed", !.verdict = verdict, !.why = "grant", !.ep = epoch])
                 /\ seen' = IF grants[t] # epoch THEN seen \cup {"GrantFromOtherSession"} ELSE seen
            ELSE IF checked /\ mode = "allow"
            THEN Set(r, [q EXCEPT !.phase = "allowed", !.verdict = verdict, !.why = "setting", !.ep = epoch]) /\ UNCHANGED seen
            ELSE IF checked /\ mode = "rules" /\ verdict = "allow"
            THEN Set(r, [q EXCEPT !.phase = "allowed", !.verdict = verdict, !.why = "rule", !.ep = epoch]) /\ UNCHANGED seen
            ELSE Set(r, [q EXCEPT !.phase = "queued", !.verdict = verdict, !.ep = epoch]) /\ UNCHANGED seen
       ELSE IF q.kind = "message"
       THEN IF msgMode = "fill"
            THEN Set(r, [q EXCEPT !.phase = "done", !.outcome = "filled"]) /\ UNCHANGED seen
            ELSE IF msgMode = "allow" \/ msgGrant # -1
            THEN Set(r, [q EXCEPT !.phase = "allowed", !.why = IF msgMode = "allow" THEN "setting" ELSE "grant", !.ep = epoch])
                 /\ UNCHANGED seen
            ELSE Set(r, [q EXCEPT !.phase = "queued", !.ep = epoch]) /\ UNCHANGED seen
       ELSE IF q.kind = "link"
       THEN IF linkGrant # -1
            THEN Set(r, [q EXCEPT !.phase = "allowed", !.why = "grant", !.ep = epoch]) /\ UNCHANGED seen
            ELSE Set(r, [q EXCEPT !.phase = "queued", !.ep = epoch]) /\ UNCHANGED seen
       ELSE Set(r, [q EXCEPT !.phase = "queued", !.ep = epoch]) /\ UNCHANGED seen
    /\ UNCHANGED <<mode, msgMode, rule, epoch, vstatus, approval, grants, linkGrant, msgGrant, asking>>

\* A tool's question waits its turn (state.asking); askPerson then refuses one
\* whose session ended or whose view closed, and takes a grant given meanwhile.
\* Messages, links and downloads are asked at once (no queue in the code: their
\* dialogs are Claude Code's, one at a time).
StartAsk(r) ==
    LET q == rq[r] IN
    /\ q.phase = "queued"
    /\ asking = 0
    /\ IF epoch # q.ep \/ ~Live(q.view)
       THEN Set(r, Refused(r)) /\ UNCHANGED asking
       ELSE IF IsTool(q.kind) /\ grants[ToolOf(q.kind)] # -1
       THEN Set(r, [q EXCEPT !.phase = "allowed", !.why = "grant"]) /\ UNCHANGED asking
       ELSE Set(r, [q EXCEPT !.phase = "asking"]) /\ asking' = r
    /\ UNCHANGED <<mode, msgMode, rule, epoch, vstatus, approval, grants, linkGrant, msgGrant, seen>>

\* The person answers (or the dialog is dismissed, which counts as no). The
\* answer counts only if the session and the view still stand; "always" is
\* kept for the rest of the session (none for downloads).
Answer(r, a) ==
    LET q == rq[r]
        stands == epoch = q.ep /\ Live(q.view)
        yes == a \in {"yes", "always"}
        always == a = "always" /\ q.kind # "download"
    IN
    /\ q.phase = "asking"
    /\ a \in {"yes", "always", "no"}
    /\ asking' = 0
    /\ IF stands /\ yes
       THEN Set(r, [q EXCEPT !.phase = "allowed", !.why = "person", !.answer = a])
       ELSE Set(r, [Refused(r) EXCEPT !.answer = a])
    /\ grants' = IF stands /\ always /\ IsTool(q.kind) THEN [grants EXCEPT ![ToolOf(q.kind)] = epoch] ELSE grants
    /\ linkGrant' = IF stands /\ always /\ q.kind = "link" THEN epoch ELSE linkGrant
    /\ msgGrant' = IF stands /\ always /\ q.kind = "message" THEN epoch ELSE msgGrant
    /\ UNCHANGED <<mode, msgMode, rule, epoch, vstatus, approval, seen>>

\* What was allowed happens, if the view is still live (the reply's own check,
\* then the helper's `alive`): the tool runs, the message is submitted, the
\* link opens, the files are written. Each outcome is checked against who said yes.
Act(r) ==
    LET q == rq[r]
        t == ToolOf(q.kind)
        out == CASE IsTool(q.kind) -> "ran"
                 [] q.kind = "message" -> "sent"
                 [] q.kind = "link" -> "opened"
                 [] OTHER -> "saved"
        personYes == q.why = "person" /\ q.answer \in {"yes", "always"}
        grantOK == q.why = "grant"
        consented ==
            CASE IsTool(q.kind) ->
                     \/ personYes \/ grantOK
                     \/ (q.why = "setting" /\ mode = "allow" /\ q.verdict \notin {"deny", "fail"})
                     \/ (q.why = "rule" /\ mode = "rules" /\ q.verdict = "allow")
              [] q.kind = "message" -> personYes \/ grantOK \/ (q.why = "setting" /\ msgMode = "allow")
              [] q.kind = "link" -> personYes \/ grantOK
              [] OTHER -> personYes
        tag == CASE IsTool(q.kind) -> "RunWithoutConsent"
                 [] q.kind = "message" -> "MessageWithoutYes"
                 [] q.kind = "link" -> "LinkWithoutYes"
                 [] OTHER -> "SaveWithoutYes"
    IN
    /\ q.phase = "allowed"
    /\ IF Live(q.view)
       THEN /\ Set(r, [q EXCEPT !.phase = "done", !.outcome = out])
            /\ seen' = seen
                  \cup (IF consented THEN {} ELSE {tag})
                  \cup (IF IsTool(q.kind) /\ q.verdict = "deny" THEN {"RunDespiteDeny"} ELSE {})
                  \cup (IF approval[q.view] = "yes" THEN {} ELSE {"Unapproved"})
                  \* A failed check, or "ask" from the rules under rules or ask
                  \* mode, is always put to the person (or covered by their grant).
                  \cup (IF IsTool(q.kind) /\ (q.verdict = "fail" \/ mode = "ask" \/ (mode = "rules" /\ q.verdict # "allow"))
                           /\ ~personYes /\ ~grantOK THEN {"AskSkipped"} ELSE {})
       ELSE Set(r, Refused(r)) /\ UNCHANGED seen
    /\ UNCHANGED <<mode, msgMode, rule, epoch, vstatus, approval, grants, linkGrant, msgGrant, asking>>

Next ==
    \/ \E t \in Tools, v \in Verdicts : RuleChange(t, v)
    \/ \E v \in 0..1, yes \in BOOLEAN : Approve(v, yes)
    \/ \E v \in 0..1 : CloseView(v)
    \/ SessionEnd
    \/ \E r \in Reqs : \/ \E k \in Asked : Ask(r, k)
                       \/ Take(r) \/ StartAsk(r) \/ Act(r)
                       \/ \E a \in {"yes", "always", "no"} : Answer(r, a)

Spec == Init /\ [][Next]_vars

---------------------------------------------------------------------------
(* Safety properties, in plain words *)

\* An app's tool call runs only where the rules allowed it (rules or allow),
\* the setting allowed it (allow, the rules not denying), or the person said
\* yes, now or "this session" earlier in this session.
ToolCallsConsented == "RunWithoutConsent" \notin seen
\* A deny in the rules, at the time of the check, is never overridden.
DenyWins == "RunDespiteDeny" \notin seen
\* Where the rules would ask, or the check failed, the person is asked
\* (unless they allowed the tool for the session), in every mode.
AskedWhereClaudeCodeWouldAsk == "AskSkipped" \notin seen
\* No link opens and no file is saved without a yes; a message goes to Claude
\* only with a yes, the person's setting "allow", or from their own prompt (fill).
LinksAsked == "LinkWithoutYes" \notin seen
SavesAsked == "SaveWithoutYes" \notin seen
MessagesAsked == "MessageWithoutYes" \notin seen
\* Nothing happens for a view whose call Claude Code didn't let run.
OnlyApprovedViews == "Unapproved" \notin seen
\* A "this session" yes never carries into the next session.
GrantsEndWithSession == "GrantFromOtherSession" \notin seen

\* Witnesses, each expected to be violated: the outcome it rules out happens in
\* some behaviour, so the properties above don't hold for want of anything happening.
NothingRuns == \A r \in Reqs : rq[r].outcome # "ran"
NothingSent == \A r \in Reqs : rq[r].outcome # "sent"
NothingOpens == \A r \in Reqs : rq[r].outcome # "opened"
NothingSaved == \A r \in Reqs : rq[r].outcome # "saved"
=============================================================================
