param(
  [string]$CodexConfigPath = "$HOME\.codex\config.toml",
  [string]$StateRoot = "$HOME\.codex-retry-gateway",
  [string]$ListenHost = "127.0.0.1",
  [int]$ListenPort = 4610,
  [switch]$InternalFromLaunchUi
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "common.ps1")

if (-not $InternalFromLaunchUi) {
  $null = & (Join-Path $PSScriptRoot "launch-ui.ps1") `
    -CodexConfigPath $CodexConfigPath `
    -StateRoot $StateRoot `
    -ListenHost $ListenHost `
    -ListenPort $ListenPort `
    -NoOpen
  $resultPaths = Get-GatewayStatePaths -StateRoot $StateRoot
  $resultState = Read-JsonFile -Path $resultPaths.StatePath
  $resultGatewayConfig = Read-JsonFile -Path $resultPaths.ConfigPath
  if ($null -eq $resultState -or $null -eq $resultGatewayConfig) {
    throw "Gateway install completed without readable state/config files."
  }
  Write-Output "Installed Codex Retry Gateway"
  Write-Output "provider=$([string]$resultState.provider_name)"
  Write-Output "upstream=$([string]$resultState.original_base_url)"
  Write-Output "gateway=$(Get-GatewayBaseUrlFromConfig -GatewayConfig $resultGatewayConfig)"
  Write-Output "config=$($resultPaths.ConfigPath)"
  Write-Output "backup=$([string]$resultState.latest_backup_path)"
  return
}

$paths = Get-GatewayStatePaths -StateRoot $StateRoot
Ensure-Directory -Path $paths.StateRoot
Ensure-Directory -Path $paths.ConfigDir
Ensure-Directory -Path $paths.LogDir
Ensure-Directory -Path $paths.BackupDir

if (-not (Test-Path -LiteralPath $CodexConfigPath)) {
  throw "Codex config file was not found: $CodexConfigPath"
}

$providerContext = Get-CodexProviderContext -CodexConfigPath $CodexConfigPath
$localGatewayBaseUrl = "http://{0}:{1}" -f $ListenHost, $ListenPort
$existingState = Read-JsonFile -Path $paths.StatePath
$existingGatewayConfig = Read-JsonFile -Path $paths.ConfigPath
$existingStateMatchesProvider = Test-GatewayInstallIdentity `
  -State $existingState `
  -ProviderName $providerContext.ProviderName `
  -CodexConfigPath $CodexConfigPath

$originalBaseUrl = $providerContext.CurrentBaseUrl
if ($providerContext.CurrentBaseUrl -eq $localGatewayBaseUrl) {
  if (
    $null -eq $existingState -or
    [string]::IsNullOrWhiteSpace([string]$existingState.original_base_url) -or
    (-not $existingStateMatchesProvider)
  ) {
    throw "Provider already points to the local gateway, but no matching install state can supply original_base_url."
  }
  $originalBaseUrl = [string]$existingState.original_base_url
}

if ($originalBaseUrl -eq $localGatewayBaseUrl) {
  throw "A real upstream_base_url could not be determined."
}

$existingBackupProperty = if ($existingState) { $existingState.PSObject.Properties["latest_backup_path"] } else { $null }
$backupPath = if (
  $existingStateMatchesProvider -and
  $null -ne $existingBackupProperty -and
  -not [string]::IsNullOrWhiteSpace([string]$existingBackupProperty.Value) -and
  (Test-Path -LiteralPath ([string]$existingBackupProperty.Value) -PathType Leaf)
) {
  [string]$existingBackupProperty.Value
} else {
  ""
}
if ([string]::IsNullOrWhiteSpace($backupPath) -and $providerContext.CurrentBaseUrl -ne $localGatewayBaseUrl) {
  $backupTimestamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
  $backupSuffix = 0
  do {
    $backupSuffixText = if ($backupSuffix -eq 0) { "" } else { "-$backupSuffix" }
    $backupPath = Join-Path $paths.BackupDir ("config-$backupTimestamp$backupSuffixText.toml")
    $backupSuffix += 1
  } while (Test-Path -LiteralPath $backupPath)
  Copy-Item -LiteralPath $CodexConfigPath -Destination $backupPath
}

$defaultEndpoints = @("/responses", "/chat/completions", "/v1/responses", "/v1/chat/completions")
$mergedEndpoints = @()
foreach ($endpoint in @(
  $(if ($existingGatewayConfig) { Normalize-StringArray -Values $existingGatewayConfig.endpoints -Default @() } else { @() }) +
  $defaultEndpoints
)) {
  if ([string]::IsNullOrWhiteSpace([string]$endpoint)) {
    continue
  }
  if ($mergedEndpoints -notcontains [string]$endpoint) {
    $mergedEndpoints += [string]$endpoint
  }
}

$existingInterceptRuleMode = [string](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "intercept_rule_mode" -DefaultValue "reasoning_tokens")
$normalizedInterceptRuleMode = $existingInterceptRuleMode.Trim().ToLowerInvariant()
$legacyContinuationRuleMode = $existingInterceptRuleMode.Trim().ToLowerInvariant() -eq "continuation_recovery"
$existingStreamAction = [string](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "stream_action")
$retryUpstreamCapacityErrors = [bool](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "retry_upstream_capacity_errors" -DefaultValue $true)
$legacyCapacityAction = if ($retryUpstreamCapacityErrors) { "retry_then_pass_through" } else { "pass_through" }

$gatewayConfig = [ordered]@{
  listen_host = $ListenHost
  listen_port = $ListenPort
  upstream_base_url = $originalBaseUrl
  request_body_limit_bytes = [int](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "request_body_limit_bytes" -DefaultValue 104857600)
  endpoints = @($mergedEndpoints)
  intercept_rule_mode = if ($legacyContinuationRuleMode) { "reasoning_tokens" } elseif (@("reasoning_tokens", "final_answer_only_high_xhigh", "none") -contains $normalizedInterceptRuleMode) { $normalizedInterceptRuleMode } else { "reasoning_tokens" }
  reasoning_match_mode = if ([string](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "reasoning_match_mode") -eq "manual") { "manual" } else { "formula_518n_minus_2" }
  reasoning_equals = Normalize-IntArray -Values (Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "reasoning_equals") -Default @(516, 1034, 1552)
  intercept_streaming = [bool](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "intercept_streaming" -DefaultValue $true)
  intercept_non_streaming = [bool](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "intercept_non_streaming" -DefaultValue $true)
  non_stream_status_code = [int](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "non_stream_status_code" -DefaultValue 502)
  guard_retry_attempts = [int](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "guard_retry_attempts" -DefaultValue 5)
  retry_upstream_capacity_errors = $retryUpstreamCapacityErrors
  capacity_error_action = Normalize-UpstreamErrorAction -Value (Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "capacity_error_action") -DefaultValue $legacyCapacityAction
  http_429_action = Normalize-UpstreamErrorAction -Value (Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "http_429_action") -DefaultValue "pass_through"
  transient_retry = Normalize-TransientRetry -Value (Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "transient_retry")
  latency_guard = Normalize-LatencyGuard -Value (Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "latency_guard")
  stream_action = if ($legacyContinuationRuleMode) { "continuation_recovery" } elseif ([string]::IsNullOrWhiteSpace($existingStreamAction)) { "continuation_recovery" } else { $existingStreamAction }
  continuation_marker_text = if ([string]::IsNullOrWhiteSpace([string](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "continuation_marker_text"))) { "Continue thinking..." } else { [string](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "continuation_marker_text") }
  log_match = [bool](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "log_match" -DefaultValue $true)
  health_path = if ([string]::IsNullOrWhiteSpace([string](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "health_path"))) { "/__codex_retry_gateway/health" } else { [string](Get-OptionalPropertyValue -Object $existingGatewayConfig -Name "health_path") }
}

if ($gatewayConfig.request_body_limit_bytes -le 0 -or $gatewayConfig.request_body_limit_bytes -eq 10485760) {
  $gatewayConfig.request_body_limit_bytes = 104857600
}

$previousConfigContent = Get-Content -LiteralPath $CodexConfigPath -Raw

try {
  Write-JsonFile -Path $paths.ConfigPath -Value $gatewayConfig
  Set-CodexProviderBaseUrl `
    -CodexConfigPath $CodexConfigPath `
    -ProviderName $providerContext.ProviderName `
    -NewBaseUrl $localGatewayBaseUrl

  & (Join-Path $PSScriptRoot "start-gateway.ps1") `
    -StateRoot $StateRoot `
    -ConfigPath $paths.ConfigPath `
    -LogPath $paths.LogPath `
    -RestartIfRunning

  $installedAt = (Get-Date).ToString("o")
  $state = [ordered]@{
    installed_at        = $installedAt
    last_started_at     = $installedAt
    codex_config_path   = $CodexConfigPath
    provider_name       = $providerContext.ProviderName
    original_base_url   = $originalBaseUrl
    gateway_base_url    = $localGatewayBaseUrl
    gateway_config_path = $paths.ConfigPath
    gateway_log_path    = $paths.LogPath
    gateway_pid_path    = $paths.PidPath
    latest_backup_path  = $backupPath
    state_root          = $paths.StateRoot
  }
  Write-JsonFile -Path $paths.StatePath -Value $state

  Write-Output "Installed Codex Retry Gateway"
  Write-Output "provider=$($providerContext.ProviderName)"
  Write-Output "upstream=$originalBaseUrl"
  Write-Output "gateway=$localGatewayBaseUrl"
  Write-Output "config=$($paths.ConfigPath)"
  Write-Output "backup=$backupPath"
} catch {
  Write-Utf8NoBomFile -Path $CodexConfigPath -Content $previousConfigContent
  & (Join-Path $PSScriptRoot "stop-gateway.ps1") -StateRoot $StateRoot -Quiet
  throw
}
