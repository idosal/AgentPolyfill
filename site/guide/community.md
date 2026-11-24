---
description: Polyfills that other people build and keep in their own repositories, listed so they can be found. Not reviewed or shipped by AgentPolyfill.
---

# Community

Polyfills that other people build and keep in their own repositories. Each
entry points at its author's repository, and is installed from there. This
project does not review, build or ship them, and they are not in its
marketplaces or in the `agent-polyfill` bundle. What each says about the
[contract](./build-a-polyfill#the-contract) is its author's own statement.

<CommunityList />

## Add yours

Open a pull request that adds one entry to
[`community/polyfills.json`](https://github.com/idosal/AgentPolyfill/blob/main/community/polyfills.json):
the extension and its spec revision, the hosts it runs in, a one-sentence
summary, your repository and its install line, and where it stands on the
contract. [`community/README.md`](https://github.com/idosal/AgentPolyfill/blob/main/community/README.md)
has the fields and what gets listed. A listed polyfill that meets the whole
contract can be proposed for the repository's own `polyfills/` by an issue.

To build one, see [Build a polyfill](./build-a-polyfill).
