const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../app");

async function withServer(run) {
  const server = createApp({ pool: null }).listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    await run("http://127.0.0.1:" + server.address().port);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("health endpoint reports service is alive", async () => withServer(async base => {
  const response = await fetch(base + "/health");
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{status:"ok",service:"gogo-endpoint-central"});
}));
test("summary totals match the demo inventory", async () => withServer(async base => {
  const response = await fetch(base + "/api/summary");
  const summary = await response.json();
  assert.equal(summary.totalDevices,6);
  assert.equal(summary.onlineDevices + summary.offlineDevices,6);
  assert.equal(summary.highRiskDevices,1);
  assert.equal(summary.mode,"demo");
}));
test("device API supports search and rejects invalid status", async () => withServer(async base => {
  const filtered = await fetch(base + "/api/devices?q=finance");
  assert.equal((await filtered.json()).total,1);
  assert.equal((await fetch(base + "/api/devices?status=unknown")).status,400);
}));
test("unknown API routes return JSON 404", async () => withServer(async base => {
  const response = await fetch(base + "/api/missing");
  assert.equal(response.status,404);
  assert.deepEqual(await response.json(),{error:"API route not found"});
}));
test("readiness endpoint explicitly identifies demo persistence and auth mode", async () => withServer(async base => {
  const response = await fetch(base + "/api/ready");
  assert.deepEqual(await response.json(),{ready:true,mode:"demo",persistence:"in-memory",authRequired:false});
}));
test("demo auth API does not pretend to authenticate without a database", async () => withServer(async base => {
  const response = await fetch(base + "/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"admin@example.com",password:"a-secure-password"})});
  assert.equal(response.status,503);
}));
test("user administration is unavailable in demo mode", async () => withServer(async base => {
  const response = await fetch(base + "/api/admin/users",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"x@example.com",password:"a-secure-password",role:"admin"})});
  assert.equal(response.status,503);
}));

test("enrollment token creation is disabled without PostgreSQL", async () => withServer(async base => {
  const response = await fetch(base + "/api/admin/enrollment-tokens", { method:"POST" });
  assert.equal(response.status,503);
  assert.match((await response.json()).error,/requires PostgreSQL/);
}));
test("agent enrollment is disabled without PostgreSQL", async () => withServer(async base => {
  const response = await fetch(base + "/api/agent/enroll", {
    method:"POST", headers:{"content-type":"application/json"},
    body:JSON.stringify({enrollmentToken:"example-enrollment-token-value",name:"TEST-LAPTOP",os:"Windows",osVersion:"11"})
  });
  assert.equal(response.status,503);
}));
test("agent token rotation is disabled without PostgreSQL", async () => withServer(async base => {
  const response = await fetch(base + "/api/agent/rotate-token", {
    method:"POST", headers:{"authorization":"Bearer example-agent-token"}
  });
  assert.equal(response.status,503);
  assert.match((await response.json()).error,/requires PostgreSQL/);
}));

test("agent heartbeat is disabled without PostgreSQL", async () => withServer(async base => {
  const response = await fetch(base + "/api/agent/heartbeat", {
    method:"POST", headers:{"content-type":"application/json","authorization":"Bearer example-agent-token"},
    body:JSON.stringify({agentVersion:"0.1.0"})
  });
  assert.equal(response.status,503);
}));

test("agent credential revocation is disabled without PostgreSQL", async () => withServer(async base => {
  const response = await fetch(base + "/api/admin/devices/dev_example/revoke-agent", { method:"POST" });
  assert.equal(response.status,503);
  assert.match((await response.json()).error,/requires PostgreSQL/);
}));
