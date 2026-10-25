# Windows Service Agent: implementation decision

Status: proposed implementation contract for the next agent milestone.

## Why the current PowerShell task is not the service

The existing PowerShell agent stores its bearer token using current-user DPAPI under `%LOCALAPPDATA%`. That is intentionally tied to the enrolling user's profile. A Windows Service runs under a service identity, may start before interactive logon, and cannot be assumed to read or decrypt that user's credential. Reusing the current token file from a service would either fail or encourage weakening file permissions.

The existing Scheduled Task remains an interim, per-user prototype. Do not silently relabel it as a service.

## Chosen direction

Implement a small .NET Worker Service targeting a supported .NET LTS runtime and hosted through the Windows Service Control Manager. Keep the service and its enrollment/configuration utility as separate entry points.

- Service identity: a dedicated virtual service account / service SID, with least privilege. Do not run as an interactive user or LocalSystem unless a specific Windows API requirement justifies it.
- State directory: `%ProgramData%\\GogoEndpointCentral\\`.
- Secret protection: Windows DPAPI `LocalMachine` scope for the encrypted agent token, combined with restrictive NTFS ACLs on the directory and token file. Grant access only to `SYSTEM`, local administrators, and the exact service SID as required. Machine-scope DPAPI alone is not an access-control boundary.
- Enrollment: a separate elevated enrollment utility prompts for the single-use enrollment token without command-line arguments, calls `POST /api/agent/enroll`, writes the returned agent token atomically to the protected state file, and never logs the token. Do not place bearer tokens in service arguments, environment variables, or logs.
- Configuration: HTTPS server URL and non-secret operational settings stored separately from the token. Reject non-HTTPS URLs.
- Heartbeat: send the existing supported fields to `POST /api/agent/heartbeat`; use bounded exponential backoff, cancellation-aware waits, and structured logs that never include authorization headers or response token bodies.
- Rotation: rotate through `POST /api/agent/rotate-token`; persist the replacement atomically before continuing. If the server committed rotation but local persistence fails, stop and surface an actionable error requiring re-enrollment, matching the current agent's safety behavior.
- Lifecycle: handle SCM start/stop, cancellation, recovery after transient network failures, and clean uninstall. Do not remove credentials on uninstall unless the operator explicitly requests device offboarding.
- Installer: signed MSI or signed installer package after repeatable builds and a documented code-signing process. Never claim it is signed before a real signing certificate has been used.

## Required acceptance checks

1. CI builds the service and enrollment utility on Windows.
2. Unit tests cover URL validation, retry delay bounds, secret-redaction, and token-file atomic replacement.
3. Windows integration test verifies service start/stop and restart recovery under the configured service identity.
4. Enrollment token is single-use; bearer token is never printed in console output or logs.
5. Token file ACLs are checked in an elevated Windows test; an ordinary unrelated user cannot read it.
6. Rotation failure paths are tested, especially server-side rotation success followed by local write failure.
7. Service reports a heartbeat to a non-demo backend and inventory shows the latest heartbeat.
8. Install/uninstall is idempotent and leaves credentials intact unless explicit offboarding is selected.

## Migration and rollout

- Keep `GogoEndpointAgent.ps1` and the Scheduled Task helper documented as experimental during the transition.
- Do not automatically migrate a current-user DPAPI token to the service. Require fresh single-use enrollment for the service identity/state store, or add a separately reviewed, explicit migration flow.
- Do not deploy the service by default until the Windows CI build and integration checks pass.
- Do not deploy the cloud backend or merge the draft PR as part of this work; the current environment still needs a dedicated PostgreSQL database and explicit deployment approval.

## Out of scope for the first service release

Remote shell/command execution, patch installation, arbitrary file transfer, process termination, and broad device-control capabilities. First establish secure enrollment, reliable heartbeat, rotation, service lifecycle, and observable health.
