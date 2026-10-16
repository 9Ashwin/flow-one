# Copyright (c) 2026 9Ashwin
# SPDX-License-Identifier: MIT

BINARY  := claude-code-bridge
MODULE  := github.com/9Ashwin/claude-code-openai-bridge
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
DATE    := $(shell date +%Y-%m-%d)
LDFLAGS := -s -w -X $(MODULE)/internal/build.Version=$(VERSION) -X $(MODULE)/internal/build.Date=$(DATE)
PREFIX  ?= /usr/local

.PHONY: all build vet fmt fmt-check test install uninstall clean

all: test

# build 是本地标准构建：写 ./claude-code-bridge 并注入版本信息。
build:
	go build -trimpath -ldflags "$(LDFLAGS)" -o $(BINARY) .

vet:
	go vet ./...

fmt:
	gofmt -w .

# fmt-check 在任何文件会被 gofmt 改动时失败。与 CI 的同名检查保持一致。
fmt-check:
	@unformatted=$$(gofmt -l . | grep -v '^\.tmp/' || true); \
	if [ -n "$$unformatted" ]; then \
		echo "以下文件未格式化，请跑 make fmt："; echo "$$unformatted"; exit 1; \
	fi

# test 是收尾门禁：vet + 格式 + 全部单测。
test: vet fmt-check
	go test ./...

install: build
	install -m 0755 $(BINARY) $(PREFIX)/bin/$(BINARY)

uninstall:
	rm -f $(PREFIX)/bin/$(BINARY)

clean:
	rm -f $(BINARY)
