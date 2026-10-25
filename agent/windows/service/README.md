# Experimental .NET Windows Service agent

This is an experimental implementation. It has been exercised against a live backend on one Windows endpoint, but still needs repeatable installer tests and broader OS/security validation before production fleet use.

## Build and CI package

The GitHub Actions `CI` workflow builds a framework-dependent Windows x64 package and uploads it as `GogoEndpointCentral-Windows-x64-experimental` for 7 days. Download it from the successful workflow run's **Artifacts** section. It is an unsigned test package, not a signed production release. The target machine must have the .NET 8 runtime installed.

To build locally:

    dotnet publish .\agent\windows\service\GogoEndpointCentral.Service.csproj -c Release -r win-x64 --self-contained false -o .\agent\windows\service\publish

## Install and enroll

Open an elevated PowerShell session. The backend must be deployed with a dedicated PostgreSQL database and ready to accept enrollment.

    .\agent\windows\install-agent-service.ps1

The installer copies published files into `C:\Program Files\GogoEndpointCentralAgent`, grants the LocalService account read/execute access to the binaries, configures the service to use that installed path, and applies a service-specific ACL to the state directory. Re-running it updates an existing service and preserves enrollment state. If the service was running and enrollment state exists, the installer restarts it after the update.

For a new device, enroll using the installed executable:

    & "$env:ProgramFiles\GogoEndpointCentralAgent\GogoEndpointCentral.Service.exe" --enroll

Enrollment prompts for an HTTPS server URL and single-use token, with token input masked. The token is encrypted with machine-scope DPAPI. After successful enrollment, configure automatic startup and start the service:

    Set-Service -Name GogoEndpointCentralAgent -StartupType Automatic
    Start-Service -Name GogoEndpointCentralAgent
    Get-Service -Name GogoEndpointCentralAgent

Run `.\agent\windows\test-agent-service.ps1` from an elevated PowerShell session to check service registration, configuration, encrypted token decryption (when the published executable is present), backend readiness, and state-directory ACL scope. Use `-SkipRemoteCheck` to skip the HTTP readiness request. The diagnostic is read-only and does not prove a heartbeat was accepted. The executable also supports `--check-state`, which validates the HTTPS config and decrypts the machine-scope DPAPI token without printing it.

## Uninstall

    .\agent\windows\uninstall-agent-service.ps1

Enrollment state is preserved by default. For intentional local offboarding, pass `-RemoveEnrollmentState`; also revoke the server-side device credential through the admin dashboard.

## Current limitations

- Initial Windows service host using .NET 8; target OS support still needs verification.
- The installer change needs validation on a clean Windows machine and an already-enrolled upgrade path before broad rollout.
- Reports agent version 0.3.0; heartbeat and basic hardware inventory are implemented.
- CI artifact is an unsigned, framework-dependent test ZIP, not an MSI or signed production release. No code signing, automatic updates, patch management, remote command execution, or production security certification.
- Token rotation failure after server commit requires re-enrollment. Do not retry with the old credential.
