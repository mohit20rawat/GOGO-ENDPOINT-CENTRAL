const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../app");

async function withServer(run) {
  const server = createApp({ pool: null }).listen(0);
  try {
    await run("http://127.0.0.1:" + server.address().port);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("health endpoint reports service is alive", async () => {
  await withServer(async (base) => {
    const response = await fetch(base + "/health");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", service: "gogo-endpoint-central" });
  });
});

test("summary totals match the demo inventory", async () => {
  await withServer(async (base) => {
    const response = await fetch(base + "/api/summary");
    const summary = await response.json();
    assert.equal(summary.totalDevices, 6);
    assert.equal(summary.onlineDevices + summary.offlineDevices, 6);
    assert.equal(summary.highRiskDevices, 1);
    assert.equal(summary.mode, "demo");
  });
});

test("device API supports search and rejects invalid status", async () => {
  await withServer(async (base) => {
    const filtered = await fetch(base + "/api/devices?q=finance");
    assert.equal((await filtered.json()).total, 1);
    const invalid = await fetch(base + "/api/devices?status=unknown");
    assert.equal(invalid.status, 400);
  });
});

test("unknown API routes return JSON 404", async () => {
  await withServer(async (base) => {
    const response = await fetch(base + "/api/missing");
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "API route not found" });
  });
});

test("readiness endpoint explicitly identifies demo persistence", async () => {
  await withServer(async (base) => {
    const response = await fetch(base + "/api/ready");
    assert.deepEqual(await response.json(), { ready: true, mode: "demo", persistence: "in-memory" });
  });
});
