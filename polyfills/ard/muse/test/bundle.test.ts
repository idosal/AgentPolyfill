// The Muse form as Muse installs it: the Codex plugin folder copied on its own, started by its
// .muse-plugin/plugin.json. In Muse there is no registry search: it sends the person's words to a
// third party, and Muse gives a plugin no way to ask first. See mcp-server-cards' Muse harness.

import { fileURLToPath } from 'node:url'
import { museChecks } from '../../../server-cards/muse/test/harness'

const MUSE = fileURLToPath(new URL('../..', import.meta.url))
const CODEX = fileURLToPath(new URL('../../../codex', import.meta.url))

museChecks(MUSE, CODEX, 'ard-discovery', ['ard_discover', 'add_mcp_server'])
