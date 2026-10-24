# GOGO Endpoint Central

A cloud-ready starter for a unified endpoint management (UEM) platform. The current application has a dashboard, inventory APIs, health checks, and a PostgreSQL persistence layer that can be enabled with an environment variable.

> **Important:** This is still a prototype. The seeded inventory and audit events are examples. It does not enroll, control, lock, patch, or deploy software to real endpoints. Do not store real company device data in this version until authentication, tenant isolation, and production security controls are implemented.

## Current capabilities

- Responsive dashboard with fleet summary, device inventory, search/filter, and CSV export
- JSON APIs: `/health`, `/api/ready`, `/api/summary`, `/api/devices`, and `/api/audit`
- PostgreSQL schema and persistence for inventory and example audit events
- Automatic one-time seed of example data when the database tables are empty
- Parameterized SQL queries and bounded database connection pool
- Automated tests using Node's built-in test runner

## Run locally

Requirements: Node.js 20 or newer.

```bash
npm install
npm test
npm start
```

Open http://localhost:3000. Without `DATABASE_URL`, the app uses in-memory demo data and clearly reports `mode: demo`.

## Enable PostgreSQL

Set `DATABASE_URL` to a PostgreSQL connection string in your local environment or hosting provider. Keep credentials in the provider's secret/environment-variable settings, never in source control. By default, the PostgreSQL connection uses TLS; set `DATABASE_SSL=disable` only for a trusted local database that does not support TLS.

On startup, the app creates the `devices` and `audit_events` tables if they do not exist, then seeds sample records only when each table is empty. Existing database records are not overwritten.

## Deploy to Render

The existing Render web service can continue running in demo mode until a database is attached. After configuring `DATABASE_URL` with a PostgreSQL connection string, redeploy and verify `/api/ready` reports `persistence: postgresql`.

The free service tier may sleep when idle and is not suitable for a production enterprise control plane. Free database offerings may have limits or expiration; confirm current terms in Render before using one for anything important.

## Roadmap

1. Foundation and CI.
2. **Persistent inventory (current milestone):** PostgreSQL schema, health/readiness, safe parameterized queries.
3. Authentication, secure sessions, role-based access control, and tenant isolation.
4. Device enrollment and agent heartbeat.
5. Patch/software deployment, policies, alerts, reports, and protected audit trails.
6. Security hardening, backups, monitoring, and security tests.
7. AI-assisted summaries and recommendations with human approval for consequential actions.

## Security principles

- Never store passwords, API keys, or deployment secrets in source control.
- Do not connect real devices to this prototype.
- High-impact actions must require authentication, authorization, audit logging, and explicit safeguards.
- Production use requires tenant-isolation tests, backups, monitoring, rate limits, threat modelling, and a security review.

## Project status

The dashboard and API are a foundation, not a feature-complete ManageEngine replacement. PostgreSQL support is optional and does not itself make the application production-ready.
