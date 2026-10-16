#!/usr/bin/env bash
# Copyright (c) 2026 9Ashwin
# SPDX-License-Identifier: MIT
#
# 把 5 个包发到 npm：4 个平台包 + 主包（转发脚本）。
#
# 顺序很重要：**先发平台包再发主包**。反过来的话，先装到主包的人会因为平台包还不存在
# 而拿不到二进制（optionalDependencies 缺了不报错，只是静默少一个 —— 表现是
# 「装上了但跑不起来」）。
#
# 用法：scripts/publish-npm.sh [--dry-run]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=""
[ "${1:-}" = "--dry-run" ] && DRY_RUN="--dry-run"

VERSION="$(node -p "require('$ROOT/package.json').version")"
PLATFORMS=(darwin-arm64 darwin-x64 linux-arm64 linux-x64)

echo "发布 flow-one $VERSION 到 npm$([ -n "$DRY_RUN" ] && echo '（dry-run）')"

# 1) 必须已登录：发布用的是**你的**账号，脚本不代你认证
if [ -z "$DRY_RUN" ] && ! npm whoami >/dev/null 2>&1; then
  echo "还没登录 npm。先跑一次：npm login" >&2
  exit 1
fi
[ -n "$DRY_RUN" ] || echo "  已登录：$(npm whoami)"

# 2) 发布前自检：四个平台包都在、版本号一致、二进制都在
node "$ROOT/npm/verify-packaging.js"

# 3) 已发布过的版本直接跳过，而不是撞一个 cannot publish over existing version
publish() {
  local dir="$1" label="$2"
  local name
  name="$(node -p "require('$dir/package.json').name")"
  if npm view "$name@$VERSION" version >/dev/null 2>&1; then
    echo "  跳过 $name@${VERSION}（已经发布过）"
    return 0
  fi
  echo "  → 发布 ${label}（$name@${VERSION}）"
  ( cd "$dir" && npm publish --access public $DRY_RUN )
}

for platform in "${PLATFORMS[@]}"; do
  publish "$ROOT/npm/packages/$platform" "平台包 $platform"
done
publish "$ROOT" "主包 flow-one"

echo
echo "发布完成。验证一条真实安装："
echo "  npm install -g flow-one && fo --version"
