const test = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");
const { createApp, initializeDatabase } = require("../app");

const databaseUrl = process.env.POSTGRES_TEST_DATABASE_URL;
const enabled = process.env.RUN_POSTGRES_INTEGRATION === "1" && Boolean(databaseUrl);

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
    await initializeDatabase(pool, {
      BOOTSTRAP_TENANT_NAME: "GOGO Integration Test",
      BOOTSTRAP_ADMIN_EMAIL: "integration-admin@example.test",
      BOOTSTRAP_ADMIN_PASSWORD: "integration-test-password-123"
    });
    server = createApp({ pool }).listen(0);
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const base = "http://127.0.0.1:" + server.address().port;
    const json = { "content-type": "application/json" };

    const loginResponse = await fetch(base + "/api/auth/login", {
      method: "POST", headers: json,
      body: JSON.stringify({ email: "integration-admin@example.test", password: "integration-test-password-123" })
    });
    assert.equal(loginResponse.status, 200);
    const login = await loginResponse.json();
    assert.ok(login.token);
    const adminHeaders = { ...json, authorization: "Bearer " + login.token };

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

    const heartbeat = (token) => fetch(base + "/api/agent/heartbeat", {
      method: "POST",
      headers: { ...json, authorization: "Bearer " + token },
      body: JSON.stringify({ agentVersion: "integration-test" })
    });
    assert.equal((await heartbeat(device.agentToken)).status, 200);

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
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end();
  }
});
