# Cloud deployment checklist

This project is a prototype. Use a **new, dedicated PostgreSQL database** for GOGO Endpoint Central. Do not point it at another application's database. Startup applies the numbered migrations in `migrations.js`; the initial migration creates the schema and assigns legacy rows without a tenant to the initial workspace.

## 1. Provision a dedicated database

- Create a fresh PostgreSQL database with a managed provider (for example, Neon).
- Choose a region close to the Render web service when possible.
- Copy the provider's pooled or direct connection string as recommended by that provider.
- Keep the connection string private. Do not commit it, paste it into an issue, or put it in frontend code.
- Do not use the existing `pathology-lims-db` database; it belongs to a different application.

## 2. Configure the Render service

In the Render dashboard for `gogo-endpoint-central`, open **Environment** and add these variables:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Private connection string for the dedicated GOGO database |
| `BOOTSTRAP_ADMIN_EMAIL` | An administrator email you control |
| `BOOTSTRAP_ADMIN_PASSWORD` | A unique password with at least 12 characters; use a password manager |
| `BOOTSTRAP_TENANT_NAME` | Optional workspace label |

Do not set bootstrap credentials to example values. Treat the bootstrap password like a secret; do not put it in GitHub. The app creates the initial admin only if that email is not already present in the initial tenant.

## 3. Migration and deployment safety

- Before applying a schema migration to any database containing important data, take a backup and verify that it can be restored to a separate database.
- Test migrations first against the disposable PostgreSQL database used by CI or another isolated test database.
- CI runs `scripts/postgres-restore-drill.sh` after PostgreSQL integration tests. The script is deliberately restricted to a loopback host and a source database named exactly `gogo_test`; it creates a separate `gogo_restore_test` database, restores a custom-format dump, verifies the migration ledger and required tables, then removes the restore database.
- The drill refuses to overwrite an existing restore database and never accepts a remote/managed database host. Do not weaken these guards to test against Render or a managed database.
- To run locally, use a disposable local PostgreSQL instance with `pg_dump`, `pg_restore`, `psql`, `createdb`, and `dropdb` installed. Set `POSTGRES_TEST_DATABASE_URL` to a local URL whose database name is exactly `gogo_test`, run the integration tests first, then run `bash scripts/postgres-restore-drill.sh`. The temporary dump is deleted automatically. Set `KEEP_RESTORE_DB=1` only when you intentionally want to inspect the restored disposable database.
- Add a new numbered migration for every schema change; do not edit a migration that may already have run. The migration runner applies pending migrations under an advisory lock and records versions transactionally.
- Migrations are forward-only. Rolling back application code does not automatically reverse schema changes; restoring a verified backup may be required.

## 4. Deploy only the reviewed branch

The current Render service may still be configured for the earlier MVP branch. Do not assume the feature branch is live. Review and merge the draft pull request only after CI passes, then configure Render to deploy the intended branch. Avoid manually deploying an unreviewed branch.

## 5. Authentication and rate-limit notes

- Sign-in attempts are limited to 10 per 15-minute window per client IP.
- Enrollment attempts are limited to 10 per 15-minute window; heartbeat and token rotation share a 120-request-per-minute limiter.
- Administrative user creation, enrollment-token issuance, and agent-credential revocation share a limit of 20 mutations per 15-minute window per client IP.
- Rate limits currently use the process-local in-memory store. They are a useful single-instance guard, not a distributed control; before scaling to multiple application instances, configure a shared rate-limit store so limits cannot be bypassed by spreading requests across instances.
- The application trusts one reverse-proxy hop for client IP resolution, matching the current Render deployment topology. Revalidate this setting if the proxy topology changes.

## 6. Verify after deployment

1. Open `/health`; expect HTTP 200 and `{"status":"ok","service":"gogo-endpoint-central"}`.
2. Open `/api/ready`; expect `mode: "database"`, `persistence: "postgresql"`, and `authRequired: true`.
3. Sign in through the app using the bootstrap administrator.
4. Confirm inventory is available, sign out, and verify protected API routes reject missing or expired sessions.
5. Review Render logs for startup/database errors. Never log connection strings, passwords, or bearer tokens.

## Important limitations

- The app is not production-hardened. Obtain a security review before real organizational use.
- PostgreSQL TLS certificate verification is enabled by default. Validate the chosen provider's certificate chain and connectivity before handling sensitive data. Do not set `DATABASE_SSL=disable` in production.
- Automated backup/restore verification now runs in CI against a local disposable PostgreSQL database. Scheduled backups, off-site retention, provider-specific backup verification, disaster-recovery objectives, password reset, MFA/SSO, distributed rate limiting, tenant onboarding, agent packaging/signing, secure OS token storage, and device-management actions remain unfinished.
- PostgreSQL integration tests run in CI against an isolated disposable database. A successful CI run does not prove a managed provider or Render environment has been configured.
