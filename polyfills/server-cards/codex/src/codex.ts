// Codex's side of an addition: the plan a card gives, in Codex's terms, and the
// commands that write it. Codex reads one MCP configuration,
// $CODEX_HOME/config.toml (~/.codex/config.toml), for all your projects.
//
// - A server with no headers beyond a bearer token is added with
//   `codex mcp add NAME --url URL [--bearer-token-env-var VAR]`.
// - Other headers can't be given to `codex mcp add`. Such a server is written
//   through `codex app-server`'s config/value/write (experimental), which edits
//   the same file the same way.
// - A secret is never a value: it is the name of an environment variable,
//   `bearer_token_env_var` or `env_http_headers`, named for this card alone
//   (configure.ts tag). Codex reads no ${VAR} inside a URL or a header value,
//   so a card that needs one there can't be added.

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hasMarkup, type ServerCard } from '../../claude-code/mod/hooks/card'
import { planAdd, type Plan } from '../../claude-code/mod/hooks/configure'

export type CodexPlan = {
  name: string
  url: string
  bearerEnvVar?: string
  httpHeaders: Record<string, string>
  envHttpHeaders: Record<string, string>
  envVars: Plan['envVars']
  /** `codex mcp add` arguments, when that command can write the whole entry */
  addArgs?: string[]
  /** what is written, as the TOML table Codex keeps */
  toml: string
}

export type CodexPlanResult = { plan: CodexPlan } | { missing: { input: string; description?: string; choices?: string[] }[] } | { error: string }

const ENV_REF = /^\$\{([A-Z0-9_]+)\}$/
const BEARER_REF = /^Bearer \$\{([A-Z0-9_]+)\}$/

const tomlString = (s: string) => JSON.stringify(s)
const tomlKey = (s: string) => (/^[A-Za-z0-9_-]+$/.test(s) ? s : JSON.stringify(s))

export const toToml = (p: Omit<CodexPlan, 'toml' | 'addArgs'>) => {
  const lines = [`[mcp_servers.${tomlKey(p.name)}]`, `url = ${tomlString(p.url)}`]
  if (p.bearerEnvVar) lines.push(`bearer_token_env_var = ${tomlString(p.bearerEnvVar)}`)
  const table = (t: Record<string, string>) => `{ ${Object.entries(t).map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`).join(', ')} }`
  if (Object.keys(p.httpHeaders).length) lines.push(`http_headers = ${table(p.httpHeaders)}`)
  if (Object.keys(p.envHttpHeaders).length) lines.push(`env_http_headers = ${table(p.envHttpHeaders)}`)
  return lines.join('\n')
}

/**
 * The card's remote as a Codex entry: planAdd's checks (inputs, `$`, the URL
 * rules, no private remote from a public card), then Codex's own limits.
 */
export const planForCodex = (
  card: ServerCard,
  remoteIndex: number,
  values: Record<string, string>,
  name: string | undefined,
  fromLocal: boolean,
): CodexPlanResult => {
  const remote = card.remotes?.[remoteIndex]
  if (remote?.type === 'sse')
    return { error: `Remote #${remoteIndex} is an SSE endpoint, and Codex connects to streamable HTTP servers only.` }
  const planned = planAdd(card, remoteIndex, values, name, 'local', fromLocal)
  if (!('plan' in planned)) return planned
  const p = planned.plan
  if (p.url.includes('${'))
    return { error: `The card puts a secret in the URL (${p.url}), and Codex reads no environment variable there; it can be added only by hand.` }
  let bearerEnvVar: string | undefined
  const httpHeaders: Record<string, string> = {}
  const envHttpHeaders: Record<string, string> = {}
  const seen = new Set<string>()
  for (const h of p.headers) {
    const lower = h.name.toLowerCase()
    if (seen.has(lower)) return { error: `The card sets the header ${h.name} twice.` }
    seen.add(lower)
    const bearer = BEARER_REF.exec(h.value)
    const whole = ENV_REF.exec(h.value)
    if (lower === 'authorization' && bearer) bearerEnvVar = bearer[1]
    else if (whole) envHttpHeaders[h.name] = whole[1]!
    else if (h.value.includes('${'))
      return {
        error: `The header ${h.name} mixes a secret with other text (${h.value}). Codex takes a header's whole value from one environment variable, or a bearer token; this card's header can be added only by hand.`,
      }
    // A fixed value is shown in the form as it is: no markup a host could
    // render as something else.
    else if (hasMarkup(h.value))
      return { error: `The header ${h.name} holds \`, <, > or a square bracket (${h.value}), which could show as something else in the form.` }
    else httpHeaders[h.name] = h.value
  }
  const base = { name: p.name, url: p.url, bearerEnvVar, httpHeaders, envHttpHeaders, envVars: p.envVars }
  const plain = !Object.keys(httpHeaders).length && !Object.keys(envHttpHeaders).length
  return {
    plan: {
      ...base,
      addArgs: plain ? ['mcp', 'add', p.name, '--url', p.url, ...(bearerEnvVar ? ['--bearer-token-env-var', bearerEnvVar] : [])] : undefined,
      toml: toToml(base),
    },
  }
}

