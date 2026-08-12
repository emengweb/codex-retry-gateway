param(
  [string]$CodexConfigPath = "$HOME\.codex\config.toml",
  [string]$StateRoot = "$HOME\.codex-retry-gateway",
  [string]$ListenHost = "127.0.0.1",
  [int]$ListenPort = 4610,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "common.ps1")

$paths = Get-GatewayStatePaths -StateRoot $StateRoot
Ensure-Directory -Path $paths.StateRoot
Ensure-Directory -Path $paths.ConfigDir
Ensure-Directory -Path $paths.LogDir
Ensure-Directory -Path $paths.BackupDir

if (-not (Test-Path -LiteralPath $CodexConfigPath)) {
  throw "Codex config file was not found: $CodexConfigPath"
}

$providerContext = Get-CodexProviderContext -CodexConfigPath $CodexConfigPath
$currentBaseUrl = [string]$providerContext.CurrentBaseUrl
$requestedGatewayBaseUrl = Get-GatewayBaseUrl -ListenHost $ListenHost -ListenPort $ListenPort
$existingState = Read-JsonFile -Path $paths.StatePath
$existingGatewayConfig = Read-JsonFile -Path $paths.ConfigPath
$installIdentityMatches = Test-GatewayInstallIdentity `
  -State $existingState `
  -ProviderName $providerContext.ProviderName `
  -CodexConfigPath $CodexConfigPath
if ($null -eq $existingGatewayConfig -and $installIdentityMatches -and (Test-Path -LiteralPath $paths.PidPath)) {
  $runtimePidRaw = (Get-Content -LiteralPath $paths.PidPath -Raw).Trim()
  $runtimePid = 0
  $gatewayBaseUrlProperty = $existingState.PSObject.Properties["gateway_base_url"]
  if (
    [int]::TryParse($runtimePidRaw, [ref]$runtimePid) -and
    (Test-ProcessAlive -ProcessId $runtimePid) -and
    $null -ne $gatewayBaseUrlProperty -and
    -not [string]::IsNullOrWhiteSpace([string]$gatewayBaseUrlProperty.Value)
  ) {
    try {
      $runtimeStatusResponse = Invoke-WebRequest `
        -Uri (([string]$gatewayBaseUrlProperty.Value).TrimEnd("/") + "/__codex_retry_gateway/api/status") `
        -UseBasicParsing `
        -TimeoutSec 2
      $runtimeStatus = $runtimeStatusResponse.Content | ConvertFrom-Json
      $runtimeProcessIdProperty = $runtimeStatus.PSObject.Properties["process_id"]
      $runtimeConfigProperty = $runtimeStatus.PSObject.Properties["config"]
      if (
        $null -ne $runtimeProcessIdProperty -and
        [int]$runtimeProcessIdProperty.Value -eq $runtimePid -and
        $null -ne $runtimeConfigProperty
      ) {
        $existingGatewayConfig = $runtimeConfigProperty.Value
      }
    } catch {
      $existingGatewayConfig = $null
    }
  }
}
$originalBaseUrl = if ($existingState -and -not [string]::IsNullOrWhiteSpace([string]$existingState.original_base_url)) {
  [string]$existingState.original_base_url
} elseif ($existingGatewayConfig -and -not [string]::IsNullOrWhiteSpace([string]$existingGatewayConfig.upstream_base_url)) {
  [string]$existingGatewayConfig.upstream_base_url
} else {
  $null
}

$canReuseExistingInstall =
  ($null -ne $existingGatewayConfig) -and
  (-not [string]::IsNullOrWhiteSpace([string]$originalBaseUrl)) -and
  $installIdentityMatches

$mode = "install"

