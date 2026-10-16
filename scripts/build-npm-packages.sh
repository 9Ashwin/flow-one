#!/usr/bin/env bash
# Copyright (c) 2026 9Ashwin
# SPDX-License-Identifier: MIT
#
# 交叉编译四个平台并把 npm 平台包装配好。
# 用法：scripts/build-npm-packages.sh [版本号]   （默认取 package.json 的 version）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-$(node -p "require('$ROOT/package.json').version")}"
MODULE="github.com/9Ashwin/claude-code-openai-bridge"

echo "装配 npm 平台包，版本 $VERSION"

for target in darwin/arm64 darwin/amd64 linux/arm64 linux/amd64; do
  GOOS="${target%%/*}"
  GOARCH="${target##*/}"
  # npm 的架构名与 Go 不同：Go 的 amd64 在 npm 里叫 x64
  NPM_ARCH="$GOARCH"
  [ "$GOARCH" = "amd64" ] && NPM_ARCH="x64"

  DIR="$ROOT/npm/packages/$GOOS-$NPM_ARCH"
  mkdir -p "$DIR/bin"
  echo "  → $GOOS/$GOARCH  ($DIR)"
  CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" \
    go build -trimpath \
    -ldflags "-s -w -X $MODULE/internal/build.Version=$VERSION" \
    -o "$DIR/bin/claude-code-bridge" \
    "$ROOT"

  cat > "$DIR/package.json" <<JSON
{
  "name": "@9ashwin/ccb-$GOOS-$NPM_ARCH",
  "version": "$VERSION",
  "description": "claude-code-bridge 的 $GOOS-$NPM_ARCH 预编译二进制（由主包自动选中）",
  "license": "MIT",
  "os": ["$GOOS"],
  "cpu": ["$NPM_ARCH"],
  "files": ["bin/claude-code-bridge"],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/9Ashwin/claude-code-openai-bridge.git"
  }
}
JSON
done

node "$ROOT/npm/verify-packaging.js"
