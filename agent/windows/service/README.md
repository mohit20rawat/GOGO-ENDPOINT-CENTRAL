# Experimental .NET Windows Service agent

This is an initial implementation, not yet production-ready. Build and integration tests are required on Windows before use on managed endpoints.

## Build

    dotnet publish .\agent\windows\service\GogoEndpointCentral.Service.csproj -c Release -r win-x64 --self-contained false -o .\agent\windows\service\publish

## Install and enroll

Open an elevated PowerShell session. The backend must be deployed with a dedicated PostgreSQL database and ready to accept enrollment.

    .\agent\windows\install-agent-service.ps1
    & .\agent\windows\service\publish\GogoEndpointCentral.Service.exe --enroll
    Start-Service -Name GogoEndpointCentralAgent
    Get-Service -Name GogoEndpointCentralAgent

Enrollment prompts for an HTTPS server URL and single-use token, with token input masked. The service uses machine-scope DPAPI for its token, alongside NTFS ACLs. The installer creates the service with demand start so enrollment can finish before service start.

## Uninstall

    .\agent\windows\uninstall-agent-service.ps1

Enrollment state is preserved by default. For intentional local offboarding, pass -RemoveEnrollmentState; also revoke the server-side device credential through the admin dashboard.

## Current limitations

- Initial Windows service host using .NET 8; target OS support still needs verification.
- The installer currently grants access through a broad service-SID group and must be tightened to the exact service SID after testing on a real Windows host. Review the resulting ACL before production.
- Reports agent version 0.2.0; telemetry is limited to heartbeat/version.
- No MSI, code signing, automatic updates, patch management, remote command execution, or production security certification.
- Token rotation failure after server commit requires re-enrollment. Do not retry with the old credential.
- Not yet validated against a live backend or real Windows endpoint.
