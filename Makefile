# Codex Retry Gateway —— 跨平台统一命令入口（Windows / macOS / Linux）
#
# 设计说明：
# - scripts/ 目录下所有 *.mjs 本身就是跨平台的 Node 核心（*.ps1 / *.sh 只是平台包装），
#   因此本文件的所有目标一律直连 mjs，三个平台共用这一份 Makefile，无需任何 OS 分支。
# - 前置依赖：Node.js 18+ 与 GNU Make（Windows 可用 winget/choco/scoop 安装 make）。
# - 参数通过 ARGS 透传给底层脚本；它适合无空格的开关参数，例如：
#     make launch ARGS="--no-open"
#     make start ARGS="--restart-if-running"
# - 路径和监听参数使用 Make 变量传递，Makefile 会将它们作为环境变量交给 Node，避免空格、反斜杠及 shell 特殊字符被拆分，例如：
#     make launch STATE_ROOT="D:/codex retry gateway" CODEX_CONFIG_PATH="D:/codex configs/config.toml"
#     make start CONFIG_PATH="D:/gateway configs/config.json" LOG_PATH="D:/gateway logs/gateway.log"
# - 所有参数名使用 kebab-case（如 --no-open），与 mjs 核心的 parseOptions 保持一致。
#
# 运行时状态全部位于当前用户目录的 ~/.codex-retry-gateway，仓库目录保持干净。

NODE ?= node
ARGS ?=
CODEX_CONFIG_PATH ?=
STATE_ROOT ?=
LISTEN_HOST ?=
LISTEN_PORT ?=
CONFIG_PATH ?=
LOG_PATH ?=

# 路径通过环境变量传给 Node，避免再次经过 Windows cmd 或 POSIX shell 的参数解析。
export CODEX_CONFIG_PATH STATE_ROOT LISTEN_HOST LISTEN_PORT CONFIG_PATH LOG_PATH

.PHONY: help launch install start restart stop restore check

.DEFAULT_GOAL := help

help:
	"$(NODE)" ./scripts/help.mjs

launch:
	"$(NODE)" ./scripts/launch-ui.mjs $(ARGS)

install:
	"$(NODE)" ./scripts/install-for-current-provider.mjs $(ARGS)

start:
	"$(NODE)" ./scripts/start-gateway.mjs $(ARGS)

restart:
	"$(NODE)" ./scripts/start-gateway.mjs --restart-if-running $(ARGS)

stop:
	"$(NODE)" ./scripts/stop-gateway.mjs $(ARGS)

restore:
	"$(NODE)" ./scripts/restore-codex-config.mjs $(ARGS)

check:
	"$(NODE)" --version
	"$(NODE)" --check gateway.mjs
	"$(NODE)" --check scripts/admin-lib.mjs
	"$(NODE)" --check scripts/launch-ui.mjs
	"$(NODE)" --check scripts/install-for-current-provider.mjs
	"$(NODE)" --check scripts/start-gateway.mjs
	"$(NODE)" --check scripts/stop-gateway.mjs
	"$(NODE)" --check scripts/restore-codex-config.mjs
	"$(NODE)" --check scripts/help.mjs
	"$(NODE)" --check scripts/test-makefile.mjs
	"$(NODE)" --check scripts/sqlite-runtime.mjs
	"$(NODE)" --check scripts/test-sqlite-runtime.mjs
	"$(NODE)" ./scripts/test-sqlite-runtime.mjs
	"$(NODE)" ./scripts/test-makefile.mjs
