#!/usr/bin/env node
/**
 * The command-line entry point.
 *
 * Four ways to run it: bare (start the reverse proxy), `login` (log into the domestic /
 * international edition), `status` (show login state), `models` (list available model
 * IDs). Login and the proxy share one credential file, so whatever
 * `ANTHROPIC_MODEL` should be after `login` can be copied straight from `models`.
 */

import process from 'node:process'
import { createRequire } from 'node:module'
import {
  SUBTYPES,
  authError,
  configError,
  exitCodeFor,
  renderError,
  toBridgeError,
  upstreamError,
  validationError,
} from './src/errors.ts'
import { USAGE, resolveConfig } from './src/config.ts'
import { credentialStatus, login } from './src/auth.ts'
import { productByName } from './src/products.ts'
import { needsLogin } from './src/sources.ts'
import { hasGoCredential } from './src/opencode.ts'
import { createDirectUpstream, createGatewayUpstream } from './src/upstreams.ts'
import { createBridgeServer } from './src/server.ts'
import { isInteractive } from './src/prompt.ts'
import { installService, serviceState } from './src/install.ts'
import { clientFlow, doctorFlow, mainMenu, setupWizard, statusFlow, switchModel, uninstallFlow } from './src/wizard.ts'
import { useFlow } from './src/use.ts'
import type { Config } from './src/config.ts'
import type { Source, Upstream } from './src/types.ts'

/** What `credentialStatus` reports back to the `status` command. */
type CredentialStatus = ReturnType<typeof credentialStatus>

/**
 * Progress and warnings always go to stderr — stdout carries success data only
 * (AGENTS.md, "output split"). Mixing logs into stdout turns `fo models | jq`
 * into a mess.
 */
function makeLogger(quiet: boolean): (message: string) => void {
  return (message: string) => {
    if (!quiet) process.stderr.write(`${message}\n`)
  }
}

/** Success data (model list, status report) goes to stdout so scripts can pipe it. */
function makeDataWriter(quiet: boolean): (message: string) => void {
  return (message: string) => {
    if (!quiet) process.stdout.write(`${message}\n`)
  }
}

/** The `login` subcommand accepts a single product line: `login cn` / `login intl`. */
function productsFor(commandArgs: string[], config: Config): Source[] {
  if (commandArgs.length === 0) return config.products
  const picked: Source[] = []
  for (const name of commandArgs) {
    const product = productByName(name)
    if (product === undefined) {
      throw validationError(SUBTYPES.UNKNOWN_SOURCE, `unknown product: ${name}`).withHint('expected cn / intl')
    }
    if (!picked.includes(product)) picked.push(product)
  }
  return picked
}

function makeUpstream(config: Config, log: (message: string) => void): Upstream {
  if (config.mode === 'gateway') return createGatewayUpstream(config)
  return createDirectUpstream(config, { log })
}

function formatExpiry(status: CredentialStatus): string {
  if (status.expiresAt === undefined) return 'expiry unknown (the server decides)'
  const left = status.expiresInMs
  const when = new Date(status.expiresAt).toLocaleString('en-CA', { hour12: false })
  if (left === undefined) return when
  const hours = Math.floor(left / 3_600_000)
  const tail = hours >= 48 ? `in ${Math.floor(hours / 24)} days` : `in ${Math.max(0, hours)} hours`
  return `${when} (${left <= 0 ? 'expired' : tail})`
}

async function commandLogin(config: Config, commandArgs: string[], log: (message: string) => void): Promise<void> {
  for (const product of productsFor(commandArgs, config)) {
    if (product.kind === 'openai') {
      throw validationError(SUBTYPES.UNKNOWN_SOURCE, `${product.label} has no browser login`).withHint(
        'expected cn / intl',
      )
    }
    await login(product, { log, file: config.credentialFile })
  }
  log('\nlogin complete. Available model IDs: flow-one models')
}

