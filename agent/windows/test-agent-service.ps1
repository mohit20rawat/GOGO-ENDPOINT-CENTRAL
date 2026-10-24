[CmdletBinding()]
param([switch]$SkipRemoteCheck)
$ErrorActionPreference = "Stop"
$serviceName = "GogoEndpointCentralAgent"
$stateDirectory = Join-Path $env:ProgramData "GogoEndpointCentral"
$configPath = Join-Path $stateDirectory "config.json"
$tokenPath = Join-Path $stateDirectory "agent-token.dpapi"
$issues = [System.Collections.Generic.List[string]]::new()

function Write-Check {
  param([string]$Name, [bool]$Passed, [string]$Detail)
  $label = if ($Passed) { "PASS" } else { "CHECK" }
  $color = if ($Passed) { "Green" } else { "Yellow" }
  Write-Host ("[{0}] {1}: {2}" -f $label, $Name, $Detail) -ForegroundColor $color
  if (-not $Passed) { $issues.Add($Name) }
}

Write-Host "GOGO Endpoint Central Windows service diagnostics (read-only)" -ForegroundColor Cyan
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
Write-Check "Windows service" ($null -ne $service) $(if ($service) { "found; status $($service.Status)" } else { "not installed; run install-agent-service.ps1" })

Write-Check "ProgramData state directory" (Test-Path -LiteralPath $stateDirectory -PathType Container) $(if (Test-Path -LiteralPath $stateDirectory -PathType Container) { "exists" } else { "missing" })
Write-Check "Service config" (Test-Path -LiteralPath $configPath -PathType Leaf) $(if (Test-Path -LiteralPath $configPath -PathType Leaf) { "exists; contents not printed" } else { "missing; enroll the service first" })
Write-Check "Encrypted agent token" (Test-Path -LiteralPath $tokenPath -PathType Leaf) $(if (Test-Path -LiteralPath $tokenPath -PathType Leaf) { "encrypted token file exists; contents hidden" } else { "missing; enroll the service first" })

if (Test-Path -LiteralPath $configPath -PathType Leaf) {
  try {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $uri = $null
    $validUrl = [Uri]::TryCreate([string]$config.serverUrl, [UriKind]::Absolute, [ref]$uri) -and $uri.Scheme -eq "https"
    Write-Check "HTTPS server URL" $validUrl $(if ($validUrl) { $uri.GetLeftPart([UriPartial]::Authority) } else { "config must contain an absolute HTTPS serverUrl" })
    if ($validUrl -and -not $SkipRemoteCheck) {
      try {
        $response = Invoke-WebRequest -Uri ($uri.ToString().TrimEnd("/") + "/api/ready") -Method Get -TimeoutSec 15 -UseBasicParsing
        Write-Check "Backend readiness" ($response.StatusCode -eq 200) ("HTTP {0} from /api/ready" -f $response.StatusCode)
      } catch {
        $status = $null
        try { $status = [int]$_.Exception.Response.StatusCode } catch {}
        Write-Check "Backend readiness" $false $(if ($status) { "HTTP $status from /api/ready" } else { "request failed; check network, TLS, URL, and backend logs" })
      }
    } elseif ($SkipRemoteCheck) {
      Write-Host "[SKIP] Backend readiness: remote check disabled by parameter"
    }
  } catch {
    Write-Check "Service config JSON" $false "cannot read valid config JSON; contents hidden"
  }
}

if (Test-Path -LiteralPath $stateDirectory -PathType Container) {
  try {
    $acl = Get-Acl -LiteralPath $stateDirectory
    $identities = @($acl.Access | ForEach-Object { $_.IdentityReference.Value })
    $hasServiceSid = $identities -contains "NT SERVICE\GogoEndpointCentralAgent"
    Write-Check "Service state-file permission" $hasServiceSid $(if ($hasServiceSid) { "service-specific SID entry found" } else { "service SID ACL entry missing; rerun installer and review icacls output" })
    $broadPrincipals = @("Everyone", "BUILTIN\Users", "NT AUTHORITY\Authenticated Users")
    $broadAccess = @($identities | Where-Object { $broadPrincipals -contains $_ })
    Write-Check "State directory ACL scope" ($broadAccess.Count -eq 0) $(if ($broadAccess.Count -eq 0) { "no broad user-group entries detected" } else { "broad entries detected: $($broadAccess -join ', ')" })
  } catch {
    Write-Check "State directory ACL" $false "could not read ACL; run diagnostics from an elevated PowerShell session"
  }
}

if ($service -and $service.Status -eq "Running") {
  Write-Host "The service is running. This diagnostic does not prove that the server accepted a heartbeat."
} elseif ($service) {
  Write-Host "Service is not running. Inspect Windows Event Viewer and service logs before retrying."
}

if ($issues.Count -eq 0) {
  Write-Host "No checked configuration issues detected." -ForegroundColor Green
  exit 0
}
Write-Host ("Items to review: " + ($issues -join ", ")) -ForegroundColor Yellow
Write-Host "Read-only diagnostics: no files, services, ACLs, or credentials were changed."
exit 1
