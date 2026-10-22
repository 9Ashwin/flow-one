# flow-one —— 门禁都在这儿，一条命令跑完。
#
# 为什么用一个 Makefile 收口：规范写在文档里只能靠自觉，写成命令才能一键复核。
# 提交前跑 `make verify`：语法检查 + 模块规约 + 全部单测。

NODE   ?= node
SOURCES := $(wildcard cli.mjs src/*.mjs scripts/*.mjs test/*.mjs)

.PHONY: all verify check syntax modules test run clean help

all: verify

## verify: 提交前跑这一条（语法 + 模块规约 + 全部单测）
verify: check test

## check: 语法与模块规约（不打网络、不跑用例）
check: syntax modules

## syntax: 每个文件都要能解析（拦下没被任何用例 import 到的语法错误）
syntax:
	@for file in $(SOURCES); do $(NODE) --check "$$file" || exit 1; done
	@echo "语法检查通过：$(words $(SOURCES)) 个文件"

## modules: 无循环依赖、零第三方依赖、依赖方向正确
modules:
	@$(NODE) scripts/check-modules.mjs

## test: 全部单测（node --test，零依赖）
test:
	@$(NODE) --test

## run: 本地起一次（进交互菜单）
run:
	@$(NODE) cli.mjs

clean:
	@rm -rf node_modules

## help: 列出可用目标
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  make /'
