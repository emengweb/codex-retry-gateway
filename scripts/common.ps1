Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-GatewayRoot {
  return Split-Path -Parent $PSScriptRoot
}

function Get-GatewayBaseUrl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ListenHost,
    [Parameter(Mandatory = $true)]
    [int]$ListenPort
  )

  return "http://{0}:{1}" -f $ListenHost, $ListenPort
}

function Get-GatewayStatePaths {
  param(
    [string]$StateRoot = (Join-Path $HOME ".codex-retry-gateway")
  )

  return [pscustomobject]@{
    StateRoot  = $StateRoot
    ConfigDir  = Join-Path $StateRoot "config"
    LogDir     = Join-Path $StateRoot "logs"
    BackupDir  = Join-Path $StateRoot "backups"
    ConfigPath = Join-Path $StateRoot "config\config.json"
    LogPath    = Join-Path $StateRoot "logs\gateway.log"
    StatePath  = Join-Path $StateRoot "state.json"
    PidPath    = Join-Path $StateRoot "gateway.pid"
  }
}

function Get-GatewayBaseUrlFromConfig {
  param(
    $GatewayConfig
  )

  if ($null -eq $GatewayConfig) {
    return $null
  }

  if ([string]::IsNullOrWhiteSpace([string]$GatewayConfig.listen_host) -or $null -eq $GatewayConfig.listen_port) {
    return $null
  }

  return Get-GatewayBaseUrl `
    -ListenHost ([string]$GatewayConfig.listen_host) `
    -ListenPort ([int]$GatewayConfig.listen_port)
}

function Test-GatewayInstallIdentity {
  param(
    $State,
    [Parameter(Mandatory = $true)]
    [string]$ProviderName,
    [Parameter(Mandatory = $true)]
    [string]$CodexConfigPath
  )

  if ($null -eq $State) {
    return $false
  }
  $providerProperty = $State.PSObject.Properties["provider_name"]
  $configPathProperty = $State.PSObject.Properties["codex_config_path"]
  if (
    $null -eq $providerProperty -or
    [string]::IsNullOrWhiteSpace([string]$providerProperty.Value) -or
    $null -eq $configPathProperty -or
    [string]::IsNullOrWhiteSpace([string]$configPathProperty.Value)
  ) {
    return $false
  }

  $stateConfigPath = [System.IO.Path]::GetFullPath([string]$configPathProperty.Value)
  $currentConfigPath = [System.IO.Path]::GetFullPath($CodexConfigPath)
  return (
    [string]$providerProperty.Value -ceq $ProviderName -and
    [System.StringComparer]::OrdinalIgnoreCase.Equals($stateConfigPath, $currentConfigPath)
  )
}

function Ensure-Directory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Write-Utf8NoBomFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Content
  )

  $parent = Split-Path -Parent $Path
  if ($parent) {
    Ensure-Directory -Path $parent
  }

  $encoding = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Read-JsonFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return $null
  }

  return $raw | ConvertFrom-Json
}

function Get-OptionalPropertyValue {
  param(
    $Object,
    [Parameter(Mandatory = $true)]
    [string]$Name,
    $DefaultValue = $null
  )

  if ($null -eq $Object) {
    return $DefaultValue
  }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    return $DefaultValue
  }
  return $property.Value
}

function Normalize-UpstreamErrorAction {
  param(
    $Value,
    [Parameter(Mandatory = $true)]
    [string]$DefaultValue
  )

  $normalized = ([string]$Value).Trim().ToLowerInvariant()
  if (@("pass_through", "return_502", "retry_then_pass_through", "retry_then_502") -contains $normalized) {
    return $normalized
  }
  return $DefaultValue
}

function Normalize-LatencyGuardInteger {
  param(
    $Value,
    [long]$DefaultValue = 0
  )

  $parsed = [long]0
  if (
    $null -ne $Value -and
    [long]::TryParse(([string]$Value).Trim(), [ref]$parsed) -and
    $parsed -ge 0 -and
    $parsed -le 2147483647
  ) {
    return $parsed
  }
  return $DefaultValue
}

