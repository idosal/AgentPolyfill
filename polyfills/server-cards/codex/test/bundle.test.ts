// The plugin as Codex installs it: plugin/ copied on its own. See harness.ts bundleChecks.

import { fileURLToPath } from 'node:url'
import { bundleChecks } from './harness'

// This file runs from test/.build/, two levels below the package.
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

bundleChecks(ROOT, 'mcp-server-cards', './polyfills/server-cards/codex/plugin', ['discover_mcp_servers', 'add_mcp_server'])
