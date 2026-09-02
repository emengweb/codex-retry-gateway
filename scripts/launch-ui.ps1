param(
  [string]$CodexConfigPath = "$HOME\.codex\config.toml",
  [string]$PiConfigPath = "",
  [string]$OpenCodeConfigPath = "",
  [string]$ZcodeConfigPath = "",
  [string]$StateRoot = "$HOME\.codex-retry-gateway",
  [string]$ListenHost = "127.0.0.1",
  [int]$ListenPort = 4610,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"

$node = if (Get-Command node.exe -ErrorAction SilentlyContinue) { "node.exe" } else { "node" }
$args = @(
  (Join-Path $PSScriptRoot "launch-ui.mjs"),
  "--codex-config-path", $CodexConfigPath,
  "--state-root", $StateRoot,
  "--listen-host", $ListenHost,
  "--listen-port", [string]$ListenPort
)
if (-not [string]::IsNullOrWhiteSpace($PiConfigPath)) {
  $args += @("--pi-config-path", $PiConfigPath)
}
if (-not [string]::IsNullOrWhiteSpace($OpenCodeConfigPath)) {
  $args += @("--opencode-config-path", $OpenCodeConfigPath)
}
if (-not [string]::IsNullOrWhiteSpace($ZcodeConfigPath)) {
  $args += @("--zcode-config-path", $ZcodeConfigPath)
}
if ($NoOpen) {
  $args += "--no-open"
}

& $node @args
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
