const express = require("express");
const path = require("node:path");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");

const demoDevices = [
  { id: "DEV-1001", name: "FIN-LAP-014", user: "Aarav Sharma", department: "Finance", os: "Windows 11", version: "23H2", status: "online", risk: "low", lastSeen: "Just now" },
  { id: "DEV-1002", name: "HR-LAP-006", user: "Diya Kapoor", department: "Human Resources", os: "Windows 11", version: "23H2", status: "online", risk: "medium", lastSeen: "2 min ago" },
  { id: "DEV-1003", name: "ENG-MAC-022", user: "Kabir Mehta", department: "Engineering", os: "macOS", version: "15.1", status: "offline", risk: "low", lastSeen: "3 hours ago" },
  { id: "DEV-1004", name: "OPS-LAP-031", user: "Anaya Singh", department: "Operations", os: "Windows 10", version: "22H2", status: "online", risk: "high", lastSeen: "1 min ago" },
  { id: "DEV-1005", name: "SALES-LAP-019", user: "Ishaan Verma", department: "Sales", os: "Windows 11", version: "24H2", status: "online", risk: "low", lastSeen: "Just now" },
  { id: "DEV-1006", name: "DESIGN-MAC-008", user: "Sana Khan", department: "Design", os: "macOS", version: "14.7", status: "offline", risk: "medium", lastSeen: "Yesterday" }
];
const demoAuditEvents = [
  { id: "AUD-0003", action: "Inventory dashboard viewed", actor: "Demo Admin", time: "Just now", result: "success" },
  { id: "AUD-0002", action: "Device risk review generated", actor: "Demo Admin", time: "12 min ago", result: "success" },
  { id: "AUD-0001", action: "Demo workspace initialized", actor: "System", time: "Today", result: "success" }
];

let defaultPool;
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  defaultPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: true },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });
}
const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const validEmail = (value) => typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;

