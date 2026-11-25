// The plugin as Codex installs it: plugin/ copied on its own. See mcp-server-cards' harness.ts bundleChecks.

import { fileURLToPath } from 'node:url'
import { bundleChecks, museChecks } from '../../../server-cards/codex/test/harness'

// This file runs from test/.build/, two levels below the package.
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

bundleChecks(ROOT, 'ard-discovery', './polyfills/ard/codex/plugin', ['ard_discover', 'ard_search', 'add_mcp_server'])
// In Muse there is no registry search: it sends the person's words to a third party, and Muse gives a plugin no way to ask first.
museChecks(ROOT, 'ard-discovery', ['ard_discover', 'add_mcp_server'])
