# The polyfill contract

A polyfill in this repository meets these rules. Where one does not yet, its
README says so.

## 1. One published extension, client side, and nothing else

It implements the client's part of an extension that has an identifier and a
spec (a SEP, or an extension repository under `modelcontextprotocol`). It adds
no methods, fields, capabilities or policy of its own. If a server behaves in a
way the spec does not define, the polyfill refuses or ignores it; it does not
invent an accommodation.

An exception has to be one the user makes on purpose, for one server at a
time, and off by default. Example: `mcp-events` will talk to a server that
advertises events in the form used before the SEP only when the user names
that server.

## 2. A named revision

Its README names the spec and revision it implements (for example "SEP-3415,
Final"). When the spec changes, the polyfill either moves to the new revision
or says it has not.

## 3. Tested against the spec and against someone else's server

- One test for each rule the spec puts on a client (each MUST and SHOULD that
  can be tested).
- An interop run against a server implementation the polyfill's author did not
  write.
- The upstream MCP conformance suite, where it has client scenarios for the
  extension.

## 4. It stands down

When the host supports the extension natively, the polyfill does nothing: no
second client, no duplicate tools, no duplicate UI. How it detects this is
specific to the host. Until there is a sound way to detect it, the polyfill
has a setting that turns it off and says so.

## 5. It says what it cannot do

For each host: what works, what does not, and which change in the host would
close each gap. A limit caused by the host (for example, no access to the
host's sign-in) is stated as a limit, not worked around in a way that weakens
the user's security.

## 6. Server content is untrusted data

What a server sends (an event payload, a skill's text, an app's HTML) is data
from that server, treated the way the host treats a tool result. Receiving it
grants nothing. What happens next goes through the host's own permissions. A
polyfill never reads the host's stored credentials.
