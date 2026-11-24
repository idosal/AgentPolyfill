// Adding a planned server to Claude Code: `claude mcp add`, then asking the
// session to connect it. Shared by add_mcp_server and the picker's Add button.

import type { EngineInterface } from 'claude-code'
import type { Plan, Scope } from './configure'

export type Installed = {
  ok: boolean
  /** for the model, or the person: what happened, in full */
  text: string
  /** one line for the picker and a toast */
  short: string
}

type Ran = { exitCode: number; stdout: string; stderr: string }

/**
 * Runs `claude <args>`. `claude` is usually on PATH; where Claude Code runs
 * without it (the desktop app, a GUI launch), its usual install places are
 * tried in turn. Resolves the result, or why nothing could run.
 */
export async function runClaude($: EngineInterface, args: readonly string[]): Promise<Ran | { failure: string }> {
  let failure = ''
  try {
    return await $.process.run(['claude', ...args], { timeoutMs: 60_000 })
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err)
  }
  let home = ''
  try {
    home = (await $.env.get('HOME')) ?? ''
  } catch {}
  const places = [
    ...(home ? [`${home}/.local/bin/claude`, `${home}/.claude/local/claude`] : []),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]
  for (const bin of places) {
    try {
      return await $.process.run([bin, ...args], { timeoutMs: 60_000 })
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
    }
  }
  return { failure }
}

/**
 * Whether a server of this name is configured in any scope this project sees
 * (local, project, user, managed, plugin, claude.ai). `claude mcp add --scope
 * local NAME` succeeds over a user-scope NAME and then wins over it, so a card
 * titled like a server the person has could replace it (security review SC2).
 * Unknown (could not ask) counts as taken.
 */
export async function isNameTaken($: EngineInterface, name: string): Promise<boolean> {
  const r = await runClaude($, ['mcp', 'get', name])
  if ('failure' in r) return true
  return !(r.exitCode !== 0 && /No MCP server (named|found)/i.test(r.stdout + r.stderr))
}

/** The name itself if free, else name-2 … name-9; undefined if none is. */
export async function freeName($: EngineInterface, name: string): Promise<string | undefined> {
  if (!(await isNameTaken($, name))) return name
  for (let i = 2; i <= 9; i++) if (!(await isNameTaken($, `${name}-${i}`))) return `${name}-${i}`
  return undefined
}

export async function install(
  $: EngineInterface,
  plan: Plan,
  scope: Scope,
  cardName: string,
  provenance: string,
): Promise<Installed> {
  const ran = await runClaude($, plan.argv.slice(1))
  if ('failure' in ran)
    return {
      ok: false,
      text: `Could not run \`claude mcp add\` (${ran.failure}). The person can run it in a terminal instead: ${plan.command}`,
      short: `Couldn't run claude mcp add. Run it in a terminal: ${plan.command}`,
    }
  if (ran.exitCode !== 0) {
    const why = (ran.stderr || ran.stdout).trim().slice(0, 600)
    const taken = /already exists/i.test(ran.stderr + ran.stdout)
    return {
      ok: false,
      text: `claude mcp add failed: ${why}${taken ? ' Pass a different `name`.' : ''}`,
      short: taken ? `A server named "${plan.name}" already exists. Ask Claude to add it under another name.` : `claude mcp add failed: ${why.slice(0, 200)}`,
    }
  }

  const undo = `claude mcp remove ${plan.name} -s ${scope}`
  const lines = [
    `Added "${plan.name}" (${plan.transport} ${plan.url}) to the ${scope} MCP configuration, from the Server Card ${cardName}, ${provenance}. To remove it: ${undo}`,
  ]
  if (plan.envVars.length) {
    const vars = plan.envVars.map(v => v.name).join(', ')
    lines.push(
      `It reads ${plan.envVars.length === 1 ? 'a secret' : 'secrets'} from the environment: ${plan.envVars.map(v => `${v.name} (${v.for}${v.description ? `: ${v.description}` : ''})`).join('; ')}. The person sets ${plan.envVars.length === 1 ? 'it' : 'them'} and restarts Claude Code; until then the server cannot connect.`,
    )
    return { ok: true, text: lines.join('\n'), short: `Added "${plan.name}". Set ${vars} and restart Claude Code to connect it.` }
  }
  const joined = await $.mcp.connect(plan.name)
  if (joined.isConnected) {
    lines.push(`Connected as "${joined.server}": its tools are available from the next request.`)
    return { ok: true, text: lines.join('\n'), short: `Added and connected "${joined.server}".` }
  }
  lines.push(
    `Not connected yet: ${joined.message} If the server needs a sign-in, the person runs /mcp, picks "${plan.name}" and authenticates; Claude Code holds that sign-in itself.`,
  )
  return { ok: true, text: lines.join('\n'), short: `Added "${plan.name}". Run /mcp to connect or sign in.` }
}