if (-not $canReuseExistingInstall) {
  & (Join-Path $PSScriptRoot "install-for-current-provider.ps1") `
    -CodexConfigPath $CodexConfigPath `
    -StateRoot $StateRoot `
    -ListenHost $ListenHost `
    -ListenPort $ListenPort `
    -InternalFromLaunchUi
} else {
  $mode = "reuse"
  $previousCodexConfigContent = Get-Content -LiteralPath $CodexConfigPath -Raw
  $previousGatewayConfigContent = if (Test-Path -LiteralPath $paths.ConfigPath) { Get-Content -LiteralPath $paths.ConfigPath -Raw } else { $null }
  $previousGatewayRuntimeConfigContent = ($existingGatewayConfig | ConvertTo-Json -Depth 20) + "`n"
  $previousStateContent = if (Test-Path -LiteralPath $paths.StatePath) { Get-Content -LiteralPath $paths.StatePath -Raw } else { $null }
  $providerConfigWritten = $false
  $gatewayConfigWritten = $false
  $stateWritten = $false
  $gatewayLifecycleAttempted = $false
  $previousGatewayHealthy = $false
  $latestBackupProperty = if ($existingState) { $existingState.PSObject.Properties["latest_backup_path"] } else { $null }
  $recoveryBackupPath = if (
    $null -ne $latestBackupProperty -and
    -not [string]::IsNullOrWhiteSpace([string]$latestBackupProperty.Value)
  ) {
    [string]$latestBackupProperty.Value
  } else {
    ""
  }
  $recoveryBackupCreated = $false

  try {
    $reusableGatewayConfig = $existingGatewayConfig | ConvertTo-Json -Depth 20 | ConvertFrom-Json
    $reusableGatewayConfig.listen_host = $ListenHost
    $reusableGatewayConfig.listen_port = $ListenPort
    if ([string]::IsNullOrWhiteSpace([string]$reusableGatewayConfig.health_path)) {
      $reusableGatewayConfig.health_path = "/__codex_retry_gateway/health"
    }
    $existingInterceptRuleMode = if ($null -ne $reusableGatewayConfig.PSObject.Properties["intercept_rule_mode"]) {
      [string]$reusableGatewayConfig.intercept_rule_mode
    } else {
      ""
    }
    $legacyContinuationRuleMode = $existingInterceptRuleMode.Trim().ToLowerInvariant() -eq "continuation_recovery"
    $normalizedInterceptRuleMode = $existingInterceptRuleMode.Trim().ToLowerInvariant()
    if ($null -eq $reusableGatewayConfig.PSObject.Properties["stream_action"] -or [string]::IsNullOrWhiteSpace([string]$reusableGatewayConfig.stream_action)) {
      if ($null -eq $reusableGatewayConfig.PSObject.Properties["stream_action"]) {
        $reusableGatewayConfig | Add-Member -NotePropertyName "stream_action" -NotePropertyValue "continuation_recovery"
      } else {
        $reusableGatewayConfig.stream_action = "continuation_recovery"
      }
    } elseif ($legacyContinuationRuleMode) {
      $reusableGatewayConfig.stream_action = "continuation_recovery"
    }
    if ($null -eq $reusableGatewayConfig.PSObject.Properties["continuation_marker_text"] -or [string]::IsNullOrWhiteSpace([string]$reusableGatewayConfig.continuation_marker_text)) {
      if ($null -eq $reusableGatewayConfig.PSObject.Properties["continuation_marker_text"]) {
        $reusableGatewayConfig | Add-Member -NotePropertyName "continuation_marker_text" -NotePropertyValue "Continue thinking..."
      } else {
        $reusableGatewayConfig.continuation_marker_text = "Continue thinking..."
      }
    }
    $normalizedInterceptRuleMode = if ($legacyContinuationRuleMode) {
      "reasoning_tokens"
    } elseif (@("reasoning_tokens", "final_answer_only_high_xhigh", "none") -contains $normalizedInterceptRuleMode) {
      $normalizedInterceptRuleMode
    } else {
      "reasoning_tokens"
    }
    if ($null -eq $reusableGatewayConfig.PSObject.Properties["intercept_rule_mode"]) {
      $reusableGatewayConfig | Add-Member -NotePropertyName "intercept_rule_mode" -NotePropertyValue $normalizedInterceptRuleMode
    } else {
      $reusableGatewayConfig.intercept_rule_mode = $normalizedInterceptRuleMode
    }
    if ($null -eq $reusableGatewayConfig.PSObject.Properties["reasoning_match_mode"]) {
      $reusableGatewayConfig | Add-Member -NotePropertyName "reasoning_match_mode" -NotePropertyValue "formula_518n_minus_2"
    } elseif ([string]$reusableGatewayConfig.reasoning_match_mode -ne "manual") {
      $reusableGatewayConfig.reasoning_match_mode = "formula_518n_minus_2"
    }
    if ($null -eq $reusableGatewayConfig.PSObject.Properties["intercept_streaming"]) {
      $reusableGatewayConfig | Add-Member -NotePropertyName "intercept_streaming" -NotePropertyValue $true
    }
    if ($null -eq $reusableGatewayConfig.PSObject.Properties["intercept_non_streaming"]) {
      $reusableGatewayConfig | Add-Member -NotePropertyName "intercept_non_streaming" -NotePropertyValue $true
    }
    if ($null -eq $reusableGatewayConfig.PSObject.Properties["guard_retry_attempts"]) {
      $reusableGatewayConfig | Add-Member -NotePropertyName "guard_retry_attempts" -NotePropertyValue 5
    }
    if ($null -eq $reusableGatewayConfig.PSObject.Properties["retry_upstream_capacity_errors"]) {
      $reusableGatewayConfig | Add-Member -NotePropertyName "retry_upstream_capacity_errors" -NotePropertyValue $true
    } else {
      $reusableGatewayConfig.retry_upstream_capacity_errors = [bool]$reusableGatewayConfig.retry_upstream_capacity_errors
    }
    $legacyCapacityAction = if ([bool]$reusableGatewayConfig.retry_upstream_capacity_errors) { "retry_then_pass_through" } else { "pass_through" }
    $capacityErrorAction = Normalize-UpstreamErrorAction `
      -Value (Get-OptionalPropertyValue -Object $reusableGatewayConfig -Name "capacity_error_action") `
      -DefaultValue $legacyCapacityAction
    if ($null -eq $reusableGatewayConfig.PSObject.Properties["capacity_error_action"]) {
      $reusableGatewayConfig | Add-Member -NotePropertyName "capacity_error_action" -NotePropertyValue $capacityErrorAction
    } else {
      $reusableGatewayConfig.capacity_error_action = $capacityErrorAction
    }
    $http429Action = Normalize-UpstreamErrorAction `
      -Value (Get-OptionalPropertyValue -Object $reusableGatewayConfig -Name "http_429_action") `
      -DefaultValue "pass_through"
    if ($null -eq $reusableGatewayConfig.PSObject.Properties["http_429_action"]) {
      $reusableGatewayConfig | Add-Member -NotePropertyName "http_429_action" -NotePropertyValue $http429Action
    } else {
      $reusableGatewayConfig.http_429_action = $http429Action
    }
    $transientRetry = Normalize-TransientRetry -Value (Get-OptionalPropertyValue -Object $reusableGatewayConfig -Name "transient_retry")
    if ($null -eq $reusableGatewayConfig.PSObject.Properties["transient_retry"]) {
      $reusableGatewayConfig | Add-Member -NotePropertyName "transient_retry" -NotePropertyValue $transientRetry
    } else {
      $reusableGatewayConfig.transient_retry = $transientRetry
    }
    $latencyGuard = Normalize-LatencyGuard -Value (Get-OptionalPropertyValue -Object $reusableGatewayConfig -Name "latency_guard")
    if ($null -eq $reusableGatewayConfig.PSObject.Properties["latency_guard"]) {
      $reusableGatewayConfig | Add-Member -NotePropertyName "latency_guard" -NotePropertyValue $latencyGuard
    } else {
      $reusableGatewayConfig.latency_guard = $latencyGuard
    }
    if (
      $null -eq $reusableGatewayConfig.PSObject.Properties["request_body_limit_bytes"] -or
      [int]$reusableGatewayConfig.request_body_limit_bytes -le 0 -or
      [int]$reusableGatewayConfig.request_body_limit_bytes -eq 10485760
    ) {
      if ($null -eq $reusableGatewayConfig.PSObject.Properties["request_body_limit_bytes"]) {
        $reusableGatewayConfig | Add-Member -NotePropertyName "request_body_limit_bytes" -NotePropertyValue 104857600
      } else {
        $reusableGatewayConfig.request_body_limit_bytes = 104857600
      }
    }
    if (
      [string]$reusableGatewayConfig.intercept_rule_mode -ne "none" -and
      (-not [bool]$reusableGatewayConfig.intercept_streaming) -and
      (-not [bool]$reusableGatewayConfig.intercept_non_streaming)
    ) {
      $reusableGatewayConfig.intercept_streaming = $true
      $reusableGatewayConfig.intercept_non_streaming = $true
    }

    $existingGatewayConfigJson = ConvertTo-CanonicalJson -Value $existingGatewayConfig
    $reusableGatewayConfigJson = ConvertTo-CanonicalJson -Value $reusableGatewayConfig
    $gatewayConfigChanged = $existingGatewayConfigJson -cne $reusableGatewayConfigJson
    $gatewayConfigNeedsWrite = $null -eq $previousGatewayConfigContent -or $gatewayConfigChanged

    $gatewayProcessAlive = $false
    $gatewayPidValue = 0
    if (Test-Path -LiteralPath $paths.PidPath) {
      $gatewayPidRaw = (Get-Content -LiteralPath $paths.PidPath -Raw).Trim()
      if ([int]::TryParse($gatewayPidRaw, [ref]$gatewayPidValue)) {
        $gatewayProcessAlive = Test-ProcessAlive -ProcessId $gatewayPidValue
      }
    }
    if ($gatewayProcessAlive) {
      $previousGatewayHealthy = Test-GatewayProcessIdentity -ProcessId $gatewayPidValue -GatewayConfig $existingGatewayConfig
      if (-not $previousGatewayHealthy) {
        Remove-Item -LiteralPath $paths.PidPath -Force -ErrorAction SilentlyContinue
      }
    }

    $managedGatewayBaseUrls = @($requestedGatewayBaseUrl)
    if (
      $existingState -and
      $null -ne $existingState.PSObject.Properties["gateway_base_url"] -and
      -not [string]::IsNullOrWhiteSpace([string]$existingState.gateway_base_url)
    ) {
      $managedGatewayBaseUrls += [string]$existingState.gateway_base_url
    }
    $existingConfigGatewayBaseUrl = Get-GatewayBaseUrlFromConfig -GatewayConfig $existingGatewayConfig
    if (-not [string]::IsNullOrWhiteSpace([string]$existingConfigGatewayBaseUrl)) {
      $managedGatewayBaseUrls += [string]$existingConfigGatewayBaseUrl
    }
    $recoveryBackupUsable =
      (-not [string]::IsNullOrWhiteSpace($recoveryBackupPath)) -and
      (Test-Path -LiteralPath $recoveryBackupPath -PathType Leaf)
    if ((-not $recoveryBackupUsable) -and ($managedGatewayBaseUrls -notcontains $currentBaseUrl)) {
      $backupTimestamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
      $backupSuffix = 0
      do {
        $backupSuffixText = if ($backupSuffix -eq 0) { "" } else { "-$backupSuffix" }
        $recoveryBackupPath = Join-Path $paths.BackupDir ("config-$backupTimestamp$backupSuffixText.toml")
        $backupSuffix += 1
      } while (Test-Path -LiteralPath $recoveryBackupPath)
      Copy-Item -LiteralPath $CodexConfigPath -Destination $recoveryBackupPath
      $recoveryBackupCreated = $true
    }

    if ($gatewayConfigChanged -and $previousGatewayHealthy) {
      $gatewayLifecycleAttempted = $true
      $temporaryIdentityConfigWritten = $false
      try {
        if (-not (Test-Path -LiteralPath $paths.ConfigPath)) {
          Write-Utf8NoBomFile -Path $paths.ConfigPath -Content $previousGatewayRuntimeConfigContent
          $temporaryIdentityConfigWritten = $true
        }
        & (Join-Path $PSScriptRoot "stop-gateway.ps1") -StateRoot $StateRoot -Quiet
      } finally {
        if ($temporaryIdentityConfigWritten) {
          Remove-Item -LiteralPath $paths.ConfigPath -Force -ErrorAction SilentlyContinue
        }
      }
    }

    if ($gatewayConfigNeedsWrite) {
      Write-JsonFile -Path $paths.ConfigPath -Value $reusableGatewayConfig
      $gatewayConfigWritten = $true
    }

    if ($currentBaseUrl -ne $requestedGatewayBaseUrl) {
      Set-CodexProviderBaseUrl `
        -CodexConfigPath $CodexConfigPath `
        -ProviderName $providerContext.ProviderName `
        -NewBaseUrl $requestedGatewayBaseUrl
      $providerConfigWritten = $true
    }

    $gatewayLifecycleChanged = (-not $previousGatewayHealthy) -or $gatewayConfigChanged
    if ($gatewayLifecycleChanged) {
      $gatewayLifecycleAttempted = $true
      & (Join-Path $PSScriptRoot "start-gateway.ps1") `
        -StateRoot $StateRoot `
        -ConfigPath $paths.ConfigPath `
        -LogPath $paths.LogPath
    }

    $statePayload = [ordered]@{
      installed_at        = if ($existingState -and $existingState.installed_at) { [string]$existingState.installed_at } else { (Get-Date).ToString("o") }
      last_started_at     = if ($gatewayLifecycleChanged) { (Get-Date).ToString("o") } elseif ($existingState -and $existingState.last_started_at) { [string]$existingState.last_started_at } elseif ($existingState -and $existingState.installed_at) { [string]$existingState.installed_at } else { (Get-Date).ToString("o") }
      codex_config_path   = $CodexConfigPath
      provider_name       = $providerContext.ProviderName
      original_base_url   = $originalBaseUrl
      gateway_base_url    = $requestedGatewayBaseUrl
      gateway_config_path = $paths.ConfigPath
      gateway_log_path    = $paths.LogPath
      gateway_pid_path    = $paths.PidPath
      latest_backup_path  = $recoveryBackupPath
      state_root          = $paths.StateRoot
    }
    $existingStateJson = if ($existingState) { $existingState | ConvertTo-Json -Depth 20 -Compress } else { "" }
    $statePayloadJson = $statePayload | ConvertTo-Json -Depth 20 -Compress
    if ($existingStateJson -cne $statePayloadJson) {
      Write-JsonFile -Path $paths.StatePath -Value $statePayload
      $stateWritten = $true
    }
  } catch {
    $launchError = $_
    $rollbackErrors = New-Object System.Collections.Generic.List[string]

    if ($gatewayLifecycleAttempted) {
      try {
        & (Join-Path $PSScriptRoot "stop-gateway.ps1") -StateRoot $StateRoot -Quiet
      } catch {
        $rollbackErrors.Add($_.Exception.Message)
      }
    }

    if ($providerConfigWritten) {
      try {
        Write-Utf8NoBomFile -Path $CodexConfigPath -Content $previousCodexConfigContent
      } catch {
        $rollbackErrors.Add($_.Exception.Message)
      }
    }

    if ($gatewayConfigWritten) {
      try {
        if ($null -eq $previousGatewayConfigContent) {
          Remove-Item -LiteralPath $paths.ConfigPath -Force -ErrorAction SilentlyContinue
        } else {
          Write-Utf8NoBomFile -Path $paths.ConfigPath -Content $previousGatewayConfigContent
        }
      } catch {
        $rollbackErrors.Add($_.Exception.Message)
      }
    }

    if ($stateWritten) {
      try {
        if ($null -eq $previousStateContent) {
          Remove-Item -LiteralPath $paths.StatePath -Force -ErrorAction SilentlyContinue
        } else {
          Write-Utf8NoBomFile -Path $paths.StatePath -Content $previousStateContent
        }
      } catch {
        $rollbackErrors.Add($_.Exception.Message)
      }
    }

    if ($recoveryBackupCreated) {
      try {
        Remove-Item -LiteralPath $recoveryBackupPath -Force -ErrorAction Stop
      } catch {
        $rollbackErrors.Add($_.Exception.Message)
      }
    }

    if ($gatewayLifecycleAttempted -and $previousGatewayHealthy) {
      $temporaryRollbackConfigWritten = $false
      try {
        if (-not (Test-Path -LiteralPath $paths.ConfigPath)) {
          Write-Utf8NoBomFile -Path $paths.ConfigPath -Content $previousGatewayRuntimeConfigContent
          $temporaryRollbackConfigWritten = $true
        }
        & (Join-Path $PSScriptRoot "start-gateway.ps1") `
          -StateRoot $StateRoot `
          -ConfigPath $paths.ConfigPath `
          -LogPath $paths.LogPath `
          -RestartIfRunning
      } catch {
        $rollbackErrors.Add($_.Exception.Message)
      } finally {
        if ($temporaryRollbackConfigWritten) {
          try {
            Remove-Item -LiteralPath $paths.ConfigPath -Force -ErrorAction Stop
          } catch {
            $rollbackErrors.Add($_.Exception.Message)
          }
        }
      }
    }

    if ($rollbackErrors.Count -gt 0) {
      throw ("Gateway launch failed: {0}`nRollback errors: {1}" -f $launchError.Exception.Message, ($rollbackErrors -join " | "))
    }
    throw $launchError
  }
}

$effectiveGatewayConfig = Read-JsonFile -Path $paths.ConfigPath
$effectiveGatewayBaseUrl = Get-GatewayBaseUrlFromConfig -GatewayConfig $effectiveGatewayConfig
if ([string]::IsNullOrWhiteSpace([string]$effectiveGatewayBaseUrl)) {
  $effectiveGatewayBaseUrl = $requestedGatewayBaseUrl
}

$uiUrl = $effectiveGatewayBaseUrl + "/__codex_retry_gateway/ui"
if (-not $NoOpen) {
  Start-Process $uiUrl | Out-Null
}

Write-Output "Codex Retry Gateway UI is ready"
Write-Output "mode=$mode"
Write-Output "ui=$uiUrl"
Write-Output "gateway=$effectiveGatewayBaseUrl"