async function commandStatus(config: Config, out: (message: string) => void): Promise<void> {
  let any = false
  for (const product of config.products) {
    // The free tier needs no login; reporting it as "not logged in" sends people to
    // run a `login oc` that does not exist (`productByName` only knows cn / intl and
    // would answer "unknown product"). This happened on a real machine (2026-10-16):
    // the user followed the false lead, assumed the free tier was misconfigured, when
    // in fact the background service had simply not started.
    if (!needsLogin(product)) {
      // The status report is data (stdout), so its text is English even though the
      // same product's menu hint stays Chinese: the two have different consumers.
      out(`${product.id.padEnd(5)} ${product.label}: no login required`)
      any = true
      continue
    }
    // The Go plan wants a key, not a login, and the credential lives under the
    // `opencode-go` entry rather than `ocg` — reading it by id with
    // `credentialStatus` always comes back empty and reports "not logged in" even
    // when configured, then suggests a `login ocg` that does not exist. Same trap,
    // other half; use the predicate the wizard already has.
    if (product.auth === 'key') {
      const configured = hasGoCredential()
      out(
        `${product.id.padEnd(5)} ${product.label}: ${configured ? 'key configured' : 'no key (set one in `fo setup`)'}`,
      )
      if (configured) any = true
      continue
    }
    if (product.kind === 'openai') {
      out(`${product.id.padEnd(5)} ${product.label}: not logged in (flow-one login ${product.id})`)
      continue
    }
    const status = credentialStatus(product, { file: config.credentialFile })
    if (!status.loggedIn) {
      out(`${product.id.padEnd(5)} ${product.label}: not logged in (flow-one login ${product.id})`)
      continue
    }
    any = true
    out(`${product.id.padEnd(5)} ${product.label}: logged in${status.nickname === '' ? '' : ` · ${status.nickname}`}`)
    out(
      `      ${formatExpiry(status)}${status.refreshable ? ' · renews silently' : ' · no refresh token, re-login when expired'}`,
    )
  }
  out(`\ncredential file: ${config.credentialFile}`)
  // The report (success data) has already been written, yet no source is usable: that
  // is not a normal outcome.
  if (!any) {
    throw authError(SUBTYPES.NOT_LOGGED_IN, 'no usable source').withHint(
      'for the two Tencent lines run flow-one login; for the OpenCode Go plan set the key in fo setup',
    )
  }
}

async function commandModels(
  config: Config,
  log: (message: string) => void,
  out: (message: string) => void,
): Promise<void> {
  const upstream = makeUpstream(config, log)
  const rows = await upstream.loadModels()
  if (rows.length === 0) {
    // Not one source produced a model: that is an upstream problem, not the normal
    // outcome of "there really are no models".
    throw upstreamError(SUBTYPES.MODEL_UNAVAILABLE, 'no models were returned').withHint(
      'in direct mode run flow-one login first; in gateway mode check --upstream and the key',
    )
  }
  let current = ''
  for (const row of rows) {
    const product = row.product ?? ''
    if (product !== current) {
      current = product
      if (product !== '') out(`\n[${product}]`)
    }
    const bits = [
      row.contextWindow === undefined ? '' : `window ${row.contextWindow}`,
      row.maxOutputTokens === undefined ? '' : `output ${row.maxOutputTokens}`,
      row.supportsImages === true ? 'vision' : '',
      Array.isArray(row.efforts) && row.efforts.length > 0 ? `effort ${row.efforts.join('/')}` : '',
    ].filter(Boolean)
    out(`  ${row.id}${bits.length === 0 ? '' : `   ${bits.join(' · ')}`}`)
  }
  // The count is a log line, not data: the list stays on stdout for scripts, the
  // count goes to stderr.
  log(`\n${rows.length} models.`)
}

