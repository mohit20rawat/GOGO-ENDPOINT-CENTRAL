const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");

const MIGRATION_LOCK_ID = 741902611;

const migrations = [
  {
    version: "001_initial_schema",
    up: (env) => [
      { sql: `CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
      { sql: `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        email TEXT NOT NULL, password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (tenant_id, email)
      )` },
      { sql: `CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
      { sql: `CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, assigned_user TEXT NOT NULL,
        department TEXT NOT NULL, os TEXT NOT NULL, os_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('online','offline')),
        risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')), last_seen TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
      { sql: "ALTER TABLE devices ADD COLUMN IF NOT EXISTS tenant_id TEXT" },
      { sql: "ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_version TEXT" },
      { sql: "ALTER TABLE devices ADD COLUMN IF NOT EXISTS hardware_inventory JSONB" },
      { sql: `CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY, action TEXT NOT NULL, actor TEXT NOT NULL,
        event_time TEXT NOT NULL, result TEXT NOT NULL CHECK (result IN ('success','failure'))
      )` },
      { sql: "ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS tenant_id TEXT" },
      { sql: "CREATE UNIQUE INDEX IF NOT EXISTS users_email_global_unique ON users (LOWER(email))" },
      { sql: "CREATE INDEX IF NOT EXISTS devices_tenant_name_idx ON devices (tenant_id, name)" },
      { sql: "CREATE INDEX IF NOT EXISTS devices_tenant_status_updated_idx ON devices (tenant_id, status, updated_at)" },
      { sql: "CREATE INDEX IF NOT EXISTS audit_events_tenant_time_idx ON audit_events (tenant_id, event_time)" },
      { sql: `CREATE TABLE IF NOT EXISTS enrollment_tokens (
        token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL, uses_remaining INTEGER NOT NULL DEFAULT 1 CHECK (uses_remaining >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )` },
      { sql: `CREATE TABLE IF NOT EXISTS device_agent_tokens (
        token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_used_at TIMESTAMPTZ
      )` },
      {
        sql: "INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING",
        params: ["primary-tenant", (env.BOOTSTRAP_TENANT_NAME || "GOGO Workspace").trim().slice(0, 100), "primary"]
      },
      { sql: "UPDATE devices SET tenant_id = $1 WHERE tenant_id IS NULL", params: ["primary-tenant"] },
      { sql: "UPDATE audit_events SET tenant_id = $1 WHERE tenant_id IS NULL", params: ["primary-tenant"] },
      { sql: "CREATE UNIQUE INDEX IF NOT EXISTS devices_id_tenant_unique_idx ON devices (id, tenant_id)" }
    ]
  },
  {
    version: "002_offline_alerts",
    up: () => [
      { sql: `CREATE TABLE IF NOT EXISTS device_alerts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        alert_type TEXT NOT NULL CHECK (alert_type IN ('endpoint_offline')),
        opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        FOREIGN KEY (device_id, tenant_id) REFERENCES devices(id, tenant_id) ON DELETE CASCADE,
        CHECK (resolved_at IS NULL OR resolved_at >= opened_at)
      )` },
      { sql: "CREATE UNIQUE INDEX IF NOT EXISTS device_alerts_one_active_idx ON device_alerts (tenant_id, device_id, alert_type) WHERE resolved_at IS NULL" },
      { sql: "CREATE INDEX IF NOT EXISTS device_alerts_tenant_opened_idx ON device_alerts (tenant_id, opened_at DESC)" }
    ]
  }
];

const LATEST_SCHEMA_VERSION = migrations[migrations.length - 1].version;
const validEmail = (value) => typeof value === "string" && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value) && value.length <= 254;

async function initializeDatabase(pool, env = process.env) {
  if (!pool) return;
  const client = await pool.connect();
  let lockAcquired = false;
  let transactionStarted = false;
  try {
    // Serialize migration execution across instances sharing this database.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    lockAcquired = true;
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");

    const appliedResult = await client.query("SELECT version FROM schema_migrations");
    const applied = new Set(appliedResult.rows.map(row => row.version));
    const knownVersions = new Set(migrations.map(migration => migration.version));
    const unknownVersions = [...applied].filter(version => !knownVersions.has(version));
    if (unknownVersions.length) {
      throw new Error("Database schema contains unknown migration version(s): " + unknownVersions.join(", ") + ". Use a compatible application version before starting.");
    }

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      for (const statement of migration.up(env)) {
        await client.query(statement.sql, statement.params || []);
      }
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
    }

    if (env.BOOTSTRAP_ADMIN_EMAIL && env.BOOTSTRAP_ADMIN_PASSWORD) {
      const email = env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase();
      if (!validEmail(email) || env.BOOTSTRAP_ADMIN_PASSWORD.length < 12) {
        throw new Error("BOOTSTRAP_ADMIN_EMAIL must be valid and BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters");
      }
      const existing = await client.query("SELECT id FROM users WHERE tenant_id = $1 AND email = $2", ["primary-tenant", email]);
      if (existing.rowCount === 0) {
        const passwordHash = await bcrypt.hash(env.BOOTSTRAP_ADMIN_PASSWORD, 12);
        await client.query(
          "INSERT INTO users (id,tenant_id,email,password_hash,role) VALUES ($1,$2,$3,$4,'admin')",
          ["usr_" + crypto.randomUUID(), "primary-tenant", email, passwordHash]
        );
      }
    }

    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try { await client.query("ROLLBACK"); } catch (_rollbackError) {}
    }
    throw error;
  } finally {
    if (lockAcquired) {
      try { await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]); } catch (_unlockError) {}
    }
    client.release();
  }
}

module.exports = { initializeDatabase, LATEST_SCHEMA_VERSION, migrations };
