// The plugin as Copilot installs it: plugin/ copied on its own. See mcp-server-cards' Copilot harness.ts copilotBundleChecks.

import { fileURLToPath } from 'node:url'
import { copilotBundleChecks } from '../../../server-cards/copilot/test/harness'

// This file runs from test/.build/, two levels below the package.
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

copilotBundleChecks(ROOT, 'ard-discovery', './polyfills/ard/copilot/plugin', ['ard_discover', 'ard_search', 'add_mcp_server'])
