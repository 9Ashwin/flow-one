#!/usr/bin/env node
/**
 * Module-contract check. Runs as part of `make check`, locally and in CI.
 *
 * Why a machine has to enforce this: a circular import under ESM surfaces as a
 * TDZ error (`Cannot access 'OPENCODE' before initialization`), and the reported
 * site is far from the actual cause — human review misses it reliably. The four
 * contracts are therefore expressed as assertions:
 *
 *   1. no circular dependencies
 *   2. only `node:` built-ins and relative paths — **zero third-party dependencies**
 *   3. dependencies point from lower layers to higher layers only (see LAYERS)
 *   4. files above the soft size limit are reported (reported, not failed)
 *
 * Usage: node scripts/check-modules.ts [--strict]
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// `import.meta.dirname` is deliberately avoided: it only exists from Node 20.11,
// so CI's 18.20 would read `undefined` and fail with a misleading
// `The "paths[0]" argument must be of type string` (this was caught by CI once).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STRICT = process.argv.includes('--strict')
const SIZE_SOFT_LIMIT = 500

/**
 * Layers: **a module may only import from its own layer or a lower one** (a
 * smaller number may be depended on by a larger one, not the other way round).
 *
 * This is not aesthetics. A reverse dependency inevitably turns into a cycle.
 * `home.ts` exists as its own module purely to break the `config ↔ opencode`
 * cycle.
 */
const LAYERS = new Map<string, number>([
  // Layer 0 — utilities. Independent of each other; anyone may use them.
  // `types.ts` is types only (no runtime imports), so it cannot form a cycle.
  ['src/types.ts', 0],
  ['src/home.ts', 0],
  ['src/sse.ts', 0],
  ['src/products.ts', 0],
  ['src/prompt.ts', 0],
  ['src/anthropic.ts', 0],
  ['src/fingerprint.ts', 0],
  ['src/errors.ts', 0],
  ['src/atomic.ts', 0],
  // Layer 1 — source adapters. Each implements one upstream.
  ['src/auth.ts', 1],
  ['src/buddy.ts', 1],
  ['src/opencode.ts', 1],
  // Layer 2 — source table and configuration. `config` is a *consumer* of the
  // source table (it derives default models per source), hence 2 → 2.
  ['src/sources.ts', 2],
  ['src/config.ts', 2],
  // Layer 3 — assembly. Turns sources into one upstream.
  ['src/install.ts', 3],
  ['src/dsh.ts', 3],
  ['src/upstreams.ts', 3],
  ['src/server.ts', 3],
  // Layer 4 — checks and switching orchestration. Switching only touches files
  // and the ledger; interaction stays in layer 5.
  ['src/doctor.ts', 4],
  ['src/switch.ts', 4],
  // Layer 5 — interaction. `use` only switches to one source; persisting the
  // change belongs to `switch.ts`.
  ['src/wizard.ts', 5],
  ['src/use.ts', 5],
  // Layer 6 — entry point.
  ['cli.ts', 6],
])

function listModules(): string[] {
  const files = fs
    .readdirSync(path.join(ROOT, 'src'))
    .filter(name => name.endsWith('.ts'))
    .map(name => `src/${name}`)
  if (fs.existsSync(path.join(ROOT, 'cli.ts'))) files.push('cli.ts')
  return files
}

function importsOf(relative: string): string[] {
  const text = fs.readFileSync(path.join(ROOT, relative), 'utf8')
  const found: string[] = []
  for (const match of text.matchAll(/(?:^|\n)\s*import[^\n]*?from\s+'([^']+)'/g)) {
    found.push(match[1])
  }
  for (const match of text.matchAll(/(?:^|\n)\s*import\s+'([^']+)'/g)) {
    found.push(match[1])
  }
  return found
}

/** A relative specifier is resolved to an on-disk module, or reported missing. */
type ResolvedImport = { external: string } | { module: string } | { missing: string }

function resolveImport(fromRelative: string, specifier: string): ResolvedImport {
  if (!specifier.startsWith('.')) return { external: specifier }
  const base = path.posix.join(path.posix.dirname(fromRelative), specifier)
  const candidates = [base, `${base}.ts`, path.posix.join(base, 'index.ts')]
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(ROOT, candidate))) return { module: candidate }
  }
  return { missing: base }
}

const modules = listModules()
const graph = new Map<string, string[]>()
const problems: string[] = []
const warnings: string[] = []

for (const module of modules) {
  const edges: string[] = []
  for (const specifier of importsOf(module)) {
    const resolved = resolveImport(module, specifier)
    if ('external' in resolved) {
      // Zero dependencies: only `node:` built-ins are allowed.
      if (!resolved.external.startsWith('node:')) {
        problems.push(
          `${module} imports the third-party module '${resolved.external}' — this project has zero dependencies; only node: built-ins and relative paths are allowed`,
        )
      }
      continue
    }
    if ('missing' in resolved) {
      problems.push(`${module} imports a file that does not exist: '${specifier}' (resolved to ${resolved.missing})`)
      continue
    }
    const target = resolved.module
    edges.push(target)

    const fromLayer = LAYERS.get(module)
    const toLayer = LAYERS.get(target)
    if (fromLayer !== undefined && toLayer !== undefined && toLayer > fromLayer) {
      problems.push(
        `${module} (layer ${fromLayer}) depends on ${target} (layer ${toLayer}) — dependencies may only point from lower layers to higher ones; the reverse eventually forms a cycle`,
      )
    }
    if (fromLayer === undefined) warnings.push(`${module} is missing from the LAYERS table; add its layer`)
  }
  graph.set(module, edges)

  const lines = fs.readFileSync(path.join(ROOT, module), 'utf8').split('\n').length
  if (lines > SIZE_SOFT_LIMIT) {
    warnings.push(
      `${module} is ${lines} lines (soft limit ${SIZE_SOFT_LIMIT}): split functions or modules — a new package is not the answer`,
    )
  }
}

// Cycle detection: DFS with three-colour marking, reporting the concrete cycle
// (far more useful than a bare "there is a cycle").
const state = new Map<string, 'visiting' | 'done'>()
const cycles: string[] = []
function visit(module: string, trail: string[]): void {
  state.set(module, 'visiting')
  for (const next of graph.get(module) ?? []) {
    if (state.get(next) === 'visiting') {
      cycles.push([...trail.slice(trail.indexOf(next)), next].join(' → '))
      continue
    }
    if (!state.has(next)) visit(next, [...trail, next])
  }
  state.set(module, 'done')
}
for (const module of modules) if (!state.has(module)) visit(module, [module])
for (const cycle of cycles) problems.push(`circular dependency: ${cycle}`)

for (const warning of warnings) process.stderr.write(`! ${warning}\n`)
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`✖ ${problem}\n`)
  process.exit(1)
}
process.stdout.write(
  `Module contracts OK: ${modules.length} modules, no cycles, zero third-party dependencies, layer direction respected\n`,
)
if (STRICT && warnings.length > 0) process.exit(1)
