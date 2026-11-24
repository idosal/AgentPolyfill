// Antigravity's side of an addition: a card's remote as an `mcpServers` entry,
// and the file it goes in.
//
// Antigravity (App, CLI and IDE) reads one personal MCP configuration,
// ~/.gemini/config/mcp_config.json, for all your projects. It has no command
// that adds a server (no `agy mcp add`), so the entry is written into that
// file, keeping everything else in it as it is.
//
// A remote server is `{ "serverUrl": ..., "headers": {...} }`. Antigravity
// signs in to an OAuth server itself (Customizations > Installed > MCP Servers
// > Authenticate) and keeps the token in its own store, which the plugin never
// reads. It documents no ${VAR} expansion in this file, so a card whose URL or
// header needs a secret can't be added without writing the secret, and the
// plugin never writes one: the person adds such a server by hand.

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { hasMarkup, type ServerCard } from '../../claude-code/mod/hooks/card'
import { planAdd, type Plan } from '../../claude-code/mod/hooks/configure'
import { writePrivate } from './gate'

export type AntigravityPlan = {
  name: string
  url: string
  headers: Record<string, string>
  /** the entry as it is written under `mcpServers` */
  entry: { serverUrl: string; headers?: Record<string, string> }
}

export type AntigravityPlanResult =
  | { plan: AntigravityPlan }
  | { missing: { input: string; description?: string; choices?: string[] }[] }
  | { error: string }

/** The file Antigravity keeps your MCP servers in. */
export const configPath = (env: NodeJS.ProcessEnv = process.env) => join(env.HOME || homedir(), '.gemini', 'config', 'mcp_config.json')

/** How to take an entry out again, as the person would. */
export const undoText = (name: string, file: string) =>
  `delete the server in Customizations > Installed > MCP Servers, or remove "${name}" under mcpServers in ${file}`

/** The secret a plan would need written as a value, by its input name, or undefined. */
const secretIn = (p: Plan) => p.envVars.find(v => p.url.includes(`\${${v.name}}`) || p.headers.some(h => h.value.includes(`\${${v.name}}`)))

/**
 * The card's remote as an Antigravity entry: planAdd's checks (inputs, `$`,
 * the URL rules, no private remote from a public card), then Antigravity's own
 * limits.
 */
export const planForAntigravity = (
  card: ServerCard,
  remoteIndex: number,
  values: Record<string, string>,
  name: string | undefined,
  fromLocal: boolean,
): AntigravityPlanResult => {
  const remote = card.remotes?.[remoteIndex]
  if (remote?.type === 'sse')
    return { error: `Remote #${remoteIndex} is an SSE endpoint, and Antigravity's serverUrl connects to streamable HTTP servers only.` }
  const planned = planAdd(card, remoteIndex, values, name, 'user', fromLocal)
  if (!('plan' in planned)) return planned
  const p = planned.plan
  const secret = secretIn(p)
  if (secret || p.url.includes('${'))
    return {
      error:
        `The card needs a secret (${secret ? `${secret.name}, for ${secret.for}` : 'in its URL'}), and Antigravity's mcp_config.json reads no environment variable, so the plugin would have to write the secret itself, which it never does. ` +
        `The person can add it by hand: in Customizations > Installed > MCP Servers, or in ${'~/.gemini/config/mcp_config.json'}, with serverUrl ${p.url.replace(/\$\{[A-Z0-9_]+\}/g, '<value>')}.`,
    }
  const headers: Record<string, string> = {}
  for (const h of p.headers) {
    if (Object.keys(headers).some(k => k.toLowerCase() === h.name.toLowerCase())) return { error: `The card sets the header ${h.name} twice.` }
    // A fixed value is shown in the question as it is: no markup a host could
    // render as something else (security review C4).
    if (hasMarkup(h.value)) return { error: `The header ${h.name} holds \`, <, > or a square bracket (${h.value}), which could show as something else in the question.` }
    headers[h.name] = h.value
  }
  const entry = { serverUrl: p.url, ...(Object.keys(headers).length ? { headers } : {}) }
  return { plan: { name: p.name, url: p.url, headers, entry } }
}

export type McpConfig = { mcpServers: Record<string, unknown>; [k: string]: unknown }

/** The configuration as it is on disk: absent is empty, unreadable is an error (never overwritten). */
export function readConfig(file: string): { config: McpConfig } | { error: string } {
  if (!existsSync(file)) return { config: { mcpServers: {} } }
  let parsed: unknown
  try {
    const text = readFileSync(file, 'utf8').replace(/^﻿/, '')
    parsed = text.trim() ? JSON.parse(text) : {}
  } catch (err) {
    return { error: `${file} is not JSON the plugin can read (${err instanceof Error ? err.message : String(err)}); it was left as it is` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: `${file} does not hold a JSON object; it was left as it is` }
  const c = parsed as McpConfig
  if (c.mcpServers === undefined) c.mcpServers = {}
  if (!c.mcpServers || typeof c.mcpServers !== 'object' || Array.isArray(c.mcpServers)) return { error: `mcpServers in ${file} is not an object; it was left as it is` }
  return { config: c }
}

/** Taken unless the file says there is no server of that name; a file that can't be read counts as taken. */
export function isNameTaken(file: string, name: string): boolean {
  const r = readConfig(file)
  if ('error' in r) return true
  return Object.keys(r.config.mcpServers).some(k => k.toLowerCase() === name.toLowerCase())
}

export type Written = { ok: true } | { ok: false; error: string }

/** Adds the entry, keeping the rest of the file, in one step. Never over an existing server. */
export function writeEntry(file: string, plan: AntigravityPlan): Written {
  const r = readConfig(file)
  if ('error' in r) return { ok: false, error: r.error }
  if (Object.keys(r.config.mcpServers).some(k => k.toLowerCase() === plan.name.toLowerCase()))
    return { ok: false, error: `a server named "${plan.name}" is already in ${file}` }
  r.config.mcpServers[plan.name] = plan.entry
  try {
    // The file keeps the permissions it had; a new one is the person's alone.
    const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600
    mkdirSync(dirname(file), { recursive: true })
    writePrivate(file, `${JSON.stringify(r.config, null, 2)}\n`)
    chmodSync(file, mode)
  } catch (err) {
    return { ok: false, error: `could not write ${file} (${err instanceof Error ? err.message : String(err)})` }
  }
  return { ok: true }
}
