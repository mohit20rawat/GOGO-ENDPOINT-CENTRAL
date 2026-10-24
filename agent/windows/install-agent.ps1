# Install a per-user logon task for the GOGO Endpoint Central agent.
# This is a transitional auto-start helper, NOT a Windows Service.
[CmdletBinding()]
param(
  [string]$AgentScriptPath = (Join-Path $PSScriptRoot "GogoEndpointAgent.ps1"),
  [ValidateRange(15, 3600)]
  [int]$IntervalSeconds = 60
)
$ErrorActionPreference = "Stop"
$taskName = "GOGO Endpoint Central Agent"
$stateDirectory = Join-Path $env:LOCALAPPDATA "GogoEndpointAgent"
$tokenPath = Join-Path $stateDirectory "agent-token.dpapi"
$serverPath = Join-Path $stateDirectory "server-url.txt"

if (-not (Test-Path -LiteralPath $AgentScriptPath -PathType Leaf)) {
  throw "Agent script not found: $AgentScriptPath"
}
if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
  throw "Enroll this Windows user first by running GogoEndpointAgent.ps1 -ServerUrl https://YOUR-GOGO-HOST -Enroll, then stop it with Ctrl+C."
}
$serverUrl = (Get-Content -LiteralPath $serverPath -Raw).Trim()
$uri = $null
if (-not [Uri]::TryCreate($serverUrl, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne "https") {
  throw "Saved server URL is invalid. Re-enroll with an HTTPS URL."
}
$powerShell = Join-Path $PSHOME "powershell.exe"
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "' + (Resolve-Path -LiteralPath $AgentScriptPath).Path + '" -IntervalSeconds ' + $IntervalSeconds
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Starts the GOGO Endpoint Central agent in the enrolling user's profile after logon." -Force | Out-Null
Write-Host "Installed per-user logon task '$taskName'."
Write-Host "It runs only after this user logs on so DPAPI can decrypt this user's agent token."
Write-Host "This is not a Windows Service; the agent will not report while the user is logged off."
