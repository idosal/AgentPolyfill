---
name: A polyfill for another extension or host
about: Propose a new polyfill, or ask for one
labels: polyfill
---

**Extension and spec**

Its identifier and the spec revision (a SEP, or an extension repository under
`modelcontextprotocol`).

**Host**

Which host, and how third-party code runs inside it.

**What the host would need**

Which of the four changes in `docs/host-changes.md` it needs, or a new one.

**Are you building it?**

If so, the `create-polyfill` skill (`/plugin install polyfill-author --marketplace idosal/AgentPolyfill`)
walks you through the contract in `docs/polyfill-contract.md`.
