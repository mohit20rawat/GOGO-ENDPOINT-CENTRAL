# GOGO Endpoint Central - Windows heartbeat agent
# Prototype: run in the same Windows user context that enrolled the device.
# The token file is DPAPI-encrypted for the current user. This is not yet a Windows service.

[CmdletBinding()]
param(
  [string]$ServerUrl,
  [switch]$Enroll,
  [ValidateRange(15, 3600)]
  [int]$IntervalSeconds = 60
)

$ErrorActionPreference = "Stop"
$AgentVersion = "0.1.0"
$StateDirectory = Join-Path $env:LOCALAPPDATA "GogoEndpointAgent"
$TokenPath = Join-Path $StateDirectory "agent-token.dpapi"
$ServerUrlPath = Join-Path $StateDirectory "server-url.txt"

function Get-ServerBaseUrl {
  param([string]$Candidate)
  if ([string]::IsNullOrWhiteSpace($Candidate) -and (Test-Path -LiteralPath $ServerUrlPath)) {
    $Candidate = (Get-Content -LiteralPath $ServerUrlPath -Raw).Trim()
  }
  if ([string]::IsNullOrWhiteSpace($Candidate)) { throw "Provide -ServerUrl, for example https://your-service.onrender.com" }
  $uri = $null
  if (-not [Uri]::TryCreate($Candidate, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne "https") {
    throw "ServerUrl must be an absolute HTTPS URL."
  }
  return $uri.AbsoluteUri.TrimEnd("/")
}

function Save-AgentToken {
  param([Parameter(Mandatory = $true)][string]$Token)
  New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
  $encrypted = ConvertTo-SecureString -String $Token -AsPlainText -Force | ConvertFrom-SecureString
  Set-Content -LiteralPath $TokenPath -Value $encrypted -Encoding ASCII
}

function Get-AgentToken {
  if (-not (Test-Path -LiteralPath $TokenPath)) { throw "No enrolled agent token found. Run this script with -Enroll first." }
  $encrypted = (Get-Content -LiteralPath $TokenPath -Raw).Trim()
  $secure = ConvertTo-SecureString -String $encrypted
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    $secure.Dispose()
  }
}

function Invoke-Enrollment {
  param([string]$BaseUrl)
  $secureEnrollmentToken = Read-Host "Paste single-use enrollment token" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureEnrollmentToken)
  $enrollmentToken = $null
  try {
    $enrollmentToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    $os = Get-CimInstance Win32_OperatingSystem
    $body = @{
      enrollmentToken = $enrollmentToken
      name = $env:COMPUTERNAME
      os = "Windows"
      osVersion = [string]$os.Caption + " " + [string]$os.Version
    } | ConvertTo-Json
    $response = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/agent/enroll" -ContentType "application/json" -Body $body -TimeoutSec 20
    if ([string]::IsNullOrWhiteSpace([string]$response.agentToken)) { throw "Server response did not include an agent token." }
    Save-AgentToken -Token ([string]$response.agentToken)
    Set-Content -LiteralPath $ServerUrlPath -Value $BaseUrl -Encoding ASCII
    Write-Host "Enrolled device ID: $($response.deviceId)"
    Write-Host "Agent token saved using Windows DPAPI for the current user."
    $response.agentToken = $null
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    $secureEnrollmentToken.Dispose()
    $enrollmentToken = $null
  }
}

$baseUrl = Get-ServerBaseUrl -Candidate $ServerUrl
if ($Enroll) { Invoke-Enrollment -BaseUrl $baseUrl }

$token = Get-AgentToken
Write-Host "GOGO Endpoint Central agent $AgentVersion started. Heartbeat interval: $IntervalSeconds seconds."
try {
  while ($true) {
    try {
      $headers = @{ Authorization = "Bearer $token" }
      $body = @{ agentVersion = $AgentVersion } | ConvertTo-Json
      $result = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/agent/heartbeat" -Headers $headers -ContentType "application/json" -Body $body -TimeoutSec 20
      Write-Host "$(Get-Date -Format o) heartbeat accepted for $($result.deviceId)"
    } catch {
      # Avoid logging authorization headers, response bodies, or token material.
      Write-Warning "$(Get-Date -Format o) heartbeat failed: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds $IntervalSeconds
  }
} finally { $token = $null }
