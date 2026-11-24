// Copilot's side of an addition: the plan a card gives, and the command that writes it.
//
// Copilot reads your MCP servers from $COPILOT_HOME/mcp-config.json (~/.copilot), for all your
// projects, and `copilot mcp add` writes there. Unlike Codex, it takes everything a card can ask
// for: streamable HTTP and SSE, any header, and `${VAR}` references, which Copilot expands from
// its environment when it connects (seen live in 1.0.115) and `copilot mcp add` writes as they
// are. So the plan is the shared one (configure.ts planAdd), as Claude Code's is: a secret is a
// `${VAR}` named for this card alone, never a value. `copilot mcp add` contacts no server and
// starts no sign-in; a server behind OAuth asks for it when Copilot first connects (/mcp auth).

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hasMarkup, type ServerCard } from '../../claude-code/mod/hooks/card'
import { planAdd, type Plan } from '../../claude-code/mod/hooks/configure'
import type { Ran, Run } from '../../codex/src/codex'

export type CopilotPlan = Plan & {
  /** `copilot mcp add` arguments */
  addArgs: string[]
  /** what is written, as the entry Copilot keeps in mcp-config.json */
  json: string
}

export type CopilotPlanResult = { plan: CopilotPlan } | { missing: { input: string; description?: string; choices?: string[] }[] } | { error: string }

/** The card's remote as a Copilot entry: planAdd's checks (inputs, `$`, the URL rules, no private remote from a public card). */
export const planForCopilot = (card: ServerCard, remoteIndex: number, values: Record<string, string>, name: string | undefined, fromLocal: boolean): CopilotPlanResult => {
  const planned = planAdd(card, remoteIndex, values, name, 'user', fromLocal)
  if (!('plan' in planned)) return planned
  const p = planned.plan
  // A header is shown in the form as it is: no markup a host could render as something else
  // (security review C4, as in the Codex form).
  for (const h of p.headers)
    if (hasMarkup(h.value.replace(/\$\{[A-Z0-9_]+\}/g, '')))
      return { error: `The header ${h.name} holds \`, <, > or a square bracket (${h.value}), which could show as something else in the form.` }
  const headers = Object.fromEntries(p.headers.map(h => [h.name, h.value]))
  return {
    plan: {
      ...p,
      addArgs: ['mcp', 'add', '--transport', p.transport, ...p.headers.flatMap(h => ['--header', `${h.name}: ${h.value}`]), p.name, p.url],
      json: JSON.stringify({ [p.name]: { type: p.transport, url: p.url, ...(p.headers.length ? { headers } : {}), tools: ['*'] } }, null, 2),
    },
  }
}

/** Copilot's home: COPILOT_HOME, else ~/.copilot. */
export const copilotHome = (env: NodeJS.ProcessEnv = process.env) => env.COPILOT_HOME?.trim() || join(env.HOME || homedir(), '.copilot')
/** The file Copilot keeps your MCP servers in. */
export const configPath = (env: NodeJS.ProcessEnv = process.env) => join(copilotHome(env), 'mcp-config.json')

/** Where `copilot` is: the one that started this server (COPILOT_CLI_PATH), then PATH and the usual install places. */
export const copilotCandidates = (env: NodeJS.ProcessEnv = process.env) => [
  ...(env.COPILOT_CLI_PATH ? [env.COPILOT_CLI_PATH] : []),
  'copilot',
  ...(env.HOME ? [`${env.HOME}/.local/bin/copilot`] : []),
  '/opt/homebrew/bin/copilot',
  '/usr/local/bin/copilot',
]

const runOnce = (bin: string, args: readonly string[], cwd: string | undefined, timeoutMs: number) =>
  new Promise<Ran | { failure: string }>(resolve => {
    let child: ReturnType<typeof spawn>
    try {
      // No shell: a card's text never meets a command line parser.
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, ...(cwd ? { cwd } : {}) })
    } catch (err) {
      return resolve({ failure: err instanceof Error ? err.message : String(err) })
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout!.on('data', d => (stdout += d))
    child.stderr!.on('data', d => (stderr += d))
    child.on('error', err => {
      clearTimeout(timer)
      resolve({ failure: err.message })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? -1, stdout, stderr })
    })
  })

/**
 * Runs `copilot`, in the session's folder (COPILOT_SESSION_CWD, which Copilot gives its MCP
 * servers), so that `copilot mcp get` sees the workspace's servers as the session does.
 */
export function copilotRunner(env: NodeJS.ProcessEnv = process.env): Run {
  let found: string | undefined
  const cwd = env.COPILOT_SESSION_CWD || undefined
  return async (args, opts) => {
    const timeoutMs = opts?.timeoutMs ?? 60_000
    if (found) return runOnce(found, args, cwd, timeoutMs)
    let failure = ''
    for (const bin of copilotCandidates(env)) {
      const r = await runOnce(bin, args, cwd, timeoutMs)
      if ('failure' in r) {
        failure = r.failure
        continue
      }
      found = bin
      return r
    }
    return { failure: failure || 'copilot was not found' }
  }
}

/** Taken unless Copilot says there is no server of that name; unknown counts as taken. */
export async function isNameTaken(run: Run, name: string): Promise<boolean> {
  const r = await run(['mcp', 'get', name])
  if ('failure' in r) return true
  return !(r.exitCode !== 0 && /Server "[^"]*" not found/i.test(r.stdout + r.stderr))
}

export type Written = { ok: true } | { ok: false; error: string }

/** Writes the entry with `copilot mcp add`. */
export async function writeEntry(run: Run, plan: CopilotPlan): Promise<Written> {
  const r = await run(plan.addArgs, { timeoutMs: 60_000 })
  if ('failure' in r) return { ok: false, error: `could not run copilot (${r.failure})` }
  if (r.exitCode !== 0) return { ok: false, error: `copilot mcp add failed: ${(r.stderr || r.stdout).trim().slice(0, 600)}` }
  return { ok: true }
}
