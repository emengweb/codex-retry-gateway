param(
  [string]$StateRoot = "$HOME\.codex-retry-gateway",
  [string]$CodexConfigPath = "$HOME\.codex\config.toml"
)

$ErrorActionPreference = "Stop"

$node = if (Get-Command node.exe -ErrorAction SilentlyContinue) { "node.exe" } else { "node" }
& $node (Join-Path $PSScriptRoot "restore-codex-config.mjs") `
  "--state-root" $StateRoot `
  "--codex-config-path" $CodexConfigPath
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
