const express = require("express");
const path = require("node:path");

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
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });
}

async function initializeDatabase(pool = defaultPool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      assigned_user TEXT NOT NULL,
      department TEXT NOT NULL,
      os TEXT NOT NULL,
      os_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('online', 'offline')),
      risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
      last_seen TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      event_time TEXT NOT NULL,
      result TEXT NOT NULL CHECK (result IN ('success', 'failure'))
    )
  `);
  const count = await pool.query("SELECT COUNT(*)::int AS count FROM devices");
  if (count.rows[0].count === 0) {
    for (const device of demoDevices) {
      await pool.query(
        "INSERT INTO devices (id, name, assigned_user, department, os, os_version, status, risk, last_seen) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING",
        [device.id, device.name, device.user, device.department, device.os, device.version, device.status, device.risk, device.lastSeen]
      );
    }
  }
  const auditCount = await pool.query("SELECT COUNT(*)::int AS count FROM audit_events");
  if (auditCount.rows[0].count === 0) {
    for (const event of demoAuditEvents) {
      await pool.query(
        "INSERT INTO audit_events (id, action, actor, event_time, result) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING",
        [event.id, event.action, event.actor, event.time, event.result]
      );
    }
  }
}

function mapDevice(row) {
  return {
    id: row.id, name: row.name, user: row.assigned_user, department: row.department,
    os: row.os, version: row.os_version, status: row.status, risk: row.risk, lastSeen: row.last_seen
  };
}

function mapAuditEvent(row) {
  return { id: row.id, action: row.action, actor: row.actor, time: row.event_time, result: row.result };
}

function createApp({ pool = defaultPool } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", service: "gogo-endpoint-central" });
  });

  app.get("/api/ready", async (_req, res) => {
    if (!pool) return res.status(200).json({ ready: true, mode: "demo", persistence: "in-memory" });
    try {
      await pool.query("SELECT 1");
      return res.status(200).json({ ready: true, mode: "database", persistence: "postgresql" });
    } catch (_error) {
      return res.status(503).json({ ready: false, mode: "database", persistence: "postgresql" });
    }
  });

  app.get("/api/summary", async (_req, res, next) => {
    try {
      const rows = pool
        ? (await pool.query("SELECT status, risk, COUNT(*)::int AS count FROM devices GROUP BY status, risk")).rows
        : demoDevices;
      const devices = pool ? null : rows;
      const totalDevices = pool ? rows.reduce((sum, row) => sum + row.count, 0) : devices.length;
      const onlineDevices = pool ? rows.filter((row) => row.status === "online").reduce((sum, row) => sum + row.count, 0) : devices.filter((d) => d.status === "online").length;
      const offlineDevices = pool ? rows.filter((row) => row.status === "offline").reduce((sum, row) => sum + row.count, 0) : devices.filter((d) => d.status === "offline").length;
      const highRiskDevices = pool ? rows.filter((row) => row.risk === "high").reduce((sum, row) => sum + row.count, 0) : devices.filter((d) => d.risk === "high").length;
      const mediumRiskDevices = pool ? rows.filter((row) => row.risk === "medium").reduce((sum, row) => sum + row.count, 0) : devices.filter((d) => d.risk === "medium").length;
      return res.json({ totalDevices, onlineDevices, offlineDevices, highRiskDevices, mediumRiskDevices, mode: pool ? "database" : "demo" });
    } catch (error) { return next(error); }
  });

  app.get("/api/devices", async (req, res, next) => {
    const status = typeof req.query.status === "string" ? req.query.status.toLowerCase() : "";
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (status && !["online", "offline"].includes(status)) {
      return res.status(400).json({ error: "status must be online or offline" });
    }
    try {
      if (pool) {
        const values = [];
        const clauses = [];
        if (status) { values.push(status); clauses.push("status = $"+values.length); }
        if (query) {
          values.push("%" + query.replace(/[\\%_]/g, "\\$&") + "%");
          const p = "$" + values.length;
          clauses.push("(id ILIKE " + p + " OR name ILIKE " + p + " OR assigned_user ILIKE " + p + " OR department ILIKE " + p + " OR os ILIKE " + p + ")");
        }
        const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
        const result = await pool.query("SELECT id, name, assigned_user, department, os, os_version, status, risk, last_seen FROM devices" + where + " ORDER BY name", values);
        const items = result.rows.map(mapDevice);
        return res.json({ items, total: items.length, mode: "database" });
      }
      const normalizedQuery = query.toLowerCase();
      const items = demoDevices.filter((device) => {
        const statusMatches = !status || device.status === status;
        const queryMatches = !normalizedQuery || [device.id, device.name, device.user, device.department, device.os]
          .some((value) => value.toLowerCase().includes(normalizedQuery));
        return statusMatches && queryMatches;
      });
      return res.json({ items, total: items.length, mode: "demo" });
    } catch (error) { return next(error); }
  });

  app.get("/api/audit", async (_req, res, next) => {
    try {
      if (!pool) return res.json({ items: demoAuditEvents, total: demoAuditEvents.length, mode: "demo" });
      const result = await pool.query("SELECT id, action, actor, event_time, result FROM audit_events ORDER BY id DESC LIMIT 100");
      const items = result.rows.map(mapAuditEvent);
      return res.json({ items, total: items.length, mode: "database" });
    } catch (error) { return next(error); }
  });

  app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found" }));
  app.use((error, _req, res, _next) => {
    console.error("Request failed:", error.message);
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  initializeDatabase().then(() => {
    createApp().listen(port, "0.0.0.0", () => {
      console.log("GOGO Endpoint Central started on port " + port + (defaultPool ? " with PostgreSQL persistence" : " in demo mode"));
    });
  }).catch((error) => {
    console.error("Database initialization failed:", error.message);
    process.exit(1);
  });
}

module.exports = { createApp, initializeDatabase };
