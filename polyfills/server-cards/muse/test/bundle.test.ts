// The Muse form as Muse installs it: the Codex plugin folder copied on its own, started by its
// .muse-plugin/plugin.json. See harness.ts museChecks.

import { fileURLToPath } from 'node:url'
import { museChecks } from './harness'

const MUSE = fileURLToPath(new URL('../..', import.meta.url))
const CODEX = fileURLToPath(new URL('../../../codex', import.meta.url))

museChecks(MUSE, CODEX, 'mcp-server-cards', ['discover_mcp_servers', 'add_mcp_server'])
