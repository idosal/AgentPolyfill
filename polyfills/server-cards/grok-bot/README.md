# Server Cards and ARD for Grok Bot

From this folder run `node skills/server-card-connector/scripts/card-to-connector.mjs buildkite.com`. Add `--ard` to include the domain's ARD directory and links. Use `--server <identifier>` to choose between entries, `--set name=value` for a public parameter and `--json` for structured output.

Review the suggested name, remote URL, header names and OAuth settings. Enter secrets directly in **Connect apps → Add a custom connector**. A saved custom connector applies across the account. The helper only prepares the form.

To package the helper as a team skill, see the [host guide](../../../docs/muse-grok.md). When a team skill's bundled script is unavailable on the Bot computer, the operator can run the same standalone Node command locally. For development, run `npm ci`, `npm run build` and `npm test` here.
