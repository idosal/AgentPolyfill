// The plugin as Copilot installs it: plugin/ copied on its own. See harness.ts copilotBundleChecks.

import { fileURLToPath } from 'node:url'
import { copilotBundleChecks } from './harness'

// This file runs from test/.build/, two levels below the package.
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

copilotBundleChecks(ROOT, 'mcp-server-cards', './polyfills/server-cards/copilot/plugin', ['discover_mcp_servers', 'add_mcp_server'])
