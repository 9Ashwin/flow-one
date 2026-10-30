// `fo use <source>`: switch straight to a source that is already configured, **without
// walking through setup again**.
//
// Why a separate module: switching is **pure orchestration** (read the ledger → touch the
// upstream model list once → write the client config → reinstall the service) with not a
// byte of interaction, so it can be asserted offline; the command entry only parses
// arguments and renders the result.
//
// ⚠️ **The mount list must be updated along with it**. The service starts without
// arguments and takes its source list from `BRIDGE_PRODUCTS`. Change only
// `ANTHROPIC_MODEL` to a prefix that is not mounted (say only `cn` was configured and now
// `ocg/…` is wanted) and the bridge hands the request to **the first mounted source** —
// the model name does not match, the upstream rejects it as before, and nothing in the UI
// shows the problem. So "switching" covers three places: the ledger, the client config,
// and the service's mount list.

import { SOURCES } from './sources.ts'
import {
  claudeSettingsPath,
  clientConfigIsOurs,
  installClaudeSettings,
  installService,
  readInstallState,
} from './install.ts'
import type { UpstreamModel } from './types.ts'

/**
 * Which model a source should use this time: **the one this line used last** wins; if
 * none was recorded, the first in recommendation order.
 *
 * "Recorded per source" is the key — one process mounts every source, and changing the
 * prefix is changing the source. Always falling back to the same default would mean
 * re-picking it every time you switch back.
 */
export function preferredModel({
  models,
  lastModels = {},
  fallback = [],
}: {
  models: UpstreamModel[]
  lastModels?: Record<string, { model: string; contextWindow?: number } | string>
  fallback?: string[]
}): string | undefined {
  const entry = lastModels?.model
  const remembered = typeof entry === 'string' ? entry : entry?.model
  if (typeof remembered === 'string' && models.some(row => row.id === remembered)) return remembered
  const rank = (id: string): number => {
    const bare = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id
    const at = fallback.findIndex(name => bare === name)
    return at === -1 ? fallback.length : at
  }
  const goOnly = models.length > 0 && models.every(model => model.id.startsWith('ocg/'))
  return [...models].sort(
    (a, b) => ((b.free === true ? 1 : 0) - (a.free === true ? 1 : 0)) * (goOnly ? -1 : 1) || rank(a.id) - rank(b.id),
  )[0]?.id
}

/** Model ID prefix → source id; returns an empty string for an unknown source (the caller reports an error on that). */
export function sourceOfModel(model: string): string {
  const raw = String(model ?? '')
  const at = raw.indexOf('/')
  if (at <= 0) return ''
  const prefix = raw.slice(0, at)
  return SOURCES.some(source => source.id === prefix) ? prefix : ''
}

/**
 * The new mount list: existing entries untouched, the target appended if missing (order preserved).
 *
 * Consistent with the accumulate semantics in setup: after switching from cn to intl, cn
 * stays mounted, so switching back needs no fresh login and no reconfiguration.
 */
export function withSource(mounted: string[] | undefined, source?: string): string[] {
  const current = Array.isArray(mounted) ? mounted : []
  if (typeof source !== 'string' || source === '' || current.includes(source)) return current
  return [...current, source]
}

/**
 * Apply this choice to both places: the Claude Code config and the background service.
 *
 * Skipping either one means "looks switched, actually is not":
 * - client config: **write back only the copy already pointing at this bridge**; not a
 *   single byte of anything that is not ours;
 * - service: it starts with `BRIDGE_MODEL` / `BRIDGE_PRODUCTS`, so without a reinstall it
 *   keeps the old ones.
 *
 */
export async function applySwitch({
  port,
  apiKey,
  model,
  contextWindow,
  source,
  mounted,
  env = {},
  settings = claudeSettingsPath(),
  install = installService,
  healthy = waitForService,
}: {
  port: number
  apiKey: string
  model: string
  contextWindow?: number
  source?: string
  mounted?: string[]
  env?: Record<string, string>
  settings?: string
  install?: typeof installService
  healthy?: (port: number, model: string) => Promise<boolean>
}): Promise<{
  written: boolean
  file?: string
  service?: { ok?: boolean; reason?: string; path?: string; kind?: string; notes?: string[] } | undefined
}> {
  const products = withSource(mounted, source)
  const written = clientConfigIsOurs({ port, file: settings })
  const state = readInstallState()
  const service =
    state.service?.path === undefined
      ? undefined
      : await install({ port, apiKey, env: serviceEnvFor({ env, model, products }) })
  if (service !== undefined && !service.ok) return { written: false, service }
  if (service !== undefined && !(await healthy(port, model))) {
    return {
      written: false,
      service: {
        ...service,
        ok: false,
        reason: 'the service did not start with the selected model; check its logs and retry',
      },
    }
  }
  if (written) {
    installClaudeSettings({
      file: settings,
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey,
      model,
      contextWindow,
    })
  }
  return { written, ...(written ? { file: settings } : {}), service }
}

async function waitForService(port: number, model: string): Promise<boolean> {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) })
      if (response.ok) {
        const health = (await response.json()) as { service?: string; model?: string }
        if (health.service === 'flow-one' && health.model === model) return true
      }
    } catch {
      /* the service may still be starting */
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

/**
 * The new service environment: carry the old one over, overriding only the keys that
 * actually changed this time.
 *
 * ⚠️ Gateway mode must **delete** `BRIDGE_PRODUCTS` rather than merely "not write" it:
 * `...env` drags along the list recorded during the previous direct-mode run, so the
 * bridge keeps routing by source prefix — and gateway model IDs have no prefix at all.
 * Nor can `{ BRIDGE_PRODUCTS: undefined }` delete it: the service file is written entry by
 * entry via `Object.entries`, which would land as the literal string "undefined".
 */
export function serviceEnvFor({
  env = {},
  model,
  products = [],
}: {
  env?: Record<string, string>
  model: string
  products?: string[]
}): Record<string, string> {
  const next: Record<string, string> = { ...env, BRIDGE_MODEL: model }
  if (env.BRIDGE_MODE === 'gateway') delete next.BRIDGE_PRODUCTS
  else next.BRIDGE_PRODUCTS = products.join(',')
  return next
}
