#!/usr/bin/env node
// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT
//
// npm 包里的转发脚本：Go 版是编译产物，这个包只负责**找到对应平台的二进制并转发调用**。
//
// 为什么不做 postinstall 下载：pnpm 与 bun 默认拦掉依赖的安装脚本（要用户显式允许），
// 而「每个平台一个可选依赖包」不需要跑任何脚本，三种包管理器都稳 —— esbuild / biome
// 都是这个做法。所以这里只做两件事：定位、spawn。

'use strict'

const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')

const PLATFORMS = {
  'darwin-arm64': 'flow-one-darwin-arm64',
  'darwin-x64': 'flow-one-darwin-x64',
  'linux-arm64': 'flow-one-linux-arm64',
  'linux-x64': 'flow-one-linux-x64',
}

function localBinary() {
  // 开发场景：仓库里直接 make build 出来的二进制优先
  const local = path.join(__dirname, '..', 'flow-one')
  return existsSync(local) ? local : undefined
}

function platformBinary() {
  const key = `${process.platform}-${process.arch}`
  const pkg = PLATFORMS[key]
  if (pkg === undefined) {
    return { error: `没有为 ${key} 预编译二进制（支持：${Object.keys(PLATFORMS).join('、')}）` }
  }
  try {
    const manifest = require.resolve(`${pkg}/package.json`)
    const binary = path.join(path.dirname(manifest), 'bin', process.platform === 'win32' ? 'flow-one.exe' : 'flow-one')
    if (!existsSync(binary)) return { error: `${pkg} 装上了，但里面没有二进制：${binary}` }
    return { binary }
  } catch {
    return { error: `缺少平台包 ${pkg}` }
  }
}

const resolved = localBinary() ?? platformBinary().binary
if (resolved === undefined) {
  const reason = localBinary() === undefined ? platformBinary().error : '未知原因'
  process.stderr.write(
    `flow-one：找不到可执行的二进制（${reason}）\n` +
      '  → 重新安装：npm install -g flow-one\n' +
      '  → 或者用 Go 自己编：go install github.com/9Ashwin/flow-one@latest\n' +
      '  → 或者从 Releases 下载对应平台的压缩包\n',
  )
  process.exit(1)
}

// stdio: 'inherit' 是必须的：这是个交互式 CLI（菜单、密钥输入、转圈都要真终端）。
const child = spawn(resolved, process.argv.slice(2), { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
child.on('error', error => {
  process.stderr.write(`flow-one：启动失败 ${error.message}\n`)
  process.exit(1)
})
