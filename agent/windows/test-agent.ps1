# Read-only diagnostics for the current user's GOGO Endpoint Central agent setup.
# Does not print or transmit the agent credential.
[CmdletBinding()]
param(
  [switch]$SkipRemoteCheck
)
$ErrorActionPreference = "Stop"
$stateDirectory = Join-Path $env:LOCALAPPDATA "GogoEndpointAgent"
$tokenPath = Join-Path $stateDirectory "agent-token.dpapi"
$serverPath = Join-Path $stateDirectory "server-url.txt"
$taskName = "GOGO Endpoint Central Agent"
$issues = [System.Collections.Generic.List[string]]::new()

function Write-Check {
  param([string]$Name, [bool]$Passed, [string]$Detail)
  $label = if ($Passed) { "PASS" } else { "CHECK" }
  $color = if ($Passed) { "Green" } else { "Yellow" }
  Write-Host ("[{0}] {1}: {2}" -f $label, $Name, $Detail) -ForegroundColor $color
  if (-not $Passed) { $issues.Add($Name) }
}

Write-Host "GOGO Endpoint Central agent diagnostics (read-only)" -ForegroundColor Cyan
Write-Host "User: $([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)"
Write-Check "State directory" (Test-Path -LiteralPath $stateDirectory -PathType Container) $(if (Test-Path -LiteralPath $stateDirectory -PathType Container) { "exists" } else { "missing" })
Write-Check "Saved agent token" (Test-Path -LiteralPath $tokenPath -PathType Leaf) $(if (Test-Path -LiteralPath $tokenPath -PathType Leaf) { "encrypted token file exists; contents hidden" } else { "not found; enroll this user first" })
Write-Check "Saved server URL" (Test-Path -LiteralPath $serverPath -PathType Leaf) $(if (Test-Path -LiteralPath $serverPath -PathType Leaf) { "found" } else { "not found" })

if (Test-Path -LiteralPath $tokenPath -PathType Leaf) {
  try {
    $encrypted = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
    $secure = ConvertTo-SecureString -String $encrypted
    if ($secure.Length -lt 1) { throw "Empty credential" }
    $secure.Dispose()
    Write-Check "Token decryption" $true "DPAPI credential can be opened by this Windows user"
  } catch {
    Write-Check "Token decryption" $false "cannot decrypt under this user profile; re-enrollment may be required"
  }
}

$serverUrl = $null
if (Test-Path -LiteralPath $serverPath -PathType Leaf) {
  $serverUrl = (Get-Content -LiteralPath $serverPath -Raw).Trim()
  $uri = $null
  $validUrl = [Uri]::TryCreate($serverUrl, [UriKind]::Absolute, [ref]$uri) -and $uri.Scheme -eq "https"
  Write-Check "HTTPS server URL" $validUrl $(if ($validUrl) { $uri.GetLeftPart([UriPartial]::Authority) } else { "saved URL is invalid or not HTTPS" })

  if ($validUrl -and -not $SkipRemoteCheck) {
    try {
      $response = Invoke-WebRequest -Uri ($serverUrl.TrimEnd("/") + "/api/ready") -Method Get -TimeoutSec 15 -UseBasicParsing
      $ready = $response.StatusCode -eq 200
      $mode = "unknown"
      try { $body = $response.Content | ConvertFrom-Json; if ($body.mode) { $mode = [string]$body.mode } } catch {}
      Write-Check "Backend readiness" $ready ("HTTP {0}; mode {1}" -f $response.StatusCode, $mode)
    } catch {
      $status = $null
      try { $status = [int]$_.Exception.Response.StatusCode } catch {}
      Write-Check "Backend readiness" $false $(if ($status) { "HTTP $status from /api/ready" } else { "request failed; check network, TLS, URL, and backend logs" })
    }
  } elseif ($SkipRemoteCheck) {
    Write-Host "[SKIP] Backend readiness: remote check disabled by parameter"
  }
}

try {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop
  $taskHealthy = $task.State -ne "Disabled"
  $detail = "state $($task.State); last result $($taskInfo.LastTaskResult)"
  Write-Check "Auto-start task" $taskHealthy $detail
} catch {
  Write-Check "Auto-start task" $false "not installed; run install-agent.ps1 after enrollment"
}

if ($issues.Count -eq 0) {
  Write-Host "No local configuration issues detected. This does not prove a heartbeat was accepted." -ForegroundColor Green
} else {
  Write-Host ("Items to review: " + ($issues -join ", ")) -ForegroundColor Yellow
  Write-Host "Diagnostics are advisory. No files, tasks, or credentials were changed."
}
