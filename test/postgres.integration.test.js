const test = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");
const { createApp, initializeDatabase, reconcileOfflineAlerts } = require("../app");

function getIntegrationDatabaseUrl(env = process.env) {
  if (env.RUN_POSTGRES_INTEGRATION !== "1") return null;
  const databaseUrl = env.POSTGRES_TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("RUN_POSTGRES_INTEGRATION=1 requires POSTGRES_TEST_DATABASE_URL.");
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch (_error) {
    throw new Error("POSTGRES_TEST_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("POSTGRES_TEST_DATABASE_URL must use postgres:// or postgresql://.");
  }
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("PostgreSQL integration tests only allow localhost or 127.0.0.1; hosted Render/Neon databases are forbidden.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (databaseName !== "gogo_test") {
    throw new Error("PostgreSQL integration tests only allow the dedicated gogo_test database.");
  }
  return databaseUrl;
}

const databaseUrl = getIntegrationDatabaseUrl();
const enabled = Boolean(databaseUrl);

test("PostgreSQL integration database guard rejects hosted and non-test targets", () => {
  const local = "postgres://postgres:postgres@localhost:5432/gogo_test";
  assert.equal(getIntegrationDatabaseUrl({
    RUN_POSTGRES_INTEGRATION: "1",
    POSTGRES_TEST_DATABASE_URL: local
  }), local);
  assert.equal(getIntegrationDatabaseUrl({
    RUN_POSTGRES_INTEGRATION: "1",
    POSTGRES_TEST_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/gogo_test"
  }), "postgres://postgres:postgres@127.0.0.1:5432/gogo_test");
  assert.throws(() => getIntegrationDatabaseUrl({
    RUN_POSTGRES_INTEGRATION: "1",
    POSTGRES_TEST_DATABASE_URL: "postgres://user:secret@ep-gogo.neon.tech/gogo_test?sslmode=require"
  }), /hosted Render\/Neon databases are forbidden/);
  assert.throws(() => getIntegrationDatabaseUrl({
    RUN_POSTGRES_INTEGRATION: "1",
    POSTGRES_TEST_DATABASE_URL: "postgres://user:secret@gogo-db.onrender.com/gogo_test"
  }), /hosted Render\/Neon databases are forbidden/);
  assert.throws(() => getIntegrationDatabaseUrl({
    RUN_POSTGRES_INTEGRATION: "1",
    POSTGRES_TEST_DATABASE_URL: "postgres://postgres:postgres@localhost:5432/postgres"
  }), /dedicated gogo_test database/);
  assert.throws(() => getIntegrationDatabaseUrl({ RUN_POSTGRES_INTEGRATION: "1" }), /requires POSTGRES_TEST_DATABASE_URL/);
  assert.equal(getIntegrationDatabaseUrl({
    RUN_POSTGRES_INTEGRATION: "0",
    POSTGRES_TEST_DATABASE_URL: "postgres://user:secret@ep-gogo.neon.tech/gogo_test"
  }), null);
});

test("PostgreSQL enrollment, heartbeat, token rotation, revocation, and audit flow", { skip: !enabled }, async () => {
  // Use a dedicated, disposable PostgreSQL database. Never point this test at production.
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.POSTGRES_TEST_SSL === "1" ? { rejectUnauthorized: false } : false,
    max: 3,
    connectionTimeoutMillis: 5000
  });
  let server;
  try {
    const bootstrapEnv = {
      BOOTSTRAP_TENANT_NAME: "GOGO Integration Test",
      BOOTSTRAP_ADMIN_EMAIL: "integration-admin@example.test",
      BOOTSTRAP_ADMIN_PASSWORD: "integration-test-password-123"
    };
    // Concurrent startups should serialize schema initialization and remain safe to retry.
    await Promise.all([
      initializeDatabase(pool, bootstrapEnv),
      initializeDatabase(pool, bootstrapEnv)
    ]);
    const migration = await pool.query("SELECT version FROM schema_migrations WHERE version = $1", ["002_offline_alerts"]);
    assert.equal(migration.rowCount, 1);
    server = createApp({ pool }).listen(0);
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const base = "http://127.0.0.1:" + server.address().port;
    const json = { "content-type": "application/json" };

    const readinessResponse = await fetch(base + "/api/ready");
    assert.equal(readinessResponse.status, 200);
    const readiness = await readinessResponse.json();
    assert.equal(readiness.ready, true);
    assert.equal(readiness.schemaVersion, "002_offline_alerts");

    const loginResponse = await fetch(base + "/api/auth/login", {
      method: "POST", headers: json,
      body: JSON.stringify({ email: "integration-admin@example.test", password: "integration-test-password-123" })
    });
    assert.equal(loginResponse.status, 200);

    // Failed login responses must not reveal whether an email exists.
    const invalidLoginResponses = await Promise.all([
      fetch(base + "/api/auth/login", {
        method: "POST", headers: json,
        body: JSON.stringify({ email: "missing-user@example.test", password: "wrong-password-123" })
      }),
      fetch(base + "/api/auth/login", {
        method: "POST", headers: json,
        body: JSON.stringify({ email: "integration-admin@example.test", password: "wrong-password-123" })
      })
    ]);
    assert.deepEqual(invalidLoginResponses.map(response => response.status), [401, 401]);
    const invalidLoginBodies = await Promise.all(invalidLoginResponses.map(response => response.json()));
    assert.deepEqual(invalidLoginBodies[0], invalidLoginBodies[1]);

    const login = await loginResponse.json();
    assert.ok(login.token);
    const adminHeaders = { ...json, authorization: "Bearer " + login.token };

    // Role checks: a viewer can read workspace data but cannot administer users or enroll devices.
    const viewerEmail = "integration-viewer-" + crypto.randomUUID() + "@example.test";
    const viewerCreateResponse = await fetch(base + "/api/admin/users", {
      method: "POST", headers: adminHeaders,
      body: JSON.stringify({ email: viewerEmail, password: "integration-viewer-password-123", role: "viewer" })
    });
    assert.equal(viewerCreateResponse.status, 201);
    const viewerLoginResponse = await fetch(base + "/api/auth/login", {
      method: "POST", headers: json,
      body: JSON.stringify({ email: viewerEmail, password: "integration-viewer-password-123" })
    });
    assert.equal(viewerLoginResponse.status, 200);
    const viewerLogin = await viewerLoginResponse.json();
    const viewerHeaders = { ...json, authorization: "Bearer " + viewerLogin.token };
    assert.equal((await fetch(base + "/api/admin/enrollment-tokens", {
      method: "POST", headers: viewerHeaders, body: "{}"
    })).status, 403);
    assert.equal((await fetch(base + "/api/admin/users", {
      method: "POST", headers: viewerHeaders,
      body: JSON.stringify({ email: "blocked-" + crypto.randomUUID() + "@example.test", password: "blocked-password-123", role: "viewer" })
    })).status, 403);
    assert.equal((await fetch(base + "/api/devices", { headers: viewerHeaders })).status, 200);

    // Tenant boundary: a second tenant's device must never appear in the primary tenant's inventory.
    const isolatedTenantId = "tenant_" + crypto.randomUUID();
    const isolatedUserId = "usr_" + crypto.randomUUID();
    const isolatedDeviceId = "dev_" + crypto.randomUUID();
    const isolatedEmail = "integration-other-" + crypto.randomUUID() + "@example.test";
    const isolatedPasswordHash = await bcrypt.hash("integration-other-password-123", 4);
    await pool.query("INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)", [
      isolatedTenantId, "Isolation Test Tenant", "isolation-" + crypto.randomUUID()
    ]);
    await pool.query("INSERT INTO users (id,tenant_id,email,password_hash,role) VALUES ($1,$2,$3,$4,'admin')", [
      isolatedUserId, isolatedTenantId, isolatedEmail, isolatedPasswordHash
    ]);
    await pool.query(
      "INSERT INTO devices (id,name,assigned_user,department,os,os_version,status,risk,last_seen,tenant_id) VALUES ($1,$2,$3,$4,$5,$6,'offline','low','Never',$7)",
      [isolatedDeviceId, "ISOLATION-ONLY-DEVICE", "Other Tenant User", "Testing", "Linux", "Test", isolatedTenantId]
    );
    const isolatedLoginResponse = await fetch(base + "/api/auth/login", {
      method: "POST", headers: json,
      body: JSON.stringify({ email: isolatedEmail, password: "integration-other-password-123" })
    });
    assert.equal(isolatedLoginResponse.status, 200);
    const isolatedLogin = await isolatedLoginResponse.json();
    const isolatedHeaders = { ...json, authorization: "Bearer " + isolatedLogin.token };
    const otherTenantInventory = await (await fetch(base + "/api/devices?q=ISOLATION-ONLY-DEVICE", {
      headers: isolatedHeaders
    })).json();
    assert.equal(otherTenantInventory.total, 1);
    const primaryTenantInventory = await (await fetch(base + "/api/devices?q=ISOLATION-ONLY-DEVICE", {
      headers: adminHeaders
    })).json();
    assert.equal(primaryTenantInventory.total, 0);

    const enrollmentResponse = await fetch(base + "/api/admin/enrollment-tokens", {
      method: "POST", headers: adminHeaders, body: "{}"
    });
    assert.equal(enrollmentResponse.status, 201);
    const enrollment = await enrollmentResponse.json();
    assert.ok(enrollment.token);

    const deviceResponse = await fetch(base + "/api/agent/enroll", {
      method: "POST", headers: json,
      body: JSON.stringify({
        enrollmentToken: enrollment.token,
        name: "INTEGRATION-WIN-01",
        os: "Windows",
        osVersion: "11"
      })
    });
    assert.equal(deviceResponse.status, 201);
    const device = await deviceResponse.json();
    assert.ok(device.deviceId);
    assert.ok(device.agentToken);

    const reusedEnrollmentResponse = await fetch(base + "/api/agent/enroll", {
      method: "POST", headers: json,
      body: JSON.stringify({
        enrollmentToken: enrollment.token,
        name: "INTEGRATION-WIN-02",
        os: "Windows",
        osVersion: "11"
      })
    });
    assert.equal(reusedEnrollmentResponse.status, 401);

    const heartbeat = (token, payload = { agentVersion: "integration-test" }) => fetch(base + "/api/agent/heartbeat", {
      method: "POST",
      headers: { ...json, authorization: "Bearer " + token },
      body: JSON.stringify(payload)
    });
    const hardwareInventory = {
      manufacturer: "Test Manufacturer", model: "Test Model", cpuModel: "Test CPU",
      cpuCores: 8, logicalProcessors: 16, memoryTotalBytes: 17179869184,
      systemDrive: "C:", systemDriveTotalBytes: 512000000000, systemDriveFreeBytes: 128000000000,
      collectedAt: new Date().toISOString()
    };
    const heartbeatResponse = await heartbeat(device.agentToken, { agentVersion: "integration-test", hardwareInventory });
    assert.equal(heartbeatResponse.status, 200);
    const heartbeatBody = await heartbeatResponse.json();
    assert.equal(heartbeatBody.agentVersion, "integration-test");
    assert.equal(heartbeatBody.hardwareInventoryReceived, true);
    const storedAgentVersion = await pool.query("SELECT agent_version,hardware_inventory FROM devices WHERE id=$1", [device.deviceId]);
    assert.equal(storedAgentVersion.rows[0].agent_version, "integration-test");
    assert.equal(storedAgentVersion.rows[0].hardware_inventory.cpuModel, "Test CPU");
    assert.equal((await heartbeat(device.agentToken, { agentVersion: "integration-test", hardwareInventory: { cpuCores: -2 } })).status, 400);
    const inventoryAfterHeartbeat = await fetch(base + "/api/devices", {
      headers: { Authorization: "Bearer " + login.token }
    });
    assert.equal(inventoryAfterHeartbeat.status, 200);
    const inventoryBody = await inventoryAfterHeartbeat.json();
    const inventoryDevice = inventoryBody.items.find(item => item.id === device.deviceId);
    assert.equal(inventoryDevice.agentVersion, "integration-test");
    assert.equal(inventoryDevice.hardwareInventory.cpuModel, "Test CPU");
    assert.ok(inventoryDevice.lastSeen);
    assert.equal(inventoryDevice.status, "online");

    const summaryBeforeOfflineResponse = await fetch(base + "/api/summary", {
      headers: adminHeaders
    });
    assert.equal(summaryBeforeOfflineResponse.status, 200);
    const summaryBeforeOffline = await summaryBeforeOfflineResponse.json();

    const agedDevice = await pool.query(
      "UPDATE devices SET updated_at = NOW() - INTERVAL '6 minutes' WHERE id = $1 RETURNING id",
      [device.deviceId]
    );
    assert.equal(agedDevice.rowCount, 1);

    const offlineInventoryResponse = await fetch(base + "/api/devices?q=INTEGRATION-WIN-01", {
      headers: adminHeaders
    });
    assert.equal(offlineInventoryResponse.status, 200);
    const offlineInventory = await offlineInventoryResponse.json();
    const offlineDevice = offlineInventory.items.find(item => item.id === device.deviceId);
    assert.equal(offlineDevice.status, "offline");

    const offlineSummaryResponse = await fetch(base + "/api/summary", {
      headers: adminHeaders
    });
    assert.equal(offlineSummaryResponse.status, 200);
    const offlineSummary = await offlineSummaryResponse.json();
    assert.equal(offlineSummary.offlineDevices, summaryBeforeOffline.offlineDevices + 1);
    assert.equal(offlineSummary.onlineDevices, summaryBeforeOffline.onlineDevices - 1);

    const recoveryHeartbeatResponse = await heartbeat(device.agentToken);
    assert.equal(recoveryHeartbeatResponse.status, 200);

    const recoveredInventoryResponse = await fetch(base + "/api/devices?q=INTEGRATION-WIN-01", {
      headers: adminHeaders
    });
    assert.equal(recoveredInventoryResponse.status, 200);
    const recoveredInventory = await recoveredInventoryResponse.json();
    const recoveredDevice = recoveredInventory.items.find(item => item.id === device.deviceId);
    assert.equal(recoveredDevice.status, "online");

    const recoveredSummaryResponse = await fetch(base + "/api/summary", {
      headers: adminHeaders
    });
    assert.equal(recoveredSummaryResponse.status, 200);
    const recoveredSummary = await recoveredSummaryResponse.json();
    assert.equal(recoveredSummary.offlineDevices, summaryBeforeOffline.offlineDevices);
    assert.equal(recoveredSummary.onlineDevices, summaryBeforeOffline.onlineDevices);

    // Stale heartbeats create one persistent alert per tenant and device, even after repeated scans.
    await pool.query(
      "UPDATE devices SET status='online',updated_at=NOW()-INTERVAL '6 minutes' WHERE id IN ($1,$2)",
      [device.deviceId,isolatedDeviceId]
    );
    const firstScan = await reconcileOfflineAlerts(pool);
    assert.ok(firstScan.some(alert => alert.device_id === device.deviceId));
    assert.ok(firstScan.some(alert => alert.device_id === isolatedDeviceId));
    const secondScan = await reconcileOfflineAlerts(pool);
    assert.equal(secondScan.some(alert => alert.device_id === device.deviceId || alert.device_id === isolatedDeviceId),false);

    const primaryAlerts = await (await fetch(base + "/api/alerts?status=active", { headers:adminHeaders })).json();
    const isolatedAlerts = await (await fetch(base + "/api/alerts?status=active", { headers:isolatedHeaders })).json();
    assert.deepEqual(primaryAlerts.items.map(alert => alert.deviceId).filter(id => id === isolatedDeviceId),[]);
    assert.deepEqual(isolatedAlerts.items.map(alert => alert.deviceId).filter(id => id === device.deviceId),[]);
    assert.ok(primaryAlerts.items.some(alert => alert.deviceId === device.deviceId && alert.status === "active"));
    assert.ok(isolatedAlerts.items.some(alert => alert.deviceId === isolatedDeviceId && alert.status === "active"));

    assert.equal((await heartbeat(device.agentToken)).status,200);
    const recoveredAlerts = await (await fetch(base + "/api/alerts?status=resolved", { headers:adminHeaders })).json();
    assert.ok(recoveredAlerts.items.some(alert => alert.deviceId === device.deviceId && alert.status === "resolved" && alert.resolvedAt));
    const isolatedStillActive = await (await fetch(base + "/api/alerts?status=active", { headers:isolatedHeaders })).json();
    assert.ok(isolatedStillActive.items.some(alert => alert.deviceId === isolatedDeviceId));

    const rotateResponse = await fetch(base + "/api/agent/rotate-token", {
      method: "POST", headers: { authorization: "Bearer " + device.agentToken }
    });
    assert.equal(rotateResponse.status, 200);
    const rotated = await rotateResponse.json();
    assert.equal(rotated.deviceId, device.deviceId);
    assert.ok(rotated.agentToken);
    assert.notEqual(rotated.agentToken, device.agentToken);
    assert.equal((await heartbeat(device.agentToken)).status, 401);
    assert.equal((await heartbeat(rotated.agentToken)).status, 200);

    const inventoryResponse = await fetch(base + "/api/devices?q=INTEGRATION-WIN-01", {
      headers: { authorization: "Bearer " + login.token }
    });
    assert.equal(inventoryResponse.status, 200);
    const inventory = await inventoryResponse.json();
    assert.equal(inventory.total, 1);
    assert.equal(inventory.items[0].status, "online");

    const revokeResponse = await fetch(base + "/api/admin/devices/" + encodeURIComponent(device.deviceId) + "/revoke-agent", {
      method: "POST", headers: adminHeaders
    });
    assert.equal(revokeResponse.status, 200);
    assert.equal((await heartbeat(rotated.agentToken)).status, 401);

    const auditResponse = await fetch(base + "/api/audit", {
      headers: { authorization: "Bearer " + login.token }
    });
    assert.equal(auditResponse.status, 200);
    const audit = await auditResponse.json();
    assert.ok(audit.items.some(item => item.action.includes("Agent token rotated")));
    assert.ok(audit.items.some(item => item.action.includes("Agent credentials revoked")));

    const logoutResponse = await fetch(base + "/api/auth/logout", {
      method: "POST", headers: adminHeaders
    });
    assert.equal(logoutResponse.status, 200);
    const expiredSessionResponse = await fetch(base + "/api/auth/me", {
      headers: { authorization: "Bearer " + login.token }
    });
    assert.equal(expiredSessionResponse.status, 401);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end();
  }
});
