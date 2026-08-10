#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH_SCRIPT="${LAUNCH_UI_SCRIPT:-$ROOT_DIR/scripts/launch-ui.sh}"
LAUNCH_BIN="${LAUNCH_UI_BIN:-bash}"
STATE_ROOT="${HOME}/.codex-retry-gateway"
ARGS=("$@")

for ((index = 0; index < ${#ARGS[@]}; index += 1)); do
  if [[ "${ARGS[index]}" == "--state-root" && $((index + 1)) -lt ${#ARGS[@]} ]]; then
    STATE_ROOT="${ARGS[index + 1]}"
    break
  fi
done

STATE_PATH="$STATE_ROOT/state.json"

run_launch() {
  if ((${#ARGS[@]} > 0)); then
    "$LAUNCH_BIN" "$LAUNCH_SCRIPT" "${ARGS[@]}" --no-open
  else
    "$LAUNCH_BIN" "$LAUNCH_SCRIPT" --no-open
  fi
}

# 首次运行允许 launch-ui 完成安装；恢复操作删除 state.json 后，守护会自然退出。
run_launch || true
while [[ -f "$STATE_PATH" ]]; do
  sleep 5
  [[ -f "$STATE_PATH" ]] || break
  run_launch || true
done
