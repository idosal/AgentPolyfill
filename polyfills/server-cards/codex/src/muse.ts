// The same server in Muse Code (Meta's terminal agent), where the plugin folder's
// .muse-plugin/plugin.json starts it with `--host=muse`.
//
// Discovery is the same. Adding differs, because Muse gives a plugin no way to put a
// question to the person: its MCP client offers no elicitation, a tool call that is not
// read-only goes to Muse's approval judge (a model, which may approve it with nobody
// asked), and a hook's "ask" goes to that judge too. So in Muse add_mcp_server writes
// nothing. It checks the card and the name exactly as in Codex, and answers with the
// `muse mcp add` command that adds the server, for the person to run themselves (in a
// terminal, or after `!` at the Muse prompt). Running it is the person's yes, and the
// command shows the URL and every header it writes.

import { join } from 'node:path'
import { homedir } from 'node:os'
import { host, hostOf } from '../../claude-code/mod/hooks/configure'
import type { ServerCard } from '../../claude-code/mod/hooks/card'
import { codexRunner, type CodexPlan, type Run } from './codex'
import type { Tool } from './mcp'
import { resolveAdd, shownText, type Session } from './tools'

/** True when the server was started by the Muse manifest. */
export const isMuse = (argv: readonly string[] = process.argv): boolean => argv.includes('--host=muse')

/** Protocol revisions Muse Code 1.4.25 asks for in `initialize` (2025-06-18, seen in a live session) and the ones before it. */
export const MUSE_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

export const useMuseHost = () => {
  host.name = 'Muse'
  host.protocolVersions = MUSE_PROTOCOL_VERSIONS
}

/** Where Muse keeps the servers `muse mcp add` writes (all your projects). */
export const museSettingsPath = (env: NodeJS.ProcessEnv = process.env) =>
  join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'muse', 'settings.json')

/** Where `muse` is: PATH, then where its installers put it. */
export const museCandidates = (env: NodeJS.ProcessEnv = process.env) => [
  'muse',
  '/opt/homebrew/bin/muse',
  '/usr/local/bin/muse',
  ...(env.HOME ? [`${env.HOME}/.local/bin/muse`] : []),
]

/** Runs `muse` (only `muse mcp get`, which reads): the same runner as Codex's, over Muse's places. */
export const museRunner = (env: NodeJS.ProcessEnv = process.env): Run => codexRunner(env, museCandidates(env), 'muse')

/** Taken unless Muse says there is no server of that name; unknown counts as taken. */
export async function isNameTakenInMuse(run: Run, name: string): Promise<boolean> {
  const r = await run(['mcp', 'get', name, '--json'])
  if ('failure' in r) return true
  return !(r.exitCode !== 0 && /"not_found"/.test(r.stdout + r.stderr))
}

/** One shell word, quoted for a POSIX shell when it needs it: what is shown is what runs. */
export const shellWord = (s: string) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/**
 * The `muse mcp add` arguments for a plan. A secret stays a reference: `--bearer-token-env-var VAR`
 * for a bearer token, and a header whose whole value is `${VAR}`, which Muse fills from the
 * environment it starts in. A fixed header is written as it is.
 */
export function museAddArgs(plan: CodexPlan): string[] {
  const args = ['mcp', 'add', plan.name, '--url', plan.url]
  if (plan.bearerEnvVar) args.push('--bearer-token-env-var', plan.bearerEnvVar)
  for (const [k, v] of Object.entries(plan.httpHeaders)) args.push('-H', `${k}: ${v}`)
  for (const [k, v] of Object.entries(plan.envHttpHeaders)) args.push('-H', `${k}: \${${v}}`)
  return args
}

export const museCommand = (plan: CodexPlan) => ['muse', ...museAddArgs(plan)].map(shellWord).join(' ')

/** The answer: the server, the host it connects to, where it is written, the command, and the undo. */
export function museAddText(plan: CodexPlan, card: ServerCard, provenance: string, file: string) {
  const host = hostOf(plan.url) || '(unknown host)'
  const lines = [
    `Nothing was written. Muse gives this plugin no way to ask the person first, so they add the server themselves.`,
    `To add "${plan.name}", which connects to the host ${host} (${plan.url}), from the Server Card ${card.name}, ${provenance}, they run this in a terminal, or after ! at the Muse prompt:`,
    '',
    museCommand(plan),
    '',
    `It is written to ${file} (all their projects). New Muse sessions connect it.`,
  ]
  if (plan.envVars.length)
    lines.push(
      `It reads ${plan.envVars.length === 1 ? 'a secret' : 'secrets'} from the environment Muse starts in: ${plan.envVars.map(v => `${v.name} (${v.for}${v.description ? `: ${v.description}` : ''})`).join('; ')}. The person sets ${plan.envVars.length === 1 ? 'it' : 'them'} before starting muse; until then the server can't connect.`,
    )
  lines.push(`If the server asks for a sign-in: muse mcp login ${plan.name}. Muse holds that sign-in itself.`, `To undo: muse mcp remove ${plan.name}`)
  lines.push('Show the person the command exactly as it is above, with the host it connects to.')
  return lines.join('\n')
}

/**
 * add_mcp_server in Muse: the same checks as in Codex (a card shown in this session, at the URL
 * it gives, under a name not taken, with what Muse can express), and the command for the person.
 * It writes nothing and asks nothing, so it is read-only.
 */
export function museAddTool(session: Session, discoverName: string, foundBy: string): Tool {
  return {
    name: 'add_mcp_server',
    description:
      `Prepare an MCP server that ${foundBy} showed in this session for Muse: checks it, and gives the \`muse mcp add\` command that adds it. Nothing is written: Muse gives this plugin no way to ask the person, so they run the command themselves. The URL and headers come from the Server Card; choose the remote and give any non-secret inputs the card asks for. ` +
      'Secret inputs never pass through you: the command names environment variables that the person sets. Sign-in (OAuth) is Muse\'s own, with `muse mcp login`. ' +
      'Pass `url`, the URL the server connects to as the result showed it (its "connects to" line, else the remote\'s URL): the command is given only if that is the URL the card yields. Show the person the command exactly as it comes back.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'The domain or URL a discovery was for. Leave out for a search result.' },
        identifier: { type: 'string', description: 'The catalog entry identifier of the server to add.' },
        url: { type: 'string', description: 'The URL the server connects to, exactly as the result showed it: its "connects to" line, or else the remote\'s URL after "remote #N: <transport>". With other `values`, the URL those values give.' },
        remote: { type: 'integer', minimum: 0, description: 'The remote number from the result. Default 0.' },
        name: { type: 'string', description: 'The name to add the server under. Default: the suggested server name.' },
        values: { type: 'object', additionalProperties: { type: 'string' }, description: 'Values for the card\'s non-secret inputs, by variable or header name.' },
      },
      required: ['identifier', 'url'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async args => {
      const r = resolveAdd(session, args, discoverName)
      if ('deny' in r) return { text: shownText(r.deny.replaceAll('Codex', 'Muse')), isError: true }
      const { plan, card, provenance } = r
      if (await isNameTakenInMuse(session.deps.run, plan.name))
        return {
          text: shownText(`A server named "${plan.name}" already exists in Muse's configuration (or muse could not say). Ask the person: add it under another name (pass \`name\`), or keep theirs.`),
          isError: true,
        }
      return { text: shownText(museAddText(plan, card, provenance, museSettingsPath(session.deps.env))) }
    },
  }
}
