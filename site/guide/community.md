---
description: Independently maintained polyfills and how to list a project.
---

# Community

Install community polyfills from the repositories listed below. Their maintainers
provide the compatibility and [conformance](./build-a-polyfill#the-contract) information.
AgentPolyfill does not review or distribute these packages.

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