function Normalize-LatencyGuard {
  param($Value)

  $enabledValue = Get-OptionalPropertyValue -Object $Value -Name "enabled" -DefaultValue $false
  $enabled = if ($enabledValue -is [bool]) { [bool]$enabledValue } else { $false }
  $firstProgressTimeoutMs = Normalize-LatencyGuardInteger `
    -Value (Get-OptionalPropertyValue -Object $Value -Name "first_progress_timeout_ms")
  $firstProgressAction = Normalize-UpstreamErrorAction `
    -Value (Get-OptionalPropertyValue -Object $Value -Name "first_progress_action") `
    -DefaultValue "return_502"
  if (@("return_502", "retry_then_502") -notcontains $firstProgressAction) {
    $firstProgressAction = "return_502"
  }
  $totalTimeoutMs = Normalize-LatencyGuardInteger `
    -Value (Get-OptionalPropertyValue -Object $Value -Name "total_timeout_ms")
  if ($enabled -and $firstProgressTimeoutMs -eq 0 -and $totalTimeoutMs -eq 0) {
    $enabled = $false
  }

  return [pscustomobject][ordered]@{
    enabled = $enabled
    first_progress_timeout_ms = $firstProgressTimeoutMs
    first_progress_action = $firstProgressAction
    total_timeout_ms = $totalTimeoutMs
  }
}

function Normalize-TransientRetry {
  param($Value)

  $enabledValue = Get-OptionalPropertyValue -Object $Value -Name "enabled" -DefaultValue $true
  $enabled = if ($enabledValue -is [bool]) { [bool]$enabledValue } else { $true }
  $initialDelayMs = Normalize-LatencyGuardInteger `
    -Value (Get-OptionalPropertyValue -Object $Value -Name "initial_delay_ms") `
    -DefaultValue 1000
  $maxDelayMs = Normalize-LatencyGuardInteger `
    -Value (Get-OptionalPropertyValue -Object $Value -Name "max_delay_ms") `
    -DefaultValue 600000

  $initialDelayMs = [Math]::Min(600000, $initialDelayMs)
  $maxDelayMs = [Math]::Min(600000, $maxDelayMs)
  if ($initialDelayMs -gt $maxDelayMs) {
    $initialDelayMs = $maxDelayMs
  }

  return [pscustomobject][ordered]@{
    enabled = $enabled
    initial_delay_ms = $initialDelayMs
    max_delay_ms = $maxDelayMs
  }
}

function ConvertTo-CanonicalJsonNode {
  param($Value)

  if ($null -eq $Value) {
    return $null
  }
  if ($Value -is [string] -or $Value.GetType().IsValueType) {
    return $Value
  }
  if ($Value -is [System.Collections.IDictionary]) {
    $ordered = [ordered]@{}
    foreach ($key in @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive)) {
      $ordered[$key] = ConvertTo-CanonicalJsonNode -Value $Value[$key]
    }
    return [pscustomobject]$ordered
  }
  if ($Value -is [pscustomobject]) {
    $ordered = [ordered]@{}
    foreach ($property in @($Value.PSObject.Properties | Sort-Object -Property Name -CaseSensitive)) {
      $ordered[$property.Name] = ConvertTo-CanonicalJsonNode -Value $property.Value
    }
    return [pscustomobject]$ordered
  }
  if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
    $items = @($Value | ForEach-Object { ConvertTo-CanonicalJsonNode -Value $_ })
    return ,$items
  }
  return $Value
}

function ConvertTo-CanonicalJson {
  param(
    [Parameter(Mandatory = $true)]
    $Value
  )

  $canonical = ConvertTo-CanonicalJsonNode -Value $Value
  return ($canonical | ConvertTo-Json -Depth 20 -Compress)
}

function Write-JsonFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    $Value
  )

  $json = $Value | ConvertTo-Json -Depth 20
  Write-Utf8NoBomFile -Path $Path -Content ($json + "`n")
}

