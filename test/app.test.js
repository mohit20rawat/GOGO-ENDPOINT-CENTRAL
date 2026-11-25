const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../app");

async function withServer(run, pool = null) {
  const server = createApp({ pool }).listen(0, "127.0.0.1");
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
test("demo alert API returns an empty list and validates status filters", async () => withServer(async base => {
  const response = await fetch(base + "/api/alerts");
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{items:[],total:0,mode:"demo"});
  assert.equal((await fetch(base + "/api/alerts?status=unknown")).status,400);
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
test("database readiness requires the baseline schema and all required tables", async () => {
  const pool = { query: async () => ({ rows: [{ schema_applied: true, required_tables_present: true }] }) };
  await withServer(async base => {
    const response = await fetch(base + "/api/ready");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ready: true, mode: "database", persistence: "postgresql",
      authRequired: true, schemaVersion: "002_offline_alerts"
    });
  }, pool);
});

test("database readiness returns 503 when schema is incomplete", async () => {
  const pool = { query: async () => ({ rows: [{ schema_applied: true, required_tables_present: false }] }) };
  await withServer(async base => {
    const response = await fetch(base + "/api/ready");
    assert.equal(response.status, 503);
    assert.equal((await response.json()).ready, false);
  }, pool);
});

test("database readiness returns 503 when the database query fails", async () => {
  const pool = { query: async () => { throw new Error("database unavailable"); } };
  await withServer(async base => {
    const response = await fetch(base + "/api/ready");
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ready: false, mode: "database", persistence: "postgresql", authRequired: true
    });
  }, pool);
});

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

test("administrative mutation endpoints enforce a per-IP rate limit", async () => withServer(async base => {
  let last;
  for (let i = 0; i < 21; i++) {
    last = await fetch(base + "/api/admin/enrollment-tokens", { method: "POST" });
    if (i < 20) assert.equal(last.status, 503);
  }
  assert.equal(last.status, 429);
  assert.deepEqual(await last.json(), { error: "Too many administrative changes. Try again later." });
  assert.ok(last.headers.get("ratelimit") || last.headers.get("ratelimit-policy"));
}));


test("database-backed protected endpoints reject missing and invalid sessions", async () => {
  let sessionLookups = 0;
  const pool = {
    query: async sql => {
      if (sql.includes("FROM auth_sessions s JOIN users u")) {
        sessionLookups++;
        return { rowCount: 0, rows: [] };
      }
      throw new Error("Unexpected query in auth guard test");
    }
  };
  await withServer(async base => {
    const protectedRequests = [
      fetch(base + "/api/auth/me"),
      fetch(base + "/api/devices"),
      fetch(base + "/api/audit"),
      fetch(base + "/api/alerts"),
      fetch(base + "/api/admin/users", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      fetch(base + "/api/admin/enrollment-tokens", { method: "POST" }),
      fetch(base + "/api/admin/devices/dev_example/revoke-agent", { method: "POST" })
    ];
    const responses = await Promise.all(protectedRequests);
    assert.deepEqual(responses.map(response => response.status), [401, 401, 401, 401, 401, 401, 401]);
    const bodies = await Promise.all(responses.map(response => response.json()));
    assert.ok(bodies.every(body => body.error === "Authentication required"));
    assert.equal(sessionLookups, 0, "requests without a bearer token must not query the session store");

    const invalidTokenResponse = await fetch(base + "/api/auth/me", {
      headers: { authorization: "Bearer invalid-session-token" }
    });
    assert.equal(invalidTokenResponse.status, 401);
    assert.deepEqual(await invalidTokenResponse.json(), { error: "Session expired or invalid" });
    assert.equal(sessionLookups, 1, "an invalid bearer token must be checked against the session store");
  }, pool);
});

test("viewer sessions cannot perform administrative mutations", async () => {
  const pool = {
    query: async sql => {
      assert.ok(sql.includes("FROM auth_sessions s JOIN users u"));
      return {
        rowCount: 1,
        rows: [{ id: "viewer-1", tenant_id: "tenant-a", email: "viewer@example.test", role: "viewer" }]
      };
    }
  };
  await withServer(async base => {
    const headers = { authorization: "Bearer valid-viewer-session", "content-type": "application/json" };
    const createUser = await fetch(base + "/api/admin/users", {
      method: "POST", headers,
      body: JSON.stringify({ email: "blocked@example.test", password: "long-enough-password-123", role: "viewer" })
    });
    const createEnrollmentToken = await fetch(base + "/api/admin/enrollment-tokens", {
      method: "POST", headers, body: "{}"
    });
    const revokeAgent = await fetch(base + "/api/admin/devices/dev_example/revoke-agent", {
      method: "POST", headers
    });
    for (const response of [createUser, createEnrollmentToken, revokeAgent]) {
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "Insufficient permissions" });
    }
  }, pool);
});

test("device, audit, and alert queries are scoped to the authenticated tenant", async () => {
  const scopedQueries = [];
  const pool = {
    query: async (sql, values = []) => {
      if (sql.includes("FROM auth_sessions s JOIN users u")) {
        return {
          rowCount: 1,
          rows: [{ id: "user-a", tenant_id: "tenant-a", email: "admin-a@example.test", role: "admin" }]
        };
      }
      scopedQueries.push({ sql, values });
      return { rowCount: 0, rows: [] };
    }
  };
  await withServer(async base => {
    const headers = { authorization: "Bearer valid-tenant-a-session" };
    for (const route of ["/api/devices", "/api/audit", "/api/alerts"]) {
      const response = await fetch(base + route, { headers });
      assert.equal(response.status, 200, route);
      assert.deepEqual(await response.json(), { items: [], total: 0, mode: "database" });
    }
  }, pool);

  assert.equal(scopedQueries.length, 3);
  const deviceQuery = scopedQueries.find(query => query.sql.includes("FROM devices WHERE"));
  const auditQuery = scopedQueries.find(query => query.sql.includes("FROM audit_events"));
  const alertQuery = scopedQueries.find(query => query.sql.includes("FROM device_alerts a JOIN devices"));
  assert.ok(deviceQuery, "device list query was issued");
  assert.ok(auditQuery, "audit query was issued");
  assert.ok(alertQuery, "alert query was issued");
  assert.match(deviceQuery.sql, /WHERE tenant_id\s*=\s*\$1/);
  assert.match(auditQuery.sql, /WHERE tenant_id\s*=\s*\$1/);
  assert.match(alertQuery.sql, /WHERE a\.tenant_id\s*=\s*\$1/);
  for (const query of scopedQueries) assert.equal(query.values[0], "tenant-a");
});


