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

Enrollment prompts for an HTTPS server URL and single-use token, with token input masked. The service uses machine-scope DPAPI for its token, alongside NTFS ACLs. The installer creates the service with demand start so enrollment can finish before service start. After enrollment, run `.\agent\windows\test-agent-service.ps1` from an elevated PowerShell session to check service registration, configuration, encrypted token decryption (when the published executable is present), backend readiness, and state-directory ACL scope. Use `-SkipRemoteCheck` to skip the HTTP readiness request. The diagnostic is read-only and does not prove a heartbeat was accepted. The executable also supports `--check-state`, which validates the HTTPS config and decrypts the machine-scope DPAPI token without printing it.

## Uninstall

    .\agent\windows\uninstall-agent-service.ps1

Enrollment state is preserved by default. For intentional local offboarding, pass -RemoveEnrollmentState; also revoke the server-side device credential through the admin dashboard.

## Current limitations

- Initial Windows service host using .NET 8; target OS support still needs verification.
- Service SID ACL behavior and installer command-line quoting still require verification on a real Windows host. Review the resulting ACL before production.
- Reports agent version 0.2.0; telemetry is limited to heartbeat/version.
- No MSI, code signing, automatic updates, patch management, remote command execution, or production security certification.
- Token rotation failure after server commit requires re-enrollment. Do not retry with the old credential.
- Not yet validated against a live backend or real Windows endpoint.
