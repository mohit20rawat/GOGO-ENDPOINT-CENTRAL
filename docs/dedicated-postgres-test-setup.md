# Dedicated PostgreSQL setup for GOGO Endpoint Central

This runbook prepares a **separate test database** for the experimental backend. Do not use `pathology-lims-db`; it belongs to another project.

## 1. Create a dedicated database

Render's current workspace already has the free PostgreSQL instance `pathology-lims-db`, so create a separate database with a provider that offers a free test tier (for example, a new Neon project) or choose a separate paid instance only after reviewing its price. Use a clear name such as `gogo-endpoint-central-test`.

- Keep this database isolated from unrelated applications.
- Choose a region close to the Render web service where possible.
- Do not put the database password or connection string in GitHub, source files, chat, screenshots, or issue comments.
- Save the provider's PostgreSQL connection string securely.

## 2. Configure the backend environment

In the Render dashboard, open the **GOGO Endpoint Central web service** and add these environment variables under its environment settings:

- `DATABASE_URL`: the connection string for the new dedicated database.
- `BOOTSTRAP_ADMIN_EMAIL`: a test administrator email you control.
- `BOOTSTRAP_ADMIN_PASSWORD`: a unique password of at least 12 characters. Do not reuse an existing password.
- `BOOTSTRAP_TENANT_NAME`: `GOGO Test Tenant` (optional).

Use the provider's TLS-enabled connection string. The application verifies PostgreSQL TLS certificates by default; do not set `DATABASE_SSL=disable` for a hosted database. Keep bootstrap credentials out of source control and rotate the bootstrap password after initial setup if the app's bootstrap behavior allows it.

## 3. Do not deploy the feature branch yet

Before deployment, confirm all of the following:

- The service's configured branch is `feat/postgres-persistent-inventory`, not the old MVP branch.
- `DATABASE_URL` points only to the new dedicated test database.
- The service has no unrelated production or pathology data attached.
- A backup/recovery plan exists for any data worth keeping.

Do not merge PR #2 or change the existing service's branch until the database and intended deployment are explicitly confirmed. The application initializes its schema on startup; do not point it at an existing database containing unrelated tables or records.

## 4. Verify safely after deployment is approved

1. Check `/api/ready`; it should return HTTP 200 and a schema version only after the baseline schema and required tables are available.
2. Sign in with the bootstrap admin credentials through the dashboard.
3. Create a single-use enrollment token and enroll one test Windows machine.
4. Confirm the device's last heartbeat and agent version appear in inventory.
5. Restart the service and verify the device inventory persists.
6. Test credential revocation and confirm the device no longer authenticates.

A successful CI run does not replace a live-backend test or a real Windows service test. The current Windows package is unsigned and experimental.
