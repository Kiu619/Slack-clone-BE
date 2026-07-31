param(
  [string]$Name = 'slack-clone-livekit',
  [string]$Image = 'livekit/livekit-server:latest'
)

$ErrorActionPreference = 'Stop'

function Get-LiveKitDevCredentials {
  param(
    [string]$ConfigPath
  )

  $inKeysSection = $false
  foreach ($line in Get-Content -LiteralPath $ConfigPath) {
    if ($line -match '^\s*keys:\s*$') {
      $inKeysSection = $true
      continue
    }

    if ($inKeysSection -and $line -match '^\s{2,}(?<key>[^:#]+):\s*"?(?<secret>[^"]+)"?\s*$') {
      return @{
        ApiKey = $Matches.key.Trim()
        ApiSecret = $Matches.secret.Trim()
      }
    }

    if ($inKeysSection -and $line -match '^\S') {
      break
    }
  }

  throw "Could not read LiveKit credentials from $ConfigPath"
}

$configPath = (Resolve-Path (Join-Path $PSScriptRoot '..\docker\livekit-dev.yaml')).Path
$credentials = Get-LiveKitDevCredentials -ConfigPath $configPath

$existing = docker ps -a --filter "name=^/$Name$" --format "{{.Names}}"
if ($existing) {
  $running = docker ps --filter "name=^/$Name$" --format "{{.Names}}"
  if ($running) {
    Write-Host "LiveKit dev container is already running: $Name"
    exit 0
  }

  docker start $Name | Out-Null
  Write-Host "LiveKit dev container started: $Name"
  exit 0
}

docker run -d `
  --name $Name `
  --restart unless-stopped `
  -p 7880:7880 `
  -p 7881:7881 `
  -p 7882:7882/udp `
  -v "$configPath:/livekit.yaml:ro" `
  $Image `
  --config /livekit.yaml | Out-Null

Write-Host "LiveKit dev container created and started: $Name"
Write-Host "WS URL: ws://localhost:7880"
Write-Host "API key: $($credentials.ApiKey)"
Write-Host "API secret: $($credentials.ApiSecret)"
