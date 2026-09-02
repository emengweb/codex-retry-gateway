#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="node"
ARGS=("$@")
if command -v node.exe >/dev/null 2>&1; then
  NODE_BIN="node.exe"
  if command -v wslpath >/dev/null 2>&1; then
    SCRIPT_DIR="$(wslpath -w "$SCRIPT_DIR")"
  else
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W)"
  fi
  NORMALIZED_ARGS=()
  EXPECT_PATH_VALUE=0
  for ARG in "${ARGS[@]}"; do
    if [[ "$EXPECT_PATH_VALUE" == 1 ]]; then
      if command -v wslpath >/dev/null 2>&1; then
        ARG="$(wslpath -w "$ARG")"
      elif [[ "$ARG" =~ ^/mnt/([[:alpha:]])/(.*)$ ]]; then
        DRIVE="${BASH_REMATCH[1]^^}"
        REST="${BASH_REMATCH[2]//\//\\}"
        ARG="${DRIVE}:\\${REST}"
      fi
      EXPECT_PATH_VALUE=0
    fi
    case "$ARG" in
      --codex-config-path|--pi-config-path|--opencode-config-path|--zcode-config-path|--state-root)
        EXPECT_PATH_VALUE=1
        ;;
    esac
    NORMALIZED_ARGS+=("$ARG")
  done
  ARGS=("${NORMALIZED_ARGS[@]}")
fi
if [[ ${#ARGS[@]} -eq 0 ]]; then
  "$NODE_BIN" "$SCRIPT_DIR/launch-ui.mjs"
else
  "$NODE_BIN" "$SCRIPT_DIR/launch-ui.mjs" "${ARGS[@]}"
fi
