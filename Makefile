# Codex Retry Gateway 生命周期命令
# 需要 Node.js 18+ 和 GNU Make（Windows 可使用 mingw32-make 或 make）。

NODE ?= node
ARGS ?=
STATE_ROOT ?=
CODEX_CONFIG_PATH ?=

STATE_ROOT_ARGS = $(if $(strip $(STATE_ROOT)),--state-root "$(STATE_ROOT)")
CODEX_CONFIG_ARGS = $(if $(strip $(CODEX_CONFIG_PATH)),--codex-config-path "$(CODEX_CONFIG_PATH)")

.PHONY: help stop stop-only restore

.DEFAULT_GOAL := help

help:
	"$(NODE)" ./scripts/help.mjs

# stop 是默认安全关闭：恢复受管配置并停止 gateway。
stop:
	"$(NODE)" ./scripts/restore-codex-config.mjs $(STATE_ROOT_ARGS) $(CODEX_CONFIG_ARGS) $(ARGS)

# 仅在需要停止 gateway 但保留当前路由接管时使用 stop-only。
stop-only:
	"$(NODE)" ./scripts/stop-gateway.mjs $(STATE_ROOT_ARGS) $(ARGS)

# 保留显式 restore 名称，便于脚本和偏好长命令名的用户使用。
restore:
	"$(NODE)" ./scripts/restore-codex-config.mjs $(STATE_ROOT_ARGS) $(CODEX_CONFIG_ARGS) $(ARGS)
