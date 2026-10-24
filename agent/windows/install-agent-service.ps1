[CmdletBinding()]
param([string]$PublishDirectory = (Join-Path $PSScriptRoot "service\publish"))
$ErrorActionPreference = "Stop"
$serviceName = "GogoEndpointCentralAgent"
$stateDirectory = Join-Path $env:ProgramData "GogoEndpointCentral"
$exePath = Join-Path $PublishDirectory "GogoEndpointCentral.Service.exe"
if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) { throw "Service executable not found: $exePath. Publish the project first." }
if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Run from an elevated PowerShell window." }
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
& icacls.exe $stateDirectory /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to secure state directory ACLs." }
if (-not (Get-Service -Name $serviceName -ErrorAction SilentlyContinue)) {
  $binPath = '"' + (Resolve-Path -LiteralPath $exePath).Path + '"'
  & sc.exe create $serviceName "binPath= $binPath" "start= demand" "obj= NT AUTHORITY\LocalService" "DisplayName= GOGO Endpoint Central Agent"
  if ($LASTEXITCODE -ne 0) { throw "Failed to create service." }
}
& sc.exe sidtype $serviceName unrestricted
if ($LASTEXITCODE -ne 0) { throw "Failed to enable service SID." }
& icacls.exe $stateDirectory /grant 'NT SERVICE\GogoEndpointCentralAgent:(OI)(CI)M' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to grant service-SID group access." }
Write-Host "Service installed but not started. Enroll first:"
Write-Host ('& "' + $exePath + '" --enroll')
Write-Host ('Then run: Start-Service -Name ' + $serviceName)
Write-Host "Review ACLs on the target host before production use."