/** The file Codex keeps its MCP servers in. */
export const configPath = (env: NodeJS.ProcessEnv = process.env) => join(env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml')

export type Ran = { exitCode: number; stdout: string; stderr: string; stopped?: boolean }
export type Run = (args: readonly string[], opts?: { stopOn?: RegExp; input?: string; timeoutMs?: number; keepOpen?: boolean }) => Promise<Ran | { failure: string }>

/** Where `codex` is: the desktop app's CODEX_CLI_PATH, PATH, then the usual install places. */
export const codexCandidates = (env: NodeJS.ProcessEnv = process.env) => [
  ...(env.CODEX_CLI_PATH ? [env.CODEX_CLI_PATH] : []),
  'codex',
  ...(env.HOME ? [`${env.HOME}/.local/bin/codex`] : []),
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
]

const runOnce = (bin: string, args: readonly string[], opts: Parameters<Run>[1] = {}) =>
  new Promise<Ran | { failure: string }>(resolve => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
    } catch (err) {
      return resolve({ failure: err instanceof Error ? err.message : String(err) })
    }
    let stdout = ''
    let stderr = ''
    let stopped = false
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 60_000)
    child.stdout!.on('data', d => {
      stdout += d
      if (opts.stopOn?.test(stdout) && !stopped) {
        stopped = true
        child.kill('SIGKILL')
      }
    })
    child.stderr!.on('data', d => (stderr += d))
    child.on('error', err => {
      clearTimeout(timer)
      resolve({ failure: err.message })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? -1, stdout, stderr, stopped })
    })
    if (opts.input !== undefined) child.stdin!.write(opts.input)
    if (!opts.keepOpen) child.stdin!.end()
  })

export function codexRunner(env: NodeJS.ProcessEnv = process.env): Run {
  let found: string | undefined
  return async (args, opts) => {
    if (found) return runOnce(found, args, opts)
    let failure = ''
    for (const bin of codexCandidates(env)) {
      const r = await runOnce(bin, args, opts)
      if ('failure' in r) {
        failure = r.failure
        continue
      }
      found = bin
      return r
    }
    return { failure: failure || 'codex was not found' }
  }
}

/** Taken unless Codex says there is no server of that name; unknown counts as taken. */
export async function isNameTaken(run: Run, name: string): Promise<boolean> {
  const r = await run(['mcp', 'get', name, '--json'])
  if ('failure' in r) return true
  return !(r.exitCode !== 0 && /No MCP server named/i.test(r.stdout + r.stderr))
}

/**
 * Writes one entry through `codex app-server` (stdio): initialize, then
 * config/value/write. Used only for headers `codex mcp add` can't set.
 */
export async function writeWithAppServer(run: Run, plan: CodexPlan): Promise<{ ok: true } | { error: string }> {
  const value: Record<string, unknown> = { url: plan.url }
  if (plan.bearerEnvVar) value.bearer_token_env_var = plan.bearerEnvVar
  if (Object.keys(plan.httpHeaders).length) value.http_headers = plan.httpHeaders
  if (Object.keys(plan.envHttpHeaders).length) value.env_http_headers = plan.envHttpHeaders
  const input =
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'mcp-server-cards', version: '0.1.0' } } },
      { jsonrpc: '2.0', method: 'initialized' },
      { jsonrpc: '2.0', id: 2, method: 'config/value/write', params: { keyPath: `mcp_servers.${plan.name}`, mergeStrategy: 'upsert', value } },
    ]
      .map(m => JSON.stringify(m))
      .join('\n') + '\n'
  const r = await run(['app-server'], { input, keepOpen: true, stopOn: /"id":2,"(result|error)"/, timeoutMs: 30_000 })
  if ('failure' in r) return { error: `could not run codex app-server (${r.failure})` }
  const line = r.stdout.split('\n').find(l => /"id":2,/.test(l))
  if (!line) return { error: `codex app-server gave no answer${r.stderr ? `: ${r.stderr.trim().slice(0, 300)}` : ''}` }
  try {
    const m = JSON.parse(line)
    if (m.error) return { error: `codex app-server refused the write: ${String(m.error.message ?? m.error.code).slice(0, 300)}` }
    if (m.result?.status !== 'ok') return { error: `codex app-server answered ${JSON.stringify(m.result).slice(0, 300)}` }
  } catch {
    return { error: 'codex app-server gave an answer that is not JSON' }
  }
  return { ok: true }
}

export type Written = { ok: true; needsSignIn: boolean; how: string } | { ok: false; error: string }

/**
 * Writes the entry. `codex mcp add` starts a sign-in by itself when the server
 * offers OAuth ("Detected OAuth support. Starting OAuth flow"), opening a
 * browser and waiting for it, which a tool call can't do. The entry is written
 * before that line is printed, so the command is stopped there and the person
 * signs in with `codex mcp login NAME`, as Codex itself tells them to.
 */
export async function writeEntry(run: Run, plan: CodexPlan): Promise<Written> {
  if (plan.addArgs) {
    const r = await run(plan.addArgs, { stopOn: /Detected OAuth support/i, timeoutMs: 60_000 })
    if ('failure' in r) return { ok: false, error: `could not run codex (${r.failure})` }
    if (r.stopped) {
      if (await isNameTaken(run, plan.name)) return { ok: true, needsSignIn: true, how: 'codex mcp add' }
      return { ok: false, error: 'codex mcp add was stopped at its sign-in, and the entry is not there' }
    }
    if (r.exitCode !== 0) return { ok: false, error: `codex mcp add failed: ${(r.stderr || r.stdout).trim().slice(0, 600)}` }
    return { ok: true, needsSignIn: false, how: 'codex mcp add' }
  }
  const w = await writeWithAppServer(run, plan)
  if ('error' in w) return { ok: false, error: w.error }
  if (!(await isNameTaken(run, plan.name))) return { ok: false, error: 'the entry was written, but codex mcp get does not see it' }
  return { ok: true, needsSignIn: false, how: 'codex app-server config/value/write' }
}
