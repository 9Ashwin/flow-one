# flow-one — every gate lives here, one command runs them all.
#
# Why a Makefile: a convention written in prose is enforced only by discipline,
# but a convention written as a command can be re-checked on every change.
# `make verify` before committing: syntax + module contracts + types + lint +
# formatting + the whole test suite.
#
# Types, lint and formatting need devDependencies (typescript / eslint /
# prettier). Without node_modules `make check` says so and fails. That is the
# intended split: installing this package must not pull a build toolchain, so
# `node cli.ts` and `make test` stay dependency-free.
#
# Development executes TypeScript directly. `make build` produces the committed
# JavaScript snapshot installed from GitHub; `make types` only checks.

NODE   ?= node
SOURCES := $(wildcard cli.ts src/*.ts scripts/*.ts test/*.ts)
NPX    ?= npx --no-install

.PHONY: all verify build check types lint modules test format-check format dev-deps run clean help

all: verify

## verify: run before committing (static checks + the whole suite)
verify: build check test

## build: produce the JavaScript snapshot installed from GitHub
build: dev-deps
	@npm run build:dist

## check: static checks only (no network, no tests)
check: types lint modules format-check

## types: type-check the TypeScript sources (no emit)
types: dev-deps
	@$(NPX) tsc -p tsconfig.json
	@echo "Type check passed"

## lint: ESLint (only rules that catch real defects)
lint: dev-deps
	@$(NPX) eslint .

## modules: no cycles, no third-party imports, layer direction respected
modules:
	@$(NODE) scripts/check-modules.ts

## test: the whole suite (node --test discovers *.test.ts natively)
test:
	@$(NODE) --test

## format-check: code style (Prettier)
format-check: dev-deps
	@$(NPX) prettier --check "src/**/*.ts" "test/**/*.ts" "scripts/**/*.ts" "cli.ts" eslint.config.mjs

## format: rewrite files to the Prettier configuration
format: dev-deps
	@$(NPX) prettier --write "src/**/*.ts" "test/**/*.ts" "scripts/**/*.ts" "cli.ts" eslint.config.mjs

## dev-deps: check that the dev toolchain is installed
dev-deps:
	@test -d node_modules/typescript || { \
		echo "Missing dev dependencies (typescript / eslint / prettier). Run: npm install" >&2; \
		exit 1; }

## run: start the interactive menu locally
run:
	@$(NODE) cli.ts

clean:
	@rm -rf node_modules

## help: list the available targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  make /'