function Get-CodexProviderContext {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CodexConfigPath
  )

  $content = Get-Content -LiteralPath $CodexConfigPath -Raw
  $providerMatch = [regex]::Match($content, '(?m)^\s*model_provider\s*=\s*"([^"]+)"\s*$')
  if (-not $providerMatch.Success) {
    throw "model_provider was not found in $CodexConfigPath"
  }

  $providerName = $providerMatch.Groups[1].Value
  $sectionPattern = "(?ms)^\[model_providers\." + [regex]::Escape($providerName) + "\]\s*$.*?(?=^\[|\z)"
  $sectionMatch = [regex]::Match($content, $sectionPattern)
  if (-not $sectionMatch.Success) {
    throw "[model_providers.$providerName] was not found in $CodexConfigPath"
  }

  $sectionText = $sectionMatch.Value
  $baseUrlMatch = [regex]::Match($sectionText, '(?m)^\s*base_url\s*=\s*"([^"]+)"\s*$')
  if (-not $baseUrlMatch.Success) {
    throw "base_url was not found in [model_providers.$providerName]"
  }

  return [pscustomobject]@{
    Content         = $content
    ProviderName    = $providerName
    SectionText     = $sectionText
    SectionIndex    = $sectionMatch.Index
    SectionLength   = $sectionMatch.Length
    CurrentBaseUrl  = $baseUrlMatch.Groups[1].Value
    BaseUrlLineText = $baseUrlMatch.Value
  }
}

function Set-CodexProviderBaseUrl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CodexConfigPath,
    [Parameter(Mandatory = $true)]
    [string]$ProviderName,
    [Parameter(Mandatory = $true)]
    [string]$NewBaseUrl
  )

  $context = Get-CodexProviderContext -CodexConfigPath $CodexConfigPath
  if ($context.ProviderName -ne $ProviderName) {
    throw "model_provider changed unexpectedly: expected $ProviderName, actual $($context.ProviderName)"
  }

  $updatedSection = [regex]::Replace(
    $context.SectionText,
    '(?m)^(\s*base_url\s*=\s*")([^"]*)("\s*)$',
    {
      param($match)
      return $match.Groups[1].Value + $NewBaseUrl + $match.Groups[3].Value
    },
    1
  )

  $updatedContent =
    $context.Content.Substring(0, $context.SectionIndex) +
    $updatedSection +
    $context.Content.Substring($context.SectionIndex + $context.SectionLength)

  Write-Utf8NoBomFile -Path $CodexConfigPath -Content $updatedContent
}

function Test-ProcessAlive {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId
  )

  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    return -not $process.HasExited
  } catch {
    return $false
  }
}

