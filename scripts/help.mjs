#!/usr/bin/env node

// make help 的跨平台输出实现，保证 Windows / macOS / Linux 字节级一致。
// 由根目录 Makefile 的 help 目标调用，避免依赖各平台 shell 的 echo 差异。

const HELP_TEXT = [
  "Codex Retry Gateway - cross-platform make entry",
  "",
  "Usage:",
  "  make launch      install-if-needed, start gateway and open the admin UI",
  "  make install     take over current Codex provider without starting the UI",
  "  make start       start gateway only",
  "  make restart     restart gateway (start with --restart-if-running)",
  "  make stop        stop managed gateway",
  "  make restore     restore original Codex config and stop gateway",
  "  make check       verify node version and run Makefile contract tests",
  "",
  "Pass-through args (for simple flags):",
  '  make launch ARGS="--no-open"',
  "Path variables (safe for spaces and shell special characters):",
  '  make launch STATE_ROOT="D:/codex retry gateway" CODEX_CONFIG_PATH="D:/codex configs/config.toml"',
  '  make start CONFIG_PATH="D:/gateway configs/config.json" LOG_PATH="D:/gateway logs/gateway.log"',
].join("\n");

process.stdout.write(`${HELP_TEXT}\n`);