async function initializeDatabaseSchema(pool, env = process.env) {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email TEXT NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (tenant_id, email)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, assigned_user TEXT NOT NULL,
    department TEXT NOT NULL, os TEXT NOT NULL, os_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('online','offline')),
    risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')), last_seen TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("ALTER TABLE devices ADD COLUMN IF NOT EXISTS tenant_id TEXT");
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, actor TEXT NOT NULL,
    event_time TEXT NOT NULL, result TEXT NOT NULL CHECK (result IN ('success','failure'))
  )`);
  await pool.query("ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS tenant_id TEXT");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS users_email_global_unique ON users (LOWER(email))");
  await pool.query("CREATE INDEX IF NOT EXISTS devices_tenant_name_idx ON devices (tenant_id, name)");
  await pool.query("CREATE INDEX IF NOT EXISTS devices_tenant_status_updated_idx ON devices (tenant_id, status, updated_at)");
  await pool.query("CREATE INDEX IF NOT EXISTS audit_events_tenant_time_idx ON audit_events (tenant_id, event_time)");
  await pool.query(`CREATE TABLE IF NOT EXISTS enrollment_tokens (
    token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL, uses_remaining INTEGER NOT NULL DEFAULT 1 CHECK (uses_remaining >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS device_agent_tokens (
    token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_used_at TIMESTAMPTZ
  )`);


  const tenantName = (env.BOOTSTRAP_TENANT_NAME || "GOGO Workspace").trim().slice(0, 100);
  const tenantId = "primary-tenant";
  await pool.query("INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING", [tenantId, tenantName, "primary"]);
  await pool.query("UPDATE devices SET tenant_id = $1 WHERE tenant_id IS NULL", [tenantId]);
  await pool.query("UPDATE audit_events SET tenant_id = $1 WHERE tenant_id IS NULL", [tenantId]);

  const deviceCount = await pool.query("SELECT COUNT(*)::int AS count FROM devices WHERE tenant_id = $1", [tenantId]);
  if (deviceCount.rows[0].count === 0) {
    for (const d of demoDevices) await pool.query(
      "INSERT INTO devices (id,name,assigned_user,department,os,os_version,status,risk,last_seen,tenant_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING",
      [d.id,d.name,d.user,d.department,d.os,d.version,d.status,d.risk,d.lastSeen,tenantId]
    );
  }
  const auditCount = await pool.query("SELECT COUNT(*)::int AS count FROM audit_events WHERE tenant_id = $1", [tenantId]);
  if (auditCount.rows[0].count === 0) {
    for (const e of demoAuditEvents) await pool.query(
      "INSERT INTO audit_events (id,action,actor,event_time,result,tenant_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING",
      [e.id,e.action,e.actor,e.time,e.result,tenantId]
    );
  }

  if (env.BOOTSTRAP_ADMIN_EMAIL && env.BOOTSTRAP_ADMIN_PASSWORD) {
    const email = env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase();
    if (!validEmail(email) || env.BOOTSTRAP_ADMIN_PASSWORD.length < 12) {
      throw new Error("BOOTSTRAP_ADMIN_EMAIL must be valid and BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters");
    }
    const existing = await pool.query("SELECT id FROM users WHERE tenant_id = $1 AND email = $2", [tenantId,email]);
    if (existing.rowCount === 0) {
      const passwordHash = await bcrypt.hash(env.BOOTSTRAP_ADMIN_PASSWORD, 12);
      await pool.query("INSERT INTO users (id,tenant_id,email,password_hash,role) VALUES ($1,$2,$3,$4,'admin')",
        ["usr_" + crypto.randomUUID(),tenantId,email,passwordHash]);
      console.log("Bootstrap administrator created for configured tenant.");
    }
  }
}


async function initializeDatabase(pool = defaultPool, env = process.env) {
  if (!pool) return;
  const client = await pool.connect();
  let lockAcquired = false;
  let transactionStarted = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [741902611]);
    lockAcquired = true;
    await client.query("BEGIN");
    transactionStarted = true;
    await initializeDatabaseSchema(client, env);
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    await client.query("INSERT INTO schema_migrations (version) VALUES ('001_initial_schema') ON CONFLICT (version) DO NOTHING");
    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try { await client.query("ROLLBACK"); } catch (_rollbackError) {}
    }
    throw error;
  } finally {
    if (lockAcquired) {
      try { await client.query("SELECT pg_advisory_unlock($1)", [741902611]); } catch (_unlockError) {}
    }
    client.release();
  }
}

function mapDevice(row) {
  return { id: row.id, name: row.name, user: row.assigned_user, department: row.department, os: row.os, version: row.os_version, status: row.status, risk: row.risk, lastSeen: row.last_seen };
}
function mapAuditEvent(row) { return { id: row.id, action: row.action, actor: row.actor, time: row.event_time, result: row.result }; }

function createApp({ pool = defaultPool } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "100kb" }));
  app.use(express.static(path.join(__dirname, "public")));

  const requireAuth = async (req, res, next) => {
    if (!pool) { req.user = { id: "demo-user", tenantId: "demo-tenant", email: "demo@example.invalid", role: "admin" }; return next(); }
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || token.length > 200) return res.status(401).json({ error: "Authentication required" });
    try {
      const result = await pool.query(
        "SELECT u.id,u.tenant_id,u.email,u.role FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at > NOW()",
        [hashToken(token)]
      );
      if (!result.rowCount) return res.status(401).json({ error: "Session expired or invalid" });
      const row = result.rows[0];
      req.user = { id: row.id, tenantId: row.tenant_id, email: row.email, role: row.role };
      return next();
    } catch (error) { return next(error); }
  };
  const requireRole = (...roles) => (req,res,next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: "Insufficient permissions" });
    next();
  };

  app.get("/health", (_req,res) => res.status(200).json({ status:"ok", service:"gogo-endpoint-central" }));
  app.get("/api/ready", async (_req,res) => {
    if (!pool) return res.status(200).json({ ready:true, mode:"demo", persistence:"in-memory", authRequired:false });
    try { await pool.query("SELECT 1"); return res.json({ ready:true, mode:"database", persistence:"postgresql", authRequired:true }); }
    catch (_error) { return res.status(503).json({ ready:false, mode:"database", persistence:"postgresql", authRequired:true }); }
  });

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Too many sign-in attempts. Try again later." } });
  app.post("/api/auth/login", loginLimiter, async (req,res,next) => {
    if (!pool) return res.status(503).json({ error:"Login is available only when PostgreSQL is configured. Demo mode uses sample data." });
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!validEmail(email) || !password || password.length > 1024) return res.status(400).json({ error:"Enter a valid email and password." });
    try {
      const result = await pool.query("SELECT id,tenant_id,email,password_hash,role FROM users WHERE email=$1", [email]);
      const user = result.rows[0];
      if (!user || !(await bcrypt.compare(password,user.password_hash))) return res.status(401).json({ error:"Invalid email or password." });
      const token = crypto.randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
      await pool.query("INSERT INTO auth_sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)", [hashToken(token),user.id,expiresAt]);
      await pool.query("DELETE FROM auth_sessions WHERE expires_at <= NOW()");
      return res.json({ token, expiresAt:expiresAt.toISOString(), user:{ id:user.id,email:user.email,role:user.role,tenantId:user.tenant_id } });
    } catch (error) { return next(error); }
  });

  app.post("/api/auth/logout", requireAuth, async (req,res,next) => {
    if (!pool) return res.json({ ok:true });
    try {
      const token = (req.get("authorization") || "").slice(7);
      await pool.query("DELETE FROM auth_sessions WHERE token_hash=$1", [hashToken(token)]);
      return res.json({ ok:true });
    } catch (error) { return next(error); }
  });
  app.get("/api/auth/me", requireAuth, (req,res) => res.json({ user:req.user }));

  app.post("/api/admin/users", requireAuth, requireRole("admin"), async (req,res,next) => {
    if (!pool) return res.status(503).json({ error:"User administration requires PostgreSQL." });
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const role = req.body.role;
    if (!validEmail(email) || password.length < 12 || password.length > 1024 || !["admin","operator","viewer"].includes(role)) {
      return res.status(400).json({ error:"Provide a valid email, a password of at least 12 characters, and role admin, operator, or viewer." });
    }
    try {
      const passwordHash = await bcrypt.hash(password,12);
      const id = "usr_" + crypto.randomUUID();
      await pool.query("INSERT INTO users (id,tenant_id,email,password_hash,role) VALUES ($1,$2,$3,$4,$5)", [id,req.user.tenantId,email,passwordHash,role]);
      return res.status(201).json({ user:{ id,email,role,tenantId:req.user.tenantId } });
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ error:"A user with this email already exists in your tenant." });
      return next(error);
    }
  });

  const enrollmentLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Too many enrollment attempts. Try again later." } });
  const heartbeatLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false });
  app.post("/api/admin/enrollment-tokens", requireAuth, requireRole("admin"), async (req,res,next) => {
    if (!pool) return res.status(503).json({ error:"Device enrollment requires PostgreSQL." });
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    try {
      await pool.query("INSERT INTO enrollment_tokens (token_hash,tenant_id,created_by,expires_at,uses_remaining) VALUES ($1,$2,$3,$4,1)",
        [hashToken(token),req.user.tenantId,req.user.id,expiresAt]);
      return res.status(201).json({ token, expiresAt:expiresAt.toISOString(), uses:1, note:"Store this token securely. It is shown only once and expires in 24 hours." });
    } catch (error) { return next(error); }
  });

  app.post("/api/agent/enroll", enrollmentLimiter, async (req,res,next) => {
    if (!pool) return res.status(503).json({ error:"Device enrollment requires PostgreSQL." });
    const enrollmentToken = typeof req.body.enrollmentToken === "string" ? req.body.enrollmentToken : "";
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    const os = typeof req.body.os === "string" ? req.body.os.trim() : "";
    const osVersion = typeof req.body.osVersion === "string" ? req.body.osVersion.trim() : "";
    if (enrollmentToken.length < 20 || enrollmentToken.length > 200 ||
        !name || name.length > 120 || !os || os.length > 80 || !osVersion || osVersion.length > 80) {
      return res.status(400).json({ error:"Provide a valid enrollment token, device name, OS, and OS version." });
    }
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      const claimed = await client.query(
        "UPDATE enrollment_tokens SET uses_remaining=uses_remaining-1 WHERE token_hash=$1 AND expires_at>NOW() AND uses_remaining>0 RETURNING tenant_id",
        [hashToken(enrollmentToken)]
      );
      if (!claimed.rowCount) {
        await client.query("ROLLBACK");
        return res.status(401).json({ error:"Enrollment token is invalid, expired, or already used." });
      }
      const tenantId = claimed.rows[0].tenant_id;
      const deviceId = "dev_" + crypto.randomUUID();
      const agentToken = crypto.randomBytes(32).toString("base64url");
      const now = new Date().toISOString();
      await client.query(
        "INSERT INTO devices (id,name,assigned_user,department,os,os_version,status,risk,last_seen,tenant_id) VALUES ($1,$2,$3,$4,$5,$6,'offline','medium',$7,$8)",
        [deviceId,name,"Unassigned","Unassigned",os,osVersion,"Never",tenantId]
      );
      await client.query("INSERT INTO device_agent_tokens (token_hash,device_id,tenant_id) VALUES ($1,$2,$3)",
        [hashToken(agentToken),deviceId,tenantId]);
      await client.query("INSERT INTO audit_events (id,action,actor,event_time,result,tenant_id) VALUES ($1,$2,$3,$4,$5,$6)",
        ["AUD_" + crypto.randomUUID(),"Device enrolled: " + name,deviceId,now,"success",tenantId]);
      await client.query("COMMIT");
      return res.status(201).json({ deviceId, agentToken, heartbeatEndpoint:"/api/agent/heartbeat", note:"Store the agent token securely. It is shown only once." });
    } catch (error) {
      if (client) { try { await client.query("ROLLBACK"); } catch (_rollbackError) {} }
      return next(error);
    } finally { if (client) client.release(); }
  });

  app.post("/api/admin/devices/:deviceId/revoke-agent", requireAuth, requireRole("admin"), async (req,res,next) => {
    if (!pool) return res.status(503).json({ error:"Agent credential management requires PostgreSQL." });
    const deviceId = typeof req.params.deviceId === "string" ? req.params.deviceId.slice(0,120) : "";
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      const device = await client.query("SELECT id,name FROM devices WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [deviceId,req.user.tenantId]);
      if (!device.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error:"Device not found in your workspace." });
      }
      const revoked = await client.query("DELETE FROM device_agent_tokens WHERE device_id=$1 AND tenant_id=$2 RETURNING token_hash", [deviceId,req.user.tenantId]);
      await client.query("UPDATE devices SET status='offline',updated_at=NOW() WHERE id=$1 AND tenant_id=$2", [deviceId,req.user.tenantId]);
      await client.query("INSERT INTO audit_events (id,action,actor,event_time,result,tenant_id) VALUES ($1,$2,$3,$4,$5,$6)",
        ["AUD_" + crypto.randomUUID(),"Agent credentials revoked for device: " + device.rows[0].name,req.user.email,new Date().toISOString(),"success",req.user.tenantId]);
      await client.query("COMMIT");
      return res.json({ ok:true, deviceId, revoked:revoked.rowCount > 0, note:"The device must be enrolled again before it can send heartbeats." });
    } catch (error) {
      if (client) { try { await client.query("ROLLBACK"); } catch (_rollbackError) {} }
      return next(error);
    } finally { if (client) client.release(); }
  });
  app.post("/api/agent/rotate-token", heartbeatLimiter, async (req,res,next) => {
    if (!pool) return res.status(503).json({ error:"Agent token rotation requires PostgreSQL." });
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || token.length > 200) return res.status(401).json({ error:"Agent authentication required." });
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      const current = await client.query(
        "SELECT t.device_id,t.tenant_id,d.name FROM device_agent_tokens t JOIN devices d ON d.id=t.device_id AND d.tenant_id=t.tenant_id WHERE t.token_hash=$1 FOR UPDATE OF t,d",
        [hashToken(token)]
      );
      if (!current.rowCount) {
        await client.query("ROLLBACK");
        return res.status(401).json({ error:"Agent token is invalid." });
      }
      const { device_id: deviceId, tenant_id: tenantId, name } = current.rows[0];
      const nextToken = crypto.randomBytes(32).toString("base64url");
      await client.query("DELETE FROM device_agent_tokens WHERE token_hash=$1", [hashToken(token)]);
      await client.query("INSERT INTO device_agent_tokens (token_hash,device_id,tenant_id) VALUES ($1,$2,$3)",
        [hashToken(nextToken),deviceId,tenantId]);
      await client.query("INSERT INTO audit_events (id,action,actor,event_time,result,tenant_id) VALUES ($1,$2,$3,$4,$5,$6)",
        ["AUD_" + crypto.randomUUID(),"Agent token rotated for device: " + name,deviceId,new Date().toISOString(),"success",tenantId]);
      await client.query("COMMIT");
      return res.json({ ok:true, deviceId, agentToken:nextToken, note:"Store the new token securely. It is shown only once; the previous token is now invalid." });
    } catch (error) {
      if (client) { try { await client.query("ROLLBACK"); } catch (_rollbackError) {} }
      return next(error);
    } finally { if (client) client.release(); }
  });

  app.post("/api/agent/heartbeat", heartbeatLimiter, async (req,res,next) => {
    if (!pool) return res.status(503).json({ error:"Agent heartbeat requires PostgreSQL." });
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || token.length > 200) return res.status(401).json({ error:"Agent authentication required." });
    const agentVersion = typeof req.body.agentVersion === "string" ? req.body.agentVersion.slice(0,40) : null;
    try {
      const result = await pool.query(
        "UPDATE devices d SET status='online',last_seen=NOW()::text,updated_at=NOW() FROM device_agent_tokens t WHERE t.token_hash=$1 AND t.device_id=d.id AND t.tenant_id=d.tenant_id RETURNING d.id,d.tenant_id",
        [hashToken(token)]
      );
      if (!result.rowCount) return res.status(401).json({ error:"Agent token is invalid." });
      await pool.query("UPDATE device_agent_tokens SET last_used_at=NOW() WHERE token_hash=$1",[hashToken(token)]);
      return res.json({ ok:true, deviceId:result.rows[0].id, receivedAt:new Date().toISOString(), agentVersion });
    } catch (error) { return next(error); }
  });

  app.get("/api/summary", requireAuth, async (req,res,next) => {
    try {
      const rows = pool
        ? (await pool.query("SELECT CASE WHEN status='online' AND updated_at < NOW() - INTERVAL '5 minutes' THEN 'offline' ELSE status END AS status,risk,COUNT(*)::int AS count FROM devices WHERE tenant_id=$1 GROUP BY 1,risk", [req.user.tenantId])).rows
        : demoDevices;
      const totalDevices = rows.reduce((sum,row) => sum + (pool ? row.count : 1),0);
      const count = (predicate) => rows.filter(predicate).reduce((sum,row) => sum + (pool ? row.count : 1),0);
      return res.json({ totalDevices,onlineDevices:count(r=>r.status==="online"),offlineDevices:count(r=>r.status==="offline"),highRiskDevices:count(r=>r.risk==="high"),mediumRiskDevices:count(r=>r.risk==="medium"),mode:pool?"database":"demo" });
    } catch (error) { return next(error); }
  });

  app.get("/api/devices", requireAuth, async (req,res,next) => {
    const status = typeof req.query.status === "string" ? req.query.status.toLowerCase() : "";
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (status && !["online","offline"].includes(status)) return res.status(400).json({ error:"status must be online or offline" });
    try {
      if (pool) {
        const values = [req.user.tenantId];
        const clauses = ["tenant_id = $1"];
        if (status) { values.push(status); clauses.push("(CASE WHEN status='online' AND updated_at < NOW() - INTERVAL '5 minutes' THEN 'offline' ELSE status END) = $" + values.length); }
        if (query) {
          values.push("%" + query.replace(/[\\%_]/g,"\\$&") + "%");
          const p = "$" + values.length;
          clauses.push("(id ILIKE " + p + " OR name ILIKE " + p + " OR assigned_user ILIKE " + p + " OR department ILIKE " + p + " OR os ILIKE " + p + ")");
        }
        const result = await pool.query("SELECT id,name,assigned_user,department,os,os_version,CASE WHEN status='online' AND updated_at < NOW() - INTERVAL '5 minutes' THEN 'offline' ELSE status END AS status,risk,CASE WHEN status='online' AND updated_at < NOW() - INTERVAL '5 minutes' THEN updated_at::text ELSE last_seen END AS last_seen FROM devices WHERE " + clauses.join(" AND ") + " ORDER BY name",values);
        const items = result.rows.map(mapDevice);
        return res.json({ items,total:items.length,mode:"database" });
      }
      const normalizedQuery = query.toLowerCase();
      const items = demoDevices.filter(d => (!status || d.status===status) && (!normalizedQuery || [d.id,d.name,d.user,d.department,d.os].some(v=>v.toLowerCase().includes(normalizedQuery))));
      return res.json({ items,total:items.length,mode:"demo" });
    } catch (error) { return next(error); }
  });

  app.get("/api/audit", requireAuth, async (req,res,next) => {
    try {
      if (!pool) return res.json({ items:demoAuditEvents,total:demoAuditEvents.length,mode:"demo" });
      const result = await pool.query("SELECT id,action,actor,event_time,result FROM audit_events WHERE tenant_id=$1 ORDER BY id DESC LIMIT 100",[req.user.tenantId]);
      const items = result.rows.map(mapAuditEvent);
      return res.json({ items,total:items.length,mode:"database" });
    } catch (error) { return next(error); }
  });

  app.use("/api", (_req,res) => res.status(404).json({ error:"API route not found" }));
  app.use((error,_req,res,_next) => {
    console.error("Request failed:",error.message);
    res.status(500).json({ error:"Internal server error" });
  });
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  initializeDatabase().then(() => {
    createApp().listen(port,"0.0.0.0",() => console.log("GOGO Endpoint Central started on port " + port + (defaultPool ? " with PostgreSQL and authentication" : " in demo mode")));
  }).catch(error => { console.error("Startup failed:",error.message); process.exit(1); });
}
module.exports = { createApp, initializeDatabase };
