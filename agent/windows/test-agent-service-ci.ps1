[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$serviceName = "GogoEndpointCentralAgent"
$stateDirectory = Join-Path $env:ProgramData "GogoEndpointCentral"
$installDirectory = Join-Path $env:RUNNER_TEMP "GogoEndpointCentralAgent-SmokeTest"
$publishDirectory = Join-Path $PSScriptRoot "service\publish"
$serviceExe = Join-Path $installDirectory "GogoEndpointCentral.Service.exe"
$entropy = [Text.Encoding]::UTF8.GetBytes("GOGO-EndpointCentral-Agent-v1")
$token = "ci-smoke-test-token-0123456789abcdef"

function Assert($condition, [string]$message) {
    if (-not $condition) { throw "FAIL: $message" }
    Write-Host "PASS: $message"
}

try {
    if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
        throw "A service named $serviceName already exists on this runner."
    }

    # Mirror the real enrollment sequence: install first, then write state so
    # the service-SID inheritable ACL protects the newly created files.
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    & (Join-Path $PSScriptRoot "install-agent-service.ps1") -PublishDirectory $publishDirectory -InstallDirectory $installDirectory

    Assert (Test-Path -LiteralPath $serviceExe -PathType Leaf) "published Windows service executable installed"

    $config = @{ serverUrl = "https://127.0.0.1:9" } | ConvertTo-Json
    Set-Content -LiteralPath (Join-Path $stateDirectory "config.json") -Value $config -Encoding UTF8
    Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
    $clearToken = [Text.Encoding]::UTF8.GetBytes($token)
    try {
        $encrypted = [Security.Cryptography.ProtectedData]::Protect($clearToken, $entropy, [Security.Cryptography.DataProtectionScope]::LocalMachine)
        [IO.File]::WriteAllBytes((Join-Path $stateDirectory "agent-token.dpapi"), $encrypted)
    }
    finally {
        [Array]::Clear($clearToken, 0, $clearToken.Length)
    }

    $stateOutput = & $serviceExe --check-state 2>&1
    Assert ($LASTEXITCODE -eq 0) "machine-scope DPAPI token decrypts and HTTPS config validates"

    $serviceInfo = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    Assert ($null -ne $serviceInfo) "Windows SCM registered the service"
    Assert ($serviceInfo.StartName -eq "NT AUTHORITY\LocalService") "service runs as NT AUTHORITY\LocalService"

    $sidOutput = (& sc.exe qsidtype $serviceName 2>&1 | Out-String)
    Assert ($LASTEXITCODE -eq 0 -and $sidOutput -match "UNRESTRICTED") "unrestricted service SID is enabled"

    $stateAcl = Get-Acl -LiteralPath $stateDirectory
    $serviceSid = "NT SERVICE\$serviceName"
    $hasServiceSid = @($stateAcl.Access | Where-Object { $_.IdentityReference.Value -eq $serviceSid }).Count -gt 0
    Assert $hasServiceSid "service SID has state-directory access"

    Set-Service -Name $serviceName -StartupType Automatic
    Start-Service -Name $serviceName
    (Get-Service -Name $serviceName).WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
    Assert ((Get-Service -Name $serviceName).Status -eq "Running") "service starts successfully under Windows SCM"

    Stop-Service -Name $serviceName
    (Get-Service -Name $serviceName).WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30))
    Assert ((Get-Service -Name $serviceName).Status -eq "Stopped") "service stops cleanly through Windows SCM"
}
finally {
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($service) {
        if ($service.Status -ne "Stopped") { Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue }
        & (Join-Path $PSScriptRoot "uninstall-agent-service.ps1") -RemoveEnrollmentState
    }
    elseif (Test-Path -LiteralPath $stateDirectory) {
        Remove-Item -LiteralPath $stateDirectory -Recurse -Force
    }
    if (Test-Path -LiteralPath $installDirectory) {
        Remove-Item -LiteralPath $installDirectory -Recurse -Force
    }
}