function Get-GatewayRuntimeConfig {
  param(
    [Parameter(Mandatory = $true)]
    [string]$GatewayBaseUrl,
    [Parameter(Mandatory = $true)]
    [int]$ProcessId
  )

  if ([string]::IsNullOrWhiteSpace($GatewayBaseUrl) -or -not (Test-ProcessAlive -ProcessId $ProcessId)) {
    return $null
  }
  try {
    $response = Invoke-WebRequest `
      -Uri ($GatewayBaseUrl.TrimEnd("/") + "/__codex_retry_gateway/api/status") `
      -UseBasicParsing `
      -TimeoutSec 2
    if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
      return $null
    }
    $payload = $response.Content | ConvertFrom-Json
    $processIdProperty = $payload.PSObject.Properties["process_id"]
    $configProperty = $payload.PSObject.Properties["config"]
    if (
      $null -eq $processIdProperty -or
      [int]$processIdProperty.Value -ne $ProcessId -or
      $null -eq $configProperty
    ) {
      return $null
    }
    return $configProperty.Value
  } catch {
    return $null
  }
}

function Test-GatewayProcessIdentity {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,
    [Parameter(Mandatory = $true)]
    $GatewayConfig
  )

  if (-not (Test-ProcessAlive -ProcessId $ProcessId)) {
    return $false
  }
  $gatewayBaseUrl = Get-GatewayBaseUrlFromConfig -GatewayConfig $GatewayConfig
  if ([string]::IsNullOrWhiteSpace([string]$gatewayBaseUrl)) {
    return $false
  }
  $healthPath = if (
    $null -ne $GatewayConfig.PSObject.Properties["health_path"] -and
    -not [string]::IsNullOrWhiteSpace([string]$GatewayConfig.health_path)
  ) {
    [string]$GatewayConfig.health_path
  } else {
    "/__codex_retry_gateway/health"
  }

  try {
    $response = Invoke-WebRequest -Uri ($gatewayBaseUrl + $healthPath) -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
      return $false
    }
    $payload = $response.Content | ConvertFrom-Json
    $processIdProperty = $payload.PSObject.Properties["process_id"]
    return $null -ne $processIdProperty -and [int]$processIdProperty.Value -eq $ProcessId
  } catch {
    return $false
  }
}

function Stop-FailedGatewayStart {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,
    [Parameter(Mandatory = $true)]
    [string]$PidPath
  )

  if (Test-ProcessAlive -ProcessId $ProcessId) {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    try {
      Wait-Process -Id $ProcessId -Timeout 3 -ErrorAction SilentlyContinue
    } catch {
    }
  }

  if (-not (Test-ProcessAlive -ProcessId $ProcessId) -and (Test-Path -LiteralPath $PidPath)) {
    $currentPidRaw = (Get-Content -LiteralPath $PidPath -Raw).Trim()
    $currentPid = 0
    if ([int]::TryParse($currentPidRaw, [ref]$currentPid) -and $currentPid -eq $ProcessId) {
      Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Wait-GatewayHealth {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ListenHost,
    [Parameter(Mandatory = $true)]
    [int]$ListenPort,
    [Parameter(Mandatory = $true)]
    [string]$HealthPath,
    [int]$TimeoutSeconds = 10,
    [int]$ExpectedProcessId = 0
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $healthUrl = "http://{0}:{1}{2}" -f $ListenHost, $ListenPort, $HealthPath

  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        if ($ExpectedProcessId -le 0) {
          return $response
        }
        $payload = $response.Content | ConvertFrom-Json
        $processIdProperty = $payload.PSObject.Properties["process_id"]
        if ($null -ne $processIdProperty -and [int]$processIdProperty.Value -eq $ExpectedProcessId) {
          return $response
        }
      }
    } catch {
    }
    Start-Sleep -Milliseconds 200
  }

  throw "Gateway health check timed out: $healthUrl"
}

function Normalize-IntArray {
  param(
    $Values,
    [int[]]$Default = @(516, 1034, 1552)
  )

  if ($null -eq $Values) {
    return ,@($Default)
  }

  $queue = New-Object System.Collections.Generic.List[object]
  foreach ($item in @($Values)) {
    $queue.Add($item)
  }

  $normalized = @()
  foreach ($value in $queue) {
    if ($null -eq $value) {
      continue
    }
    if ($value -is [System.Collections.IEnumerable] -and -not ($value -is [string])) {
      foreach ($nestedValue in @($value)) {
        if ($null -eq $nestedValue) {
          continue
        }
        $normalized += [int]$nestedValue
      }
      continue
    }
    $normalized += [int]$value
  }

  if ($normalized.Count -eq 0) {
    return ,@($Default)
  }

  return ,@($normalized)
}

function Normalize-StringArray {
  param(
    $Values,
    [string[]]$Default
  )

  if ($null -eq $Values) {
    return ,@($Default)
  }

  $normalized = @()
  foreach ($value in @($Values)) {
    if ($value -is [System.Collections.IEnumerable] -and -not ($value -is [string])) {
      foreach ($nestedValue in @($value)) {
        if ([string]::IsNullOrWhiteSpace([string]$nestedValue)) {
          continue
        }
        foreach ($part in ([string]$nestedValue).Split(@(" ", "`t", "`r", "`n"), [System.StringSplitOptions]::RemoveEmptyEntries)) {
          $normalized += $part
        }
      }
      continue
    }
    if ([string]::IsNullOrWhiteSpace([string]$value)) {
      continue
    }
    foreach ($part in ([string]$value).Split(@(" ", "`t", "`r", "`n"), [System.StringSplitOptions]::RemoveEmptyEntries)) {
      $normalized += $part
    }
  }

  if ($normalized.Count -eq 0) {
    return ,@($Default)
  }

  return ,@($normalized)
}
