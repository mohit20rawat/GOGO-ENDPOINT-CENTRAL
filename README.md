# GOGO Endpoint Central

Cloud-ready starter for a unified endpoint management platform. This is a prototype, not a feature-complete replacement for commercial UEM software.

## Current capabilities
- Responsive inventory dashboard and sample data
- PostgreSQL persistence for tenants, users, sessions, inventory and example audit events
- Password hashing with bcrypt and opaque random bearer sessions stored as SHA-256 hashes
- 8-hour session expiry, logout, and admin-only user creation
- Roles: `admin`, `operator`, and `viewer`
- Tenant-scoped device summary, inventory, and audit queries
- CI tests via Node's built-in test runner

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
- `DATABASE_SSL=disable`: only for a trusted local database without TLS; omit in production

On startup, tables are created if missing. Existing device/audit rows are assigned to the initial `primary` tenant during the first migration. The bootstrap admin is created only if that email is not already present in the tenant. Changing the bootstrap password environment variable does not reset an existing account's password.

The app creates the initial tenant with ID `primary-tenant` and slug `primary`. Additional user accounts can be created by an authenticated admin using `POST /api/admin/users` with `email`, `password`, and `role`.

## Security boundaries
- Database mode requires bearer authentication for inventory, summary, audit, and user administration.
- Session tokens are random, expire after eight hours, and only their SHA-256 hashes are stored.
- Passwords are hashed using bcrypt; raw passwords and tokens are never written to logs.
- SQL queries scope device/audit access to the authenticated tenant.
- This is not yet production-ready: rate limiting, password reset, MFA/SSO, stronger audit logging, tenant onboarding, automated migration tooling, CSP/security headers, backups, monitoring, and formal security review remain.
- Do not connect real endpoints or enable consequential management actions until those controls are reviewed and implemented.

## Deployment
Configure `DATABASE_URL` and the bootstrap administrator secrets in Render's environment settings before using database mode. Do not reuse unrelated databases. Review the database plan, expiration, backups, region and data retention before connecting it. Free services may sleep or have expiring storage and are not suitable for enterprise production.

## Roadmap
1. Dashboard and CI foundation.
2. PostgreSQL persistence.
3. Authentication, roles, and tenant-scoped reads (current milestone).
4. Harden auth with rate limits, password recovery/MFA/SSO, and audited administration.
5. Device enrollment and authenticated agent heartbeat.
6. Patch/software management and policy enforcement with approvals.
7. AI-assisted recommendations with human approval.
