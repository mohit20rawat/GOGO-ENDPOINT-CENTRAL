const test = require("node:test");
const assert = require("node:assert/strict");
const { initializeDatabase, LATEST_SCHEMA_VERSION, migrations } = require("../migrations");

function createMigrationPool({ initialVersions = [], failOn = null } = {}) {
  const applied = new Set(initialVersions);
  const statements = [];
  let snapshot = null;
  const client = {
    async query(sql, params = []) {
      statements.push({ sql, params });
      if (sql === "BEGIN") snapshot = new Set(applied);
      if (sql === "COMMIT") snapshot = null;
      if (sql === "ROLLBACK") {
        applied.clear();
        for (const version of snapshot || []) applied.add(version);
        snapshot = null;
      }
      if (failOn && sql.includes(failOn)) throw new Error("simulated migration failure");
      if (sql === "SELECT version FROM schema_migrations") {
        return { rows: [...applied].map(version => ({ version })), rowCount: applied.size };
      }
      if (sql.startsWith("INSERT INTO schema_migrations")) {
        applied.add(params[0]);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  return {
    applied,
    statements,
    pool: { async connect() { return client; } }
  };
}

test("schema migrations are versioned and ordered", async () => {
  assert.deepEqual(migrations.map(migration => migration.version), [
    "001_initial_schema",
    "002_offline_alerts"
  ]);
  assert.equal(LATEST_SCHEMA_VERSION, "002_offline_alerts");
  const fake = createMigrationPool();
  await initializeDatabase(fake.pool, {});
  assert.deepEqual([...fake.applied], ["001_initial_schema", "002_offline_alerts"]);
  assert.ok(fake.statements.some(entry => entry.sql === "COMMIT"));
  assert.ok(fake.statements.some(entry => entry.sql === "SELECT pg_advisory_lock($1)"));
  assert.ok(fake.statements.some(entry => entry.sql === "SELECT pg_advisory_unlock($1)"));
});

test("already-applied migrations are not executed again on startup", async () => {
  const fake = createMigrationPool();
  await initializeDatabase(fake.pool, {});
  fake.statements.length = 0;
  await initializeDatabase(fake.pool, {});
  assert.equal(fake.statements.some(entry => entry.sql.includes("CREATE TABLE IF NOT EXISTS tenants")), false);
  assert.equal(fake.statements.some(entry => entry.sql.includes("CREATE TABLE IF NOT EXISTS device_alerts")), false);
  assert.deepEqual([...fake.applied], ["001_initial_schema", "002_offline_alerts"]);
});

test("unknown future migration versions fail closed and roll back", async () => {
  const fake = createMigrationPool({ initialVersions: ["999_future_schema"] });
  await assert.rejects(() => initializeDatabase(fake.pool, {}), /unknown migration version/);
  assert.ok(fake.statements.some(entry => entry.sql === "ROLLBACK"));
  assert.ok(fake.statements.some(entry => entry.sql === "SELECT pg_advisory_unlock($1)"));
});

test("failed migration rolls back the migration ledger", async () => {
  const fake = createMigrationPool({ failOn: "device_alerts_one_active_idx" });
  await assert.rejects(() => initializeDatabase(fake.pool, {}), /simulated migration failure/);
  assert.deepEqual([...fake.applied], []);
  assert.ok(fake.statements.some(entry => entry.sql === "ROLLBACK"));
});