test("agent credential revocation is covered by the administrative mutation rate limit", async () => {
  const pool = {
    query: async sql => {
      assert.ok(sql.includes("FROM auth_sessions s JOIN users u"));
      return {
        rowCount: 1,
        rows: [{ id: "admin-1", tenant_id: "tenant-a", email: "admin@example.test", role: "admin" }]
      };
    },
    connect: async () => ({
      query: async sql => {
        if (sql.includes("SELECT id,name FROM devices")) return { rowCount: 0, rows: [] };
        return { rowCount: 0, rows: [] };
      },
      release: () => {}
    })
  };
  await withServer(async base => {
    let last;
    for (let i = 0; i < 21; i++) {
      last = await fetch(base + "/api/admin/devices/dev_missing/revoke-agent", {
        method: "POST",
        headers: { authorization: "Bearer valid-admin-session" }
      });
      if (i < 20) assert.equal(last.status, 404);
    }
    assert.equal(last.status, 429);
    assert.deepEqual(await last.json(), { error: "Too many administrative changes. Try again later." });
    assert.ok(last.headers.get("ratelimit") || last.headers.get("ratelimit-policy"));
  }, pool);
});


test("admin credential revocation cannot touch a device from another tenant", async () => {
  const transactionalQueries = [];
  const pool = {
    query: async sql => {
      assert.ok(sql.includes("FROM auth_sessions s JOIN users u"));
      return {
        rowCount: 1,
        rows: [{ id: "admin-a", tenant_id: "tenant-a", email: "admin-a@example.test", role: "admin" }]
      };
    },
    connect: async () => ({
      query: async (sql, values = []) => {
        transactionalQueries.push({ sql, values });
        if (sql.includes("SELECT id,name FROM devices")) return { rowCount: 0, rows: [] };
        return { rowCount: 0, rows: [] };
      },
      release: () => {}
    })
  };
  await withServer(async base => {
    const response = await fetch(base + "/api/admin/devices/dev-tenant-b/revoke-agent", {
      method: "POST",
      headers: { authorization: "Bearer valid-admin-a-session" }
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Device not found in your workspace." });
  }, pool);

  const lookup = transactionalQueries.find(query => query.sql.includes("SELECT id,name FROM devices"));
  assert.ok(lookup);
  assert.match(lookup.sql, /WHERE id=\$1 AND tenant_id=\$2/);
  assert.deepEqual(lookup.values, ["dev-tenant-b", "tenant-a"]);
  assert.ok(transactionalQueries.some(query => query.sql === "ROLLBACK"));
  assert.equal(transactionalQueries.some(query => /DELETE FROM device_agent_tokens|UPDATE devices SET|INSERT INTO audit_events/.test(query.sql)), false);
});

test("logout invalidates the current session and stores only its token hash", async () => {
  const rawToken = "session-token-to-revoke";
  let sessionActive = true;
  let deletedHash = null;
  const pool = {
    query: async (sql, values = []) => {
      if (sql.includes("FROM auth_sessions s JOIN users u")) {
        return sessionActive
          ? { rowCount: 1, rows: [{ id: "user-1", tenant_id: "tenant-a", email: "user@example.test", role: "admin" }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes("DELETE FROM auth_sessions WHERE token_hash=$1")) {
        deletedHash = values[0];
        sessionActive = false;
        return { rowCount: 1, rows: [] };
      }
      throw new Error("Unexpected query in logout lifecycle test");
    }
  };

  await withServer(async base => {
    const logout = await fetch(base + "/api/auth/logout", {
      method: "POST",
      headers: { authorization: "Bearer " + rawToken }
    });
    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.json(), { ok: true });

    const afterLogout = await fetch(base + "/api/auth/me", {
      headers: { authorization: "Bearer " + rawToken }
    });
    assert.equal(afterLogout.status, 401);
    assert.deepEqual(await afterLogout.json(), { error: "Session expired or invalid" });
  }, pool);

  assert.ok(deletedHash);
  assert.notEqual(deletedHash, rawToken, "the database must receive a hash, not the bearer token");
  assert.match(deletedHash, /^[a-f0-9]{64}$/i, "the stored session identifier should be a SHA-256 hex digest");
});

test("sign-in rate limiter rejects the eleventh attempt in one window", async () => {
  const pool = {
    query: async sql => {
      assert.match(sql, /FROM users WHERE email=\$1/);
      return { rowCount: 0, rows: [] };
    }
  };

  await withServer(async base => {
    let last;
    for (let i = 0; i < 11; i++) {
      last = await fetch(base + "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "unknown@example.test", password: "not-the-password" })
      });
      if (i < 10) assert.equal(last.status, 401);
    }
    assert.equal(last.status, 429);
    assert.deepEqual(await last.json(), { error: "Too many sign-in attempts. Try again later." });
    assert.ok(last.headers.get("ratelimit") || last.headers.get("ratelimit-policy"));
  }, pool);
});

