# GOGO Endpoint Central

Cloud-ready starter for a unified endpoint management platform. This is a prototype, not a feature-complete replacement for commercial UEM software.

## Current capabilities
- Responsive inventory dashboard and sample data
- PostgreSQL persistence for tenants, users, sessions, inventory and example audit events
- Password hashing with bcrypt and opaque random bearer sessions stored as SHA-256 hashes
- 8-hour session expiry, logout, and admin-only user creation
- Roles: `admin`, `operator`, and `viewer`
- Tenant-scoped device summary, inventory, and audit queries
- Admin-created, single-use enrollment tokens that expire after 24 hours
- Database-backed device enrollment API and per-device opaque agent tokens
- Authenticated agent heartbeat API with enrollment/heartbeat rate limits
- Admin-only agent credential revocation with an audit event
- Agent-authenticated transactional token rotation; previous token is invalidated and rotation is audited
- Inventory/summary automatically treat devices with no heartbeat for five minutes as offline
- Tenant-oriented database indexes for common inventory and audit queries
- Atomic, advisory-lock-serialized database initialization with a recorded baseline schema version
- Database readiness checks required tables and the applied baseline migration, not just network connectivity
- Integration coverage for concurrent startup, role permissions, and tenant isolation
- Unit/API tests plus PostgreSQL-backed enrollment, heartbeat, token-rotation, revocation, and audit integration tests in CI

## Run in demo mode
Requires Node.js 20+.

```bash
npm install
npm test
npm start
```

Without `DATABASE_URL`, the app serves sample-only demo data. Login and user administration are intentionally disabled in demo mode. Never use demo mode for real device or company data.

## Configure PostgreSQL and the first administrator
Set these in your hosting provider's secret/environment settings, never in source control:
- `DATABASE_URL`: PostgreSQL connection string
- `BOOTSTRAP_ADMIN_EMAIL`: initial administrator email
- `BOOTSTRAP_ADMIN_PASSWORD`: initial administrator password (minimum 12 characters)
- `BOOTSTRAP_TENANT_NAME`: optional workspace name
- `DATABASE_SSL=disable`: disables TLS and should only be used for a trusted local database; omit in production. PostgreSQL TLS certificate verification is enabled by default. Do not set this to `disable` in production; validate the provider's certificate chain before connecting real data.

On startup, schema initialization runs inside a transaction and is serialized with a PostgreSQL advisory lock so concurrent app instances do not race through setup. A `schema_migrations` table records the baseline version (`001_initial_schema`); this is a migration foundation, not yet a full version-by-version migration framework. Existing device/audit rows are assigned to the initial `primary` tenant during initialization. The bootstrap admin is created only if that email is not already present in the tenant. Changing the bootstrap password environment variable does not reset an existing account's password.

The app creates the initial tenant with ID `primary-tenant` and slug `primary`. Additional user accounts can be created by an authenticated admin using `POST /api/admin/users` with `email`, `password`, and `role`.

## Device enrollment API (early prototype)

These endpoints require PostgreSQL and are not enabled in demo mode.

- An authenticated workspace admin creates a one-use token with `POST /api/admin/enrollment-tokens`.
- A device submits `POST /api/agent/enroll` with `enrollmentToken`, `name`, `os`, and `osVersion`. The token is claimed transactionally, so it cannot be reused.
- Enrollment returns a per-device `agentToken` once. Store it in an OS-protected secret store; never place it in source code or logs.
- The agent sends `POST /api/agent/heartbeat` with `Authorization: Bearer <agentToken>` and an optional `agentVersion`.
- To rotate its credential, the authenticated agent sends `POST /api/agent/rotate-token` with its current bearer token. The response contains the replacement `agentToken` once; the old token is invalid immediately after the transaction commits. Persist the replacement securely before continuing normal heartbeats.
- Enrollment tokens expire after 24 hours. Admins can revoke a device's agent credential with `POST /api/admin/devices/:deviceId/revoke-agent`; the device is marked offline and the action is audited. Re-enrollment is required afterward.

This is API groundwork only. A signed, packaged agent, platform-specific secure token storage, replay protection, device uninstall/offboarding, and integration tests against a production-like managed PostgreSQL service are still recommended; CI now exercises the lifecycle against a disposable PostgreSQL 16 service. Do not deploy agents to production devices yet.

## Security boundaries
- Database mode requires bearer authentication for inventory, summary, audit, and user administration.
- Session tokens are random, expire after eight hours, and only their SHA-256 hashes are stored.
- Passwords are hashed using bcrypt; raw passwords and tokens are never written to logs.
- SQL queries scope device/audit access to the authenticated tenant.
- This is not yet production-ready: password reset, MFA/SSO, richer audit logging, tenant onboarding, automated migration tooling, a restrictive Content Security Policy, backups, monitoring, formal security review remain.
- Do not connect real endpoints or enable consequential management actions until those controls are reviewed and implemented.

## Deployment
See [the cloud deployment checklist](docs/deployment.md) for database isolation, Render environment variables, and post-deploy verification. Configure `DATABASE_URL` and the bootstrap administrator secrets in Render's environment settings before using database mode. Do not reuse unrelated databases. Review the database plan, expiration, backups, region and data retention before connecting it. Free services may sleep or have expiring storage and are not suitable for enterprise production.

## Roadmap
1. Dashboard and CI foundation.
2. PostgreSQL persistence.
3. Authentication, roles, and tenant-scoped reads (current milestone).
4. Harden auth with rate limits, password recovery/MFA/SSO, and audited administration.
5. Device enrollment, authenticated heartbeat, stale-device detection, agent credential revocation, and effective-status filtering (API prototype).
6. Signed platform-specific agent, secure token storage, replay protection, and managed-PostgreSQL validation (CI now runs lifecycle integration tests against PostgreSQL 16).
7. Patch/software management and policy enforcement with approvals.
8. AI-assisted recommendations with human approval.
