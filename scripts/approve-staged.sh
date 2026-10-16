#!/usr/bin/env bash
# Copyright (c) 2026 9Ashwin
# SPDX-License-Identifier: MIT
#
# 批准已暂存的 flow-one 版本（npm staged publishing 的「人来过 2FA」那一步）。
#
# 为什么要单独一步：npm 现在不允许 token 直接发布新包 —— 只能先 stage，再由维护者
# 带着 2FA 批准。**这一步必须用你自己的交互式登录**（token 批准一律 404），
# 也正因为如此，任何泄露的 token 都拿不走发布权。
#
# 顺序：4 个平台包先发，主包最后。反过来的话，在窗口期装到主包的人会因为平台包还不存在
# 而拿不到二进制（optionalDependencies 缺了不报错，只是静默少一个）。
#
# 用法：bash scripts/approve-staged.sh
set -euo pipefail

if ! npm whoami >/dev/null 2>&1; then
  echo "先登录：npm login" >&2
  exit 1
fi
echo "以 $(npm whoami) 的身份批准暂存版本"

# stage list 每条是「id: … / package name: … / version: …」，把 id 与包名配起来
mapfile -t rows < <(npm stage list 2>/dev/null | awk '
  /^id:/           { id = $2 }
  /^package name:/ { printf "%s\t%s\n", $3, id }
')

if [ "${#rows[@]}" -eq 0 ]; then
  echo "暂存区是空的（都发过了，或者还没 stage）"
  exit 0
fi

main_ids=()
for row in "${rows[@]}"; do
  name="${row%%$'\t'*}"
  id="${row##*$'\t'}"
  if [ "$name" = "flow-one" ]; then
    main_ids+=("$id")   # 主包留到最后
    continue
  fi
  echo "  → 批准 $name"
  npm stage approve "$id"
done

for id in "${main_ids[@]:-}"; do
  [ -n "$id" ] || continue
  echo "  → 批准主包 flow-one"
  npm stage approve "$id"
done

echo
echo "批准完成。验证： npm view flow-one version && npm install -g flow-one && fo --version"
