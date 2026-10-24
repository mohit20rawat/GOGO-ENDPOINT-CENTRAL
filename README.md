# GOGO Endpoint Central

A cloud-ready starter for a unified endpoint management (UEM) platform. This first milestone is a **demo MVP**: a dashboard, sample device inventory, summary API, health endpoint, audit-event examples, and automated tests.

> **Important:** This is not yet a production endpoint-management or security product. It does not install agents, execute commands on devices, remotely lock devices, or deploy patches. The inventory and audit events are sample data.

## Current MVP

- Responsive web dashboard with fleet summary and device inventory
- JSON APIs: \`/health\`, \`/api/ready\`, \`/api/summary\`, \`/api/devices\`, \`/api/audit\`
- Basic search and status filtering in the dashboard
- Node.js + Express server
- Automated smoke tests using Node's built-in test runner
- Render deployment configuration

## Run locally

Requirements: Node.js 20 or newer.

\`\`\`bash
npm install
npm start
\`\`\`

Open http://localhost:3000. Run tests with \`npm test\`.

## Deploy to Render

1. Push this repository to GitHub.
2. In Render, create a **Web Service** connected to this repository.
3. Render can use the included \`render.yaml\`; the service runs \`npm start\`.
4. After deployment, verify \`/health\` returns JSON with \`"status":"ok"\`.

The free service tier may sleep when idle and is not suitable for a production enterprise control plane.

## Planned milestones

1. **Foundation:** application shell, API, tests, cloud deployment baseline.
2. **Identity and access:** secure login, MFA-ready design, role-based access, tenant boundaries.
3. **Persistent inventory:** PostgreSQL, device registration, asset assignment and repair/return history.
4. **Endpoint agent:** signed enrollment, heartbeat, inventory collection, secure command channel.
5. **Management modules:** patch/software deployment, policies, alerts, reports and audit trails.
6. **Security and operations:** threat modelling, rate limits, secrets management, backups, monitoring and security tests.
7. **AI assistance:** explainable summaries and recommendations, with human approval for consequential actions.

## Security principles

- Never store passwords, API keys, or deployment secrets in source control.
- Do not connect real devices to this demo.
- High-impact actions such as remote lock, software installation, or policy changes must require authentication, authorization, audit logging, and explicit safeguards.
- A production release requires security review, tenant-isolation tests, persistent storage, backups, and operational monitoring.

## Project status

**Milestone 1 in progress.** This repository is the foundation, not a feature-complete ManageEngine replacement.
