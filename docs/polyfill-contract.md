# The polyfill contract

These requirements apply to each host adapter. Document exceptions in the
adapter’s README.

## 1. One published extension, client side, and nothing else

It implements the client's part of an extension that has an identifier and a
published spec. That is either:

- an MCP extension: a SEP, or an extension repository under
  `modelcontextprotocol`; or
- a spec for agents published outside MCP, such as
  [Agentic Resource Discovery](https://github.com/ards-project/ard-spec).

A polyfill for a spec from outside MCP says so wherever this repository
lists it: the README, the site and its marketplace entries. Its own README
also names who publishes the spec. The rest of this contract applies to it
unchanged, and "extension" below means either kind.

It adds no methods, fields, capabilities or policy of its own. If a server
behaves in a way the spec doesn't define, the polyfill refuses or ignores it.

One exception is allowed: an earlier form of the same extension that servers
in real use still speak. A polyfill may accept that form if it:

- maps it onto the spec's behaviour and adds nothing of its own;
- has one setting that turns it off, and with it off, follows the spec
  exactly;
- says in its README that this goes beyond the spec.

Other exceptions require explicit opt-in for each server and are disabled by default.

Example: by default `mcp-events` also uses servers that advertise events in
the form from before SEP-3415. `MCP_EVENTS_PRE_STANDARD=off` turns that off,
and a comma-separated list of server names limits it to those servers.

## 2. A named revision

Its README names the spec and revision it implements. A revision is the
status or version the spec gives itself (for example "SEP-3415, Final" or
"ARD v0.91"), or a pinned commit of its text. When the spec changes, the
polyfill either moves to the new revision or says it hasn't.

## 3. Tested against the spec and against someone else's server

- One test for each rule the spec puts on a client: each MUST and SHOULD that
  can be tested.
- An interop run against a server implementation the polyfill's author didn't
  write.
- The upstream MCP conformance suite, where it has client scenarios for the
  extension.

## 4. It stands down

When the host supports the extension natively, the polyfill does nothing: no
second client, no duplicate tools, no duplicate UI. How it detects this is
specific to the host. Until there is a sound way to detect it, the polyfill
has a setting that turns it off, and says so.

## 5. It says what it can't do

For each host: what works, what doesn't, and which change in the host would
close each gap. A limit caused by the host, such as no access to the host's
sign-in, is stated as a limit. It isn't worked around in a way that weakens
the user's security.

## 6. Server content is untrusted data

What a server sends (an event payload, a skill's text, an app's HTML) is data
from that server, treated the way the host treats a tool result. Receiving it
grants nothing. What happens next goes through the host's own permissions. A
polyfill never reads the host's stored credentials.
