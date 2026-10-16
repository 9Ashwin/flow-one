#!/bin/sh
# Copyright (c) 2026 9Ashwin
# SPDX-License-Identifier: MIT
#
# 一行安装（macOS / Linux，arm64 / x64）：
#
#   curl -fsSL https://github.com/9Ashwin/flow-one/releases/latest/download/install.sh | sh
#
# 不需要 Go，也不需要 npm：直接从 Releases 取对应平台的二进制。
# 想装指定版本：FLOW_ONE_VERSION=v0.2.0 sh install.sh
# 想装到别处：  INSTALL_DIR=/usr/local/bin sh install.sh
set -eu

REPO="9Ashwin/flow-one"
VERSION="${FLOW_ONE_VERSION:-latest}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux)  OS="linux" ;;
  *) echo "只支持 macOS 与 Linux（当前：$(uname -s)）。其它平台请用 go install github.com/$REPO@latest" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64" ;;
  *) echo "不认识的架构：$(uname -m)" >&2; exit 1 ;;
esac

NAME="flow-one-$OS-$ARCH"
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/$REPO/releases/latest/download/$NAME.tar.gz"
else
  URL="https://github.com/$REPO/releases/download/$VERSION/$NAME.tar.gz"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "下载 ${NAME}（${VERSION}）"
if ! curl -fsSL "$URL" -o "$TMP/$NAME.tar.gz"; then
  echo "下载失败：$URL" >&2
  echo "→ 确认这个平台有发布产物：https://github.com/$REPO/releases" >&2
  exit 1
fi

tar -xzf "$TMP/$NAME.tar.gz" -C "$TMP"
mkdir -p "$INSTALL_DIR"
install -m 0755 "$TMP/flow-one" "$INSTALL_DIR/flow-one"
# 短命令：同一个二进制，两个名字
ln -sf "$INSTALL_DIR/flow-one" "$INSTALL_DIR/fo"

echo "已安装：$INSTALL_DIR/flow-one（以及短命令 fo）"
"$INSTALL_DIR/flow-one" --version

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo
     echo "注意：$INSTALL_DIR 不在 PATH 里。加到 shell 配置里："
     echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc && exec zsh" ;;
esac
