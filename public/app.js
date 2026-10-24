const $ = (id) => document.getElementById(id);
let currentDevices = [];
let toastTimer;
let accessToken = "";
let authRequired = false;

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

async function getJson(url) {
  const headers = { Accept: "application/json" };
  if (accessToken) headers.Authorization = "Bearer " + accessToken;
  const response = await fetch(url, { headers });
  if (response.status === 401 && authRequired) showAuthGate("Your session expired. Please sign in again.");
  if (!response.ok) throw new Error("Request failed (" + response.status + ")");
  return response.json();
}

function renderDevices(items) {
  const rows = $("deviceRows");
  $("deviceCount").textContent = items.length + (items.length === 1 ? " device" : " devices");
  $("resultsText").textContent = "Showing " + items.length + " sample " + (items.length === 1 ? "device" : "devices");
  if (!items.length) {
    rows.innerHTML = '<tr><td colspan="5" class="empty-state">No devices match your search.</td></tr>';
    return;
  }
  rows.innerHTML = items.map((device) => {
    const status = device.status === "online" ? "online" : "offline";
    const risk = ["low", "medium", "high"].includes(device.risk) ? device.risk : "medium";
    return '<tr><td><div class="device-name"><span class="device-glyph">▣</span><div><strong>' + escapeHtml(device.name) + '</strong><small>' + escapeHtml(device.id) + '</small></div></div></td>' +
      '<td><span class="user-name">' + escapeHtml(device.user) + '</span><br><small>' + escapeHtml(device.department) + '</small></td>' +
      '<td>' + escapeHtml(device.os) + '<br><small>' + escapeHtml(device.version) + '</small></td>' +
      '<td><span class="pill ' + status + '">' + status + '</span></td>' +
      '<td><span class="pill ' + risk + '">' + risk + '</span></td></tr>';
  }).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function renderAudit(items) {
  const list = $("auditList");
  if (!items.length) {
    list.innerHTML = '<p class="empty-state">No activity to display.</p>';
    return;
  }
  list.innerHTML = items.map((event) => '<div class="audit-item"><span class="audit-marker">✓</span><div><strong>' +
    escapeHtml(event.action) + '</strong><p>' + escapeHtml(event.actor) + '</p><time>' + escapeHtml(event.time) +
    '</time></div></div>').join("");
}

async function loadDashboard(showMessage) {
  try {
    const [summary, deviceResult, audit] = await Promise.all([
      getJson("/api/summary"),
      getJson("/api/devices"),
      getJson("/api/audit")
    ]);
    $("totalDevices").textContent = summary.totalDevices;
    $("onlineDevices").textContent = summary.onlineDevices;
    $("offlineDevices").textContent = summary.offlineDevices;
    $("highRiskDevices").textContent = summary.highRiskDevices;
    currentDevices = deviceResult.items;
    applyFilters();
    renderAudit(audit.items);
    if (showMessage) showToast("Demo data refreshed");
  } catch (error) {
    showToast("Could not load dashboard. Check the server and retry.");
    $("deviceRows").innerHTML = '<tr><td colspan="5" class="empty-state">Dashboard data is unavailable.</td></tr>';
  }
}

function applyFilters() {
  const query = $("searchInput").value.trim().toLowerCase();
  const status = $("statusFilter").value;
  const filtered = currentDevices.filter((device) => {
    const statusMatches = !status || device.status === status;
    const text = [device.id, device.name, device.user, device.department, device.os].join(" ").toLowerCase();
    return statusMatches && (!query || text.includes(query));
  });
  renderDevices(filtered);
}

$("searchInput").addEventListener("input", applyFilters);
$("statusFilter").addEventListener("change", applyFilters);
$("refreshButton").addEventListener("click", () => loadDashboard(true));
$("exportButton").addEventListener("click", () => {
  const rows = [["Device ID", "Device", "Assigned user", "Department", "OS", "Version", "Status", "Risk"]];
  const query = $("searchInput").value.trim().toLowerCase();
  const status = $("statusFilter").value;
  currentDevices.filter((device) => {
    const statusMatches = !status || device.status === status;
    const text = [device.id, device.name, device.user, device.department, device.os].join(" ").toLowerCase();
    return statusMatches && (!query || text.includes(query));
  }).forEach((device) => rows.push([device.id, device.name, device.user, device.department, device.os, device.version, device.status, device.risk]));
  const csv = rows.map((row) => row.map((value) => '"' + String(value).replace(/"/g, '""') + '"').join(",")).join("\r
");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "gogo-device-inventory-demo.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("Inventory CSV exported");
});

async function initializeAuth() {
  try {
    const ready = await getJson("/api/ready");
    authRequired = Boolean(ready.authRequired);
    if (authRequired) {
      showAuthGate("Sign in with your workspace administrator account.");
      return;
    }
    loadDashboard(false);
  } catch (_error) {
    showToast("Server readiness check failed.");
  }
}
function showAuthGate(message) {
  const gate = $("authGate");
  if (!gate) return;
  gate.hidden = false;
  $("authMessage").textContent = message;
  const shell = document.querySelector(".app-shell");
  if (shell) shell.setAttribute("aria-hidden", "true");
}
$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("loginButton");
  button.disabled = true;
  $("authMessage").textContent = "Signing in…";
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: $("loginEmail").value, password: $("loginPassword").value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Sign-in failed.");
    accessToken = data.token;
    $("loginPassword").value = "";
    $("authGate").hidden = true;
    const shell = document.querySelector(".app-shell");
    if (shell) shell.removeAttribute("aria-hidden");
    loadDashboard(false);
  } catch (error) {
    $("authMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
initializeAuth();
