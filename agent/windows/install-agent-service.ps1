[CmdletBinding()]
param(
    [string]$PublishDirectory = (Join-Path $PSScriptRoot "service\publish"),
    [string]$InstallDirectory = (Join-Path $env:ProgramFiles "GogoEndpointCentralAgent")
)

$ErrorActionPreference = "Stop"
$serviceName = "GogoEndpointCentralAgent"
$serviceDisplayName = "GOGO Endpoint Central Agent"
$stateDirectory = Join-Path $env:ProgramData "GogoEndpointCentral"
$exeName = "GogoEndpointCentral.Service.exe"

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run from an elevated PowerShell window."
}

if (-not (Test-Path -LiteralPath $PublishDirectory -PathType Container)) {
    throw "Publish directory not found: $PublishDirectory. Publish the project first."
}
$publishPath = (Resolve-Path -LiteralPath $PublishDirectory).Path
$sourceExe = Join-Path $publishPath $exeName
if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf)) {
    throw "Service executable not found: $sourceExe. Publish the project first."
}

$installPath = [System.IO.Path]::GetFullPath($InstallDirectory)
$exePath = Join-Path $installPath $exeName
$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
$wasRunning = $false

if ($existingService) {
    $wasRunning = $existingService.Status -eq [System.ServiceProcess.ServiceControllerStatus]::Running
    if ($wasRunning) {
        Write-Host "Stopping existing service before updating its files..."
        Stop-Service -Name $serviceName -Force
        (Get-Service -Name $serviceName).WaitForStatus(
            [System.ServiceProcess.ServiceControllerStatus]::Stopped,
            [TimeSpan]::FromSeconds(30)
        )
    }
}

New-Item -ItemType Directory -Path $installPath -Force | Out-Null
Copy-Item -Path (Join-Path $publishPath "*") -Destination $installPath -Recurse -Force

# The service runs as LocalService, so it needs read/execute access to the binaries.
& icacls.exe $installPath /grant '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' /T /C | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Failed to secure installation directory ACLs."
}

New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
& icacls.exe $stateDirectory /grant '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Failed to secure state directory ACLs."
}

$stateFilesExist = (Test-Path -LiteralPath (Join-Path $stateDirectory "config.json") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $stateDirectory "agent-token.dpapi") -PathType Leaf)

$binPath = '"' + $exePath + '"'
$startMode = if ($stateFilesExist) { "auto" } else { "demand" }

if (-not $existingService) {
    & sc.exe create $serviceName "binPath= $binPath" "start= $startMode" 'obj= "NT AUTHORITY\LocalService"' $('DisplayName= "' + $serviceDisplayName + '"' )
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create service."
    }
}
else {
    & sc.exe config $serviceName "binPath= $binPath" "start= $startMode" 'obj= "NT AUTHORITY\LocalService"' $('DisplayName= "' + $serviceDisplayName + '"' )
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to update service configuration."
    }
}

& sc.exe sidtype $serviceName unrestricted
if ($LASTEXITCODE -ne 0) {
    throw "Failed to enable service SID."
}

& icacls.exe $stateDirectory /grant 'NT SERVICE\GogoEndpointCentralAgent:(OI)(CI)M' | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Failed to grant service-SID access to the state directory."
}

Write-Host "Agent files installed to: $installPath"
Write-Host "Service executable: $exePath"
Write-Host "Enrollment state detected: $stateFilesExist"

if (-not $stateFilesExist) {
    Write-Host "Next, enroll this device from an elevated PowerShell session:"
    Write-Host ('& "' + $exePath + '" --enroll')
    Write-Host "After successful enrollment, run:"
    Write-Host ('Set-Service -Name ' + $serviceName + ' -StartupType Automatic')
    Write-Host ('Start-Service -Name ' + $serviceName)
}
else {
    Write-Host "Existing enrollment state was preserved."
    if ($wasRunning) {
        Start-Service -Name $serviceName
        (Get-Service -Name $serviceName).WaitForStatus(
            [System.ServiceProcess.ServiceControllerStatus]::Running,
            [TimeSpan]::FromSeconds(30)
        )
        Write-Host "Updated service restarted successfully."
    }
    else {
        Write-Host ('Start the service with: Start-Service -Name ' + $serviceName)
    }
}
