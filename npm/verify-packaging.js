#!/usr/bin/env node
// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT
//
// 发布前的自检：平台包与主包的版本号必须一致、四个平台都要在 optionalDependencies 里。
// 版本号对不上是这类「主包 + 平台包」方案最常见的翻车方式（装完找不到二进制）。

'use strict'

const { readFileSync, existsSync } = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const expected = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
const problems = []

for (const platform of expected) {
  const name = `@ashwin99/flow-one-${platform}`
  const declared = main.optionalDependencies?.[name]
  if (declared === undefined) {
    problems.push(`optionalDependencies 缺少 ${name}`)
    continue
  }
  if (declared !== main.version) {
    problems.push(`${name} 版本 ${declared} 与主包 ${main.version} 不一致`)
  }
  const dir = path.join(root, 'npm', 'packages', platform)
  if (!existsSync(path.join(dir, 'package.json'))) {
    problems.push(`缺少平台包目录 npm/packages/${platform}/package.json（发布前跑 scripts/build-npm-packages.sh）`)
    continue
  }
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  if (manifest.version !== main.version) {
    problems.push(`${name} 的 package.json 版本 ${manifest.version} 与主包不一致`)
  }
  if (!existsSync(path.join(dir, 'bin', 'flow-one'))) {
    problems.push(`${name} 里没有二进制（发布前跑 scripts/build-npm-packages.sh）`)
  }
}

if (problems.length > 0) {
  process.stderr.write(`npm 打包自检未通过：\n  - ${problems.join('\n  - ')}\n`)
  process.exit(1)
}
process.stdout.write('npm 打包自检通过：四个平台的二进制与版本号都对得上\n')