async function commandServe(config: Config, log: (message: string) => void): Promise<void> {
  // `--service` is the explicit "install as a background service" statement: once
  // installed the process should exit and let the service hold the port; on failure it
  // must say so. This flag used to be ignored, printing "flow-one started" and then
  // blocking in the foreground — Windows has no launchd/systemd, so the process died
  // with its terminal, the client only saw ECONNREFUSED, and the terminal line looked
  // like success (real machine, 2026-10-22).
  if (config.service === true) {
    const state = serviceState()
    if (!state.supported) {
      throw configError(
        SUBTYPES.SERVICE_UNSUPPORTED,
        `installing a background service is not supported on ${process.platform} (only launchd / systemd are implemented)`,
      ).withHint(
        'run it in the foreground: `flow-one` (keep the terminal open); or add it to your startup items, ' +
          'for example a shortcut running `flow-one` inside shell:startup on Windows',
      )
    }
    const installed = await installService({
      port: config.port,
      apiKey: config.apiKey,
      env: {
        BRIDGE_MODE: config.mode,
        ...(config.mode === 'gateway'
          ? {
              UPSTREAM_BASE_URL: config.upstream,
              ...(config.upstreamKey === '' ? {} : { UPSTREAM_API_KEY: config.upstreamKey }),
            }
          : { BRIDGE_PRODUCTS: config.products.map(product => product.id).join(',') }),
        ...(config.model === '' ? {} : { BRIDGE_MODEL: config.model }),
      },
    })
    if (!installed.ok) {
      throw configError(
        SUBTYPES.SERVICE_UNSUPPORTED,
        `the background service was not installed: ${installed.reason}`,
      ).withHint('run it in the foreground first to confirm it works: `flow-one`')
    }
    log(`background service installed (${installed.kind}): ${installed.path}`)
    for (const line of installed.notes ?? []) log(`  ${line}`)
    log(`  listening on: http://${config.host}:${config.port}`)
    return
  }

  const upstream = makeUpstream(config, log)
  const bridge = createBridgeServer({ config, upstream, log })
  const address = await bridge.listen()
  const host = address?.address === '::1' ? '[::1]' : config.host
  const base = `http://${host}:${address.port}`
  log(`flow-one started`)
  log(`  upstream: ${upstream.describe()}`)
  log(`  listening on: ${base}`)
  if (config.apiKey === '') log('  gate: not set (loopback address; a non-loopback listener needs a custom --api-key)')
  else log('  gate: enabled via --api-key / ANTHROPIC_AUTH_TOKEN')

  const rows = await upstream.loadModels().catch(() => [])
  const sample = config.model !== '' ? config.model : rows[0]?.id
  if (sample !== undefined) {
    log('\nPoint Claude Code at it like this (KEY is the --api-key above; if unset, use any non-empty value):')
    log(`  export ANTHROPIC_BASE_URL=${base}`)
    log(`  export ANTHROPIC_AUTH_TOKEN=${config.apiKey === '' ? 'any-non-empty' : config.apiKey}`)
    log(`  export ANTHROPIC_MODEL=${sample}`)
    log(`  export ANTHROPIC_SMALL_FAST_MODEL=${sample}`)
  }
  if (rows.length > 0) {
    log(`\n${rows.length} models available; the first few:`)
    for (const row of rows.slice(0, 6)) log(`  ${row.id}`)
    if (rows.length > 6) log(`  … (full list: flow-one models)`)
  }

  const shutdown = () => {
    void bridge.close().then(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  void bridge.warm()
}

/**
 * `--json` only decides how **errors** are rendered (in the Go version it was a root
 * persistent flag). It is not in config.ts's flag table yet, so it is stripped here
 * before the parser sees it.
 */
const jsonOut = process.argv.slice(2).includes('--json')

/** The version has a single source of truth in package.json: nothing else has to follow on release. */
const { version } = createRequire(import.meta.url)('./package.json')

async function main() {
  const argv = process.argv.slice(2).filter(argument => argument !== '--json')
  // The version is metadata: no credentials, no network, no menu — it must answer the
  // moment someone types it after installing.
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${version}\n`)
    return
  }
  const { help, command, commandArgs, config } = resolveConfig({ argv })
  if (help) {
    process.stdout.write(USAGE)
    return
  }
  const quiet = config.quiet === true
  const log = makeLogger(quiet)
  const out = makeDataWriter(quiet)
  if (command === 'setup')
    return await setupWizard({ service: config.service, clients: config.clients, dshReasoning: config.dshReasoning })
  if (command === 'uninstall') return await uninstallFlow()
  if (command === 'switch') return await switchModel()
  // Channel switch only: `fo use intl` — an already-configured source switches directly
  // without walking the one-shot setup again.
  if (command === 'use') return await useFlow(commandArgs[0])
  if (command === 'doctor') {
    if ((await doctorFlow()) !== 0)
      throw configError(SUBTYPES.SETTINGS_INCONSISTENT, 'the health check found problems').withHint(
        'review the diagnostic results above',
      )
    return
  }
  if (command === 'login') return await commandLogin(config, commandArgs, log)
  if (command === 'status') return await commandStatus(config, out)
  if (command === 'client') return await clientFlow()
  if (command === 'models') return await commandModels(config, log, out)

  // Bare run inside a terminal → the menu. Without arguments and without a TTY
  // (systemd, launchd, a pipe) start the service directly, so scripts and the background
  // service behave the same regardless of the menu.
  if (argv.length === 0 && isInteractive()) {
    await mainMenu()
    return
  }
  return await commandServe(config, log)
}

// The command boundary: every failure is collapsed into a contract error here, rendered
// to stderr, and the exit code is derived from the category. The exit code ignores
// subtype and message (that is what makes script branching reliable).
main().catch(error => {
  const typed = toBridgeError(error)
  process.stderr.write(renderError(typed, { json: jsonOut }))
  process.exitCode = exitCodeFor(typed.category)
})
