# Codex Retry Gateway 生命周期命令
# 需要 Node.js 18+ 和 GNU Make（Windows 可使用 mingw32-make 或 make）。

NODE ?= node
ARGS ?=
STATE_ROOT ?=
CODEX_CONFIG_PATH ?=

STATE_ROOT_ARGS = $(if $(strip $(STATE_ROOT)),--state-root "$(STATE_ROOT)")
CODEX_CONFIG_ARGS = $(if $(strip $(CODEX_CONFIG_PATH)),--codex-config-path "$(CODEX_CONFIG_PATH)")

.PHONY: help stop restore

.DEFAULT_GOAL := help

help:
	@echo "Use: make stop [STATE_ROOT=...]"
	@echo "Use: make restore [STATE_ROOT=...] [CODEX_CONFIG_PATH=...]"

stop:
	"$(NODE)" ./scripts/stop-gateway.mjs $(STATE_ROOT_ARGS) $(ARGS)

restore:
	"$(NODE)" ./scripts/restore-codex-config.mjs $(STATE_ROOT_ARGS) $(CODEX_CONFIG_ARGS) $(ARGS)
