[CmdletBinding()]
param([switch]$RemoveEnrollmentState)
$ErrorActionPreference = "Stop"
$serviceName = "GogoEndpointCentralAgent"
$stateDirectory = Join-Path $env:ProgramData "GogoEndpointCentral"
if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Run from an elevated PowerShell window." }
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($service) {
  if ($service.Status -ne "Stopped") { Stop-Service -Name $serviceName -Force }
  & sc.exe delete $serviceName
  if ($LASTEXITCODE -ne 0) { throw "Failed to remove service." }
  Write-Host "Removed service '$serviceName'."
} else { Write-Host "Service '$serviceName' is not installed." }
if ($RemoveEnrollmentState -and (Test-Path -LiteralPath $stateDirectory)) {
  Remove-Item -LiteralPath $stateDirectory -Recurse -Force
  Write-Host "Local state removed. Revoke the server-side credential separately."
} else { Write-Host "Enrollment state preserved. Pass -RemoveEnrollmentState only for intentional offboarding." }
