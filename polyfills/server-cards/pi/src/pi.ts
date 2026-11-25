// Pi's part: a card becomes CLI arguments and a session registration. The
// shared planner keeps the card, input, address and secret-reference rules.
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { hasMarkup, type ServerCard } from '../../claude-code/mod/hooks/card'
import { planAdd, type Plan, type PlanResult } from '../../claude-code/mod/hooks/configure'

export type PiAPI = Pick<ExtensionAPI, 'exec' | 'registerMcpServer' | 'getMcpServers'>
export type PiPlan = Pick<Plan, 'name' | 'url' | 'envVars'> & {
  headers: Record<string, string>
  addArgs: string[]
}

export function planForPi(card: ServerCard, remote: number, values: Record<string, string>, name: string | undefined, fromLocal: boolean):
  { plan: PiPlan } | Exclude<PlanResult, { plan: Plan }> {
  if (name !== undefined && !/^[A-Za-z0-9_-]+$/.test(name))
    return { error: 'A Pi server name may contain only letters, digits, _ and -.' }
  if (name === '__proto__')
    return { error: 'Pi 1.6.0 cannot save the server name __proto__ faithfully. Choose another name.' }
  if (card.remotes?.[remote]?.type === 'sse')
    return { error: `Remote #${remote} is an SSE endpoint, and Pi connects to streamable HTTP servers only.` }
  const result = planAdd(card, remote, values, name, 'user', fromLocal)
  if (!('plan' in result)) return result
  const p = result.plan
  if (p.url.includes('${'))
    return { error: 'The card puts a secret in the URL, and Pi expands environment variables in headers, not URLs. Nothing was added.' }
  const headers: Record<string, string> = Object.create(null)
  const seen = new Set<string>()
  for (const h of p.headers) {
    if (h.name === '__proto__')
      return { error: 'Pi 1.6.0 cannot save the header __proto__ faithfully. Nothing was added.' }
    const key = h.name.toLowerCase()
    if (seen.has(key)) return { error: `The card sets the header ${h.name} twice.` }
    seen.add(key)
    if (h.value.startsWith('!'))
      return { error: `The header ${h.name} begins with !, which Pi would execute as a command. Nothing from a card may run as a command.` }
    if (hasMarkup(h.value))
      return { error: `The header ${h.name} holds \`, <, > or a square bracket, which could show as something else in the question.` }
    headers[h.name] = h.value
  }
  const serverName = name ?? p.name
  // Pi's CLI would read a name that starts with - as an option of its own (-l is --local).
  if (serverName.startsWith('-'))
    return { error: 'A Pi server name may not start with -, which Pi\'s command line reads as an option. Choose another name.' }
  const addArgs = ['mcp', 'add', serverName, '--url', p.url]
  for (const [key, value] of Object.entries(headers)) addArgs.push('--header', `${key}=${value}`)
  return { plan: { name: serverName, url: p.url, headers, envVars: p.envVars, addArgs } }
}

export function configPath(env: NodeJS.ProcessEnv = process.env) {
  const dir = env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
  return resolve(dir === '~' ? homedir() : dir.startsWith('~/') ? join(homedir(), dir.slice(2)) : dir, 'mcp.json')
}

/** Never inspect credentials or resolve header values. Unknown configuration fails closed. */
export function fileHasName(file: string, name: string): boolean {
  try {
    const config = JSON.parse(readFileSync(file, 'utf8'))
    if (!config || typeof config !== 'object' || Array.isArray(config)) return true
    const servers = config.mcpServers
    if (servers === undefined) return false
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return true
    return Object.keys(servers).some(other => sameName(other, name))
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

export function isNameTaken(pi: PiAPI, name: string, file: string, projectFile?: string) {
  return fileHasName(file, name) || (projectFile !== undefined && fileHasName(projectFile, name)) ||
    pi.getMcpServers().some(server => sameName(server.name, name))
}

/** Pi treats names that differ only in - and _ as one server (they share a tool namespace). */
const sameName = (a: string, b: string) => a.replace(/-/g, '_') === b.replace(/-/g, '_')

/** Only the CLI that launched this Pi, verified against its package's bin entry. No PATH guesses. */
export function runningPiCli(argv: readonly string[] = process.argv): string | undefined {
  try {
    if (!argv[1]) return undefined
    const cli = realpathSync(argv[1])
    if (basename(cli) !== 'cli.js') return undefined
    let dir = dirname(cli)
    for (let i = 0; i < 4; i++, dir = dirname(dir)) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        if (pkg.name === '@earendil-works/pi-coding-agent' && typeof pkg.bin?.pi === 'string' &&
            realpathSync(resolve(dir, pkg.bin.pi)) === cli) return cli
      } catch { /* the package can be above dist/bundle */ }
    }
  } catch { /* a library host has no Pi CLI */ }
  return undefined
}

export async function writeEntry(pi: PiAPI, cli: string, plan: PiPlan, cwd: string, signal?: AbortSignal) {
  const r = await pi.exec(process.execPath, [cli, ...plan.addArgs], { cwd, signal, timeout: 15_000, maxBuffer: 64 * 1024 })
  // Do not echo subprocess output: Pi or another extension may have written credentials there.
  if (r.code !== 0 || r.killed) return { ok: false as const, error: `pi mcp add did not finish successfully (exit ${r.code}). Check mcp.json before trying again.` }
  try {
    pi.registerMcpServer(plan.name, { url: plan.url, ...(Object.keys(plan.headers).length ? { headers: plan.headers } : {}) })
    return { ok: true as const, registered: true }
  } catch {
    return { ok: true as const, registered: false }
  }
}
