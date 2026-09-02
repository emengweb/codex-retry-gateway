#!/usr/bin/env node

const HELP_TEXT = [
  "Codex Retry Gateway - lifecycle commands",
  "",
  "Usage:",
  "  make stop        restore original config and stop the gateway",
  "  make stop-only   stop the gateway without restoring configuration",
  "  make restore     restore original config and stop the gateway",
  "",
  "Path variables:",
  '  make stop STATE_ROOT="D:/codex retry gateway"',
  '  make restore STATE_ROOT="D:/codex retry gateway" CODEX_CONFIG_PATH="D:/codex config.toml"',
].join("\n");

process.stdout.write(`${HELP_TEXT}\n`);
