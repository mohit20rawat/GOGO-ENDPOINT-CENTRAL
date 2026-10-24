const express = require("express");
const path = require("node:path");

const devices = [
  { id: "DEV-1001", name: "FIN-LAP-014", user: "Aarav Sharma", department: "Finance", os: "Windows 11", version: "23H2", status: "online", risk: "low", lastSeen: "Just now" },
  { id: "DEV-1002", name: "HR-LAP-006", user: "Diya Kapoor", department: "Human Resources", os: "Windows 11", version: "23H2", status: "online", risk: "medium", lastSeen: "2 min ago" },
  { id: "DEV-1003", name: "ENG-MAC-022", user: "Kabir Mehta", department: "Engineering", os: "macOS", version: "15.1", status: "offline", risk: "low", lastSeen: "3 hours ago" },
  { id: "DEV-1004", name: "OPS-LAP-031", user: "Anaya Singh", department: "Operations", os: "Windows 10", version: "22H2", status: "online", risk: "high", lastSeen: "1 min ago" },
  { id: "DEV-1005", name: "SALES-LAP-019", user: "Ishaan Verma", department: "Sales", os: "Windows 11", version: "24H2", status: "online", risk: "low", lastSeen: "Just now" },
  { id: "DEV-1006", name: "DESIGN-MAC-008", user: "Sana Khan", department: "Design", os: "macOS", version: "14.7", status: "offline", risk: "medium", lastSeen: "Yesterday" }
];

const auditEvents = [
  { id: "AUD-0003", action: "Inventory dashboard viewed", actor: "Demo Admin", time: "Just now", result: "success" },
  { id: "AUD-0002", action: "Device risk review generated", actor: "Demo Admin", time: "12 min ago", result: "success" },
  { id: "AUD-0001", action: "Demo workspace initialized", actor: "System", time: "Today", result: "success" }
];

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", service: "gogo-endpoint-central" });
  });

  app.get("/api/ready", (_req, res) => {
    res.status(200).json({ ready: true, mode: "demo", persistence: "in-memory" });
  });

  app.get("/api/summary", (_req, res) => {
    res.json({
      totalDevices: devices.length,
      onlineDevices: devices.filter((device) => device.status === "online").length,
      offlineDevices: devices.filter((device) => device.status === "offline").length,
      highRiskDevices: devices.filter((device) => device.risk === "high").length,
      mediumRiskDevices: devices.filter((device) => device.risk === "medium").length,
      mode: "demo"
    });
  });

  app.get("/api/devices", (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status.toLowerCase() : "";
    const query = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    if (status && !["online", "offline"].includes(status)) {
      return res.status(400).json({ error: "status must be online or offline" });
    }
    const filtered = devices.filter((device) => {
      const statusMatches = !status || device.status === status;
      const queryMatches = !query || [device.id, device.name, device.user, device.department, device.os]
        .some((value) => value.toLowerCase().includes(query));
      return statusMatches && queryMatches;
    });
    return res.json({ items: filtered, total: filtered.length, mode: "demo" });
  });

  app.get("/api/audit", (_req, res) => {
    res.json({ items: auditEvents, total: auditEvents.length, mode: "demo" });
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, "0.0.0.0", () => {
    console.log("GOGO Endpoint Central demo listening on port " + port);
  });
}

module.exports = { createApp };
