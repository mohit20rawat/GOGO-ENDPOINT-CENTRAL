# Cloud deployment checklist

This project is a prototype. Use a **new, dedicated PostgreSQL database** for GOGO Endpoint Central. Do not point it at another application's database: startup creates tables and backfills legacy rows without a tenant to the initial workspace.

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

## 3. Deploy only the reviewed branch

The current Render service may still be configured for the earlier MVP branch. Do not assume the feature branch is live. Review and merge the draft pull request only after CI passes, then configure Render to deploy the intended branch. Avoid manually deploying an unreviewed branch.

## 4. Verify after deployment

1. Open `/health`; expect HTTP 200 and `{"status":"ok","service":"gogo-endpoint-central"}`.
2. Open `/api/ready`; expect `mode: "database"`, `persistence: "postgresql"`, and `authRequired: true`.
3. Sign in through the app using the bootstrap administrator.
4. Confirm inventory is available, sign out, and verify protected API routes reject missing or expired sessions.
5. Review Render logs for startup/database errors. Never log connection strings, passwords, or bearer tokens.

## Important limitations

- The app is not production-hardened. Obtain a security review before real organizational use.
- PostgreSQL TLS certificate verification is enabled by default. Validate the chosen provider's certificate chain and connectivity before handling sensitive data. Do not set `DATABASE_SSL=disable` in production.
- Backups, restore drills, password reset, MFA/SSO, distributed rate limiting, tenant onboarding, agent packaging/signing, secure OS token storage, and device-management actions remain unfinished.
- PostgreSQL integration tests run in CI against an isolated disposable database. A successful CI run does not prove a managed provider or Render environment has been configured.
