const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../app");

test("health endpoint reports service is alive", async () => {
  const server = createApp().listen(0);
  try {
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/health");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", service: "gogo-endpoint-central" });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("summary totals match the demo inventory", async () => {
  const server = createApp().listen(0);
  try {
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/summary");
    const summary = await response.json();
    assert.equal(summary.totalDevices, 6);
    assert.equal(summary.onlineDevices + summary.offlineDevices, 6);
    assert.equal(summary.highRiskDevices, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("device API supports search and rejects invalid status", async () => {
  const server = createApp().listen(0);
  try {
    const base = "http://127.0.0.1:" + server.address().port;
    const filtered = await fetch(base + "/api/devices?q=finance");
    assert.equal((await filtered.json()).total, 1);
    const invalid = await fetch(base + "/api/devices?status=unknown");
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("unknown API routes return JSON 404", async () => {
  const server = createApp().listen(0);
  try {
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/missing");
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "API route not found" });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
