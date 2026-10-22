#!/usr/bin/env node
/**
 * 模块规约检查（进 make check，CI 与本地都跑）。
 *
 * 为什么需要机器兜住：ESM 下的循环依赖表现为 TDZ 报错
 * （`Cannot access 'OPENCODE' before initialization`），报错点离真正的成因很远，
 * 人肉 review 很容易放过。这里把四条规约变成可执行的断言：
 *
 *   1. 没有循环依赖
 *   2. 只允许 `node:` 内置模块与相对路径 —— **零第三方依赖**是硬约束
 *   3. 依赖方向只能由下层指向上层（见 LAYERS）
 *   4. 文件超过软上限时提醒（提醒，不失败）
 *
 * 用法：node scripts/check-modules.mjs [--strict]
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// 别用 `import.meta.dirname`：那是 Node 20.11+ 才有的，CI 的 18.20 上会拿到 undefined，
// 报成一句 `The "paths[0]" argument must be of type string`（真被 CI 逮过一次）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STRICT = process.argv.includes('--strict')
const SIZE_SOFT_LIMIT = 500

/**
 * 分层：**只允许从下层 import 上层**（数字小的可以被数字大的依赖，反之不行）。
 *
 * 这不是审美问题：反向依赖一旦出现，最后必然绕成环。home.mjs 就是为了打断
 * 「config ↔ opencode」那一环才单独成模块的。
 */
const LAYERS = new Map([
  // 0 工具层：互不依赖，谁都可以用
  ['src/home.mjs', 0],
  ['src/sse.mjs', 0],
  ['src/products.mjs', 0],
  ['src/prompt.mjs', 0],
  ['src/anthropic.mjs', 0],
  ['src/fingerprint.mjs', 0],
  ['src/errors.mjs', 0],
  ['src/atomic.mjs', 0],
  // 1 来源层：各自实现一条上游
  ['src/auth.mjs', 1],
  ['src/buddy.mjs', 1],
  ['src/opencode.mjs', 1],
  // 2 来源表与配置：config 是来源表的**消费者**（它要按来源算默认模型），方向是 2 → 2
  ['src/sources.mjs', 2],
  ['src/config.mjs', 2],
  // 3 装配层：把来源拼成一套
  ['src/install.mjs', 3],
  ['src/dsh.mjs', 3],
  ['src/upstreams.mjs', 3],
  ['src/server.mjs', 3],
  // 4 检查
  ['src/doctor.mjs', 4],
  // 5 交互
  ['src/wizard.mjs', 5],
  // 6 顶端
  ['cli.mjs', 6],
])

function listModules() {
  const files = fs.readdirSync(path.join(ROOT, 'src'))
    .filter(name => name.endsWith('.mjs'))
    .map(name => `src/${name}`)
  if (fs.existsSync(path.join(ROOT, 'cli.mjs'))) files.push('cli.mjs')
  return files
}

function importsOf(relative) {
  const text = fs.readFileSync(path.join(ROOT, relative), 'utf8')
  const found = []
  for (const match of text.matchAll(/(?:^|\n)\s*import[^\n]*?from\s+'([^']+)'/g)) {
    found.push(match[1])
  }
  for (const match of text.matchAll(/(?:^|\n)\s*import\s+'([^']+)'/g)) {
    found.push(match[1])
  }
  return found
}

function resolveImport(fromRelative, specifier) {
  if (!specifier.startsWith('.')) return { external: specifier }
  const base = path.posix.join(path.posix.dirname(fromRelative), specifier)
  const candidates = [base, `${base}.mjs`, path.posix.join(base, 'index.mjs')]
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(ROOT, candidate))) return { module: candidate }
  }
  return { missing: base }
}

const modules = listModules()
const graph = new Map()
const problems = []
const warnings = []

for (const module of modules) {
  const edges = []
  for (const specifier of importsOf(module)) {
    const resolved = resolveImport(module, specifier)
    if (resolved.external !== undefined) {
      // 零依赖：只有 node: 内置模块是允许的
      if (!resolved.external.startsWith('node:')) {
        problems.push(`${module} 引用了第三方模块 '${resolved.external}' —— 本项目零依赖，只允许 node: 内置模块与相对路径`)
      }
      continue
    }
    if (resolved.missing !== undefined) {
      problems.push(`${module} 引用了不存在的文件 '${specifier}'（解析到 ${resolved.missing}）`)
      continue
    }
    edges.push(resolved.module)

    const fromLayer = LAYERS.get(module)
    const toLayer = LAYERS.get(resolved.module)
    if (fromLayer !== undefined && toLayer !== undefined && toLayer > fromLayer) {
      problems.push(`${module}（第 ${fromLayer} 层）依赖了 ${resolved.module}（第 ${toLayer} 层）—— 依赖方向只能由下层指向上层，反向会绕成环`)
    }
    if (fromLayer === undefined) warnings.push(`${module} 不在 LAYERS 表里，请补上它的层级`)
  }
  graph.set(module, edges)

  const lines = fs.readFileSync(path.join(ROOT, module), 'utf8').split('\n').length
  if (lines > SIZE_SOFT_LIMIT) {
    warnings.push(`${module} 有 ${lines} 行（软上限 ${SIZE_SOFT_LIMIT}）：先想办法拆函数或拆模块，别靠分包解决`)
  }
}

// 循环检测：DFS 三色标记，报告具体环路（比一句「有环」有用得多）
const state = new Map()
const cycles = []
function visit(module, trail) {
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
for (const cycle of cycles) problems.push(`循环依赖：${cycle}`)

for (const warning of warnings) process.stderr.write(`! ${warning}\n`)
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`✖ ${problem}\n`)
  process.exit(1)
}
process.stdout.write(`模块规约检查通过：${modules.length} 个模块，无循环依赖、零第三方依赖、依赖方向正确\n`)
if (STRICT && warnings.length > 0) process.exit(1)
