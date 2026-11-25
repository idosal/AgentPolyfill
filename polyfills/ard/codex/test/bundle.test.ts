// The plugin as Codex installs it: plugin/ copied on its own. See mcp-server-cards' harness.ts bundleChecks.

import { fileURLToPath } from 'node:url'
import { bundleChecks } from '../../../server-cards/codex/test/harness'

// This file runs from test/.build/, two levels below the package.
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

bundleChecks(ROOT, 'ard-discovery', './polyfills/ard/codex/plugin', ['ard_discover', 'ard_search', 'add_mcp_server'])
