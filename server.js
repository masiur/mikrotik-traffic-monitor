const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { RouterOSClient } = require("routeros-client");
const path = require("path");
const session = require("express-session");
const Database = require("better-sqlite3");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// SQLite database
const db = new Database(path.join(__dirname, "admin.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  )
`);

// Seed default admin if not exists
const defaultUser = db.prepare("SELECT id FROM admins WHERE username = ?").get("admin");
if (!defaultUser) {
  const seedUser = process.env.ADMIN_USER || "admin";
  const seedPass = process.env.ADMIN_PASSWORD || "changeme";
  const hash = crypto.createHash("sha256").update(seedPass).digest("hex");
  db.prepare("INSERT INTO admins (username, password_hash) VALUES (?, ?)").run(seedUser, hash);
  console.log(`[+] Seeded default admin (user: ${seedUser}, pass: ${seedPass})`);
}

// Session middleware
const SESSION_SECRET = process.env.SESSION_SECRET || "mikrotik-monitor-session-v1";
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 24 * 60 * 60 * 1000, path: "/", sameSite: "lax" },
  })
);

app.use(express.json());

// Config
const HOSTS = (process.env.MIKROTIK_HOSTS || "192.168.88.1")
  .split(",")
  .map((h) => h.trim());
const USER = process.env.MIKROTIK_USER || "admin";
const PASSWORD = process.env.MIKROTIK_PASSWORD || "";
const PORT = parseInt(process.env.MIKROTIK_PORT || "8728");
const INTERFACES = (process.env.MIKROTIK_INTERFACES || "ether1,ether2,ether3")
  .split(",")
  .map((i) => i.trim());
const VLAN_INTERFACES = (process.env.MIKROTIK_VLAN_INTERFACES || "")
  .split(",")
  .map((i) => i.trim())
  .filter(Boolean);
const ALL_INTERFACES = [...INTERFACES, ...VLAN_INTERFACES];
const POLL_INTERVAL = parseFloat(process.env.POLL_INTERVAL || "1") * 1000;
const WEB_PORT = parseInt(process.env.WEB_PORT || "3000");
const WEB_HOST = process.env.WEB_HOST || "0.0.0.0";
const APP_TITLE = process.env.APP_TITLE || "MikroTik Traffic Monitor";
const APP_LOGO = process.env.APP_LOGO || "";

app.use(express.static(path.join(__dirname, "public")));

// API endpoint for client config
app.get("/api/config", (req, res) => {
  res.json({
    appTitle: APP_TITLE,
    appLogo: APP_LOGO,
    interfaces: INTERFACES,
    vlanInterfaces: VLAN_INTERFACES,
  });
});

app.get("/vlans", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "vlans.html"));
});

// Session-based auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  return res.status(401).json({ error: "Not authenticated" });
}

// Fetch DHCP-bound users + Simple Queues from router (no ARP scan)
async function getActiveUsers(api, vlanFilter) {
  try {
    // Fetch only bound DHCP leases — lightweight, no ARP scan
    let leases = [];
    try {
      leases = await api.menu("/ip/dhcp-server/lease", {
        "status": "bound",
        ".proplist": "address,active-address,mac-address,active-mac-address,host-name,active-server,expires-after,dynamic",
      }).getAll();
    } catch {}

    // Fetch Simple Queues — get per-IP rates
    let queueMap = {};
    try {
      const queues = await api.menu("/queue/simple", {
        ".proplist": "name,target,rate,bytes,disabled,invalid,max-limit",
      }).getAll();
      for (const q of queues) {
        if (q.disabled === true || q.disabled === "true") continue;
        if (q.invalid === true || q.invalid === "true") continue;

        const target = q.target || "";
        const rateStr = q.rate || "0/0";
        const rateParts = rateStr.split("/").map(Number);
        const uploadBps = (rateParts[0] || 0) * 8;
        const downloadBps = (rateParts[1] || 0) * 8;

        const bytesStr = q.bytes || "0/0";
        const bytesParts = bytesStr.split("/").map(Number);
        const uploadTotal = bytesParts[0] || 0;
        const downloadTotal = bytesParts[1] || 0;

        const targets = target.split(",").map(t => t.trim());
        for (const t of targets) {
          const ipMatch = t.split("/")[0].split("-")[0];
          if (ipMatch && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipMatch)) {
            queueMap[ipMatch] = {
              uploadBps,
              downloadBps,
              uploadTotal,
              downloadTotal,
              maxLimit: q["max-limit"] || "",
              name: q.name || "",
            };
          }
        }
      }
    } catch (err) {
      console.log(`[!] Queue fetch error: ${err.message}`);
    }

    const users = [];
    for (const lease of leases) {
      // active-address is the current live IP (may differ from static address)
      const ip = lease["active-address"] || lease.address;
      const mac = lease["active-mac-address"] || lease["mac-address"];
      if (!ip || !mac) continue;

      const iface = lease["active-server"] || "";
      if (vlanFilter && vlanFilter !== "all") {
        if (iface !== vlanFilter && !iface.includes(vlanFilter)) continue;
      }

      const queue = queueMap[ip] || null;

      users.push({
        ip,
        mac,
        interface: iface,
        hostname: lease["host-name"] || "",
        dhcpStatus: "bound",
        dynamic: lease.dynamic === true || lease.dynamic === "true",
        uploadBps: queue ? queue.uploadBps : 0,
        downloadBps: queue ? queue.downloadBps : 0,
        totalBytes: queue ? queue.uploadTotal + queue.downloadTotal : 0,
        maxLimit: queue ? queue.maxLimit : "",
        queueName: queue ? queue.name : "",
      });
    }

    users.sort((a, b) => {
      const aParts = a.ip.split(".").map(Number);
      const bParts = b.ip.split(".").map(Number);
      for (let i = 0; i < 4; i++) {
        if (aParts[i] !== bParts[i]) return aParts[i] - bParts[i];
      }
      return 0;
    });

    return users;
  } catch (err) {
    console.log(`[!] Active users error: ${err.message}`);
    return null;
  }
}

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }
  const admin = db.prepare("SELECT * FROM admins WHERE username = ?").get(username);
  if (!admin) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const hash = crypto.createHash("sha256").update(password).digest("hex");
  if (hash !== admin.password_hash) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  req.session.authenticated = true;
  req.session.username = username;
  res.json({ ok: true, username });
});

app.post("/api/admin/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "Failed to logout" });
    res.json({ ok: true });
  });
});

app.get("/api/admin/me", (req, res) => {
  if (!req.session?.authenticated) {
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true, username: req.session.username });
});

app.get("/api/admin/users", requireAuth, async (req, res) => {
  if (!apiClient?.api) {
    const api = await connectRouter();
    if (!api) {
      return res.status(503).json({ error: "Router not connected" });
    }
    routerName = await getRouterIdentity(api);
  }
  const vlan = req.query.vlan || "";
  const type = req.query.type || "all";
  const users = await getActiveUsers(apiClient.api, vlan);
  if (!users) {
    return res.status(500).json({ error: "Failed to fetch users" });
  }

  let filtered = users;
  if (type === "queue-only") filtered = users.filter(u => u.queueName);
  else if (type === "no-queue") filtered = users.filter(u => !u.queueName);

  res.json({ users: filtered, routerName, host: connectedHost });
});

// Get available VLAN interfaces for the filter dropdown
app.get("/api/admin/vlans", requireAuth, async (req, res) => {
  const vlans = VLAN_INTERFACES.filter(Boolean);
  res.json({ vlans });
});

// Auto-connect on startup for admin API
connectRouter().then((api) => {
  if (api) {
    getRouterIdentity(api).then((name) => {
      routerName = name;
      console.log(`[+] Router: ${routerName}`);
    });
  }
}).catch((err) => {
  console.log(`[-] Startup connect error: ${err.message}`);
});

let apiClient = null;
let connectedHost = null;
let routerName = "MikroTik";

async function connectRouter() {
  for (const host of HOSTS) {
    try {
      console.log(`[*] Trying ${host}:${PORT}...`);
      const client = new RouterOSClient({
        host,
        user: USER,
        password: PASSWORD,
        port: PORT,
        timeout: 10,
      });
      client.on("error", (err) => {
        console.log(`[-] Client error on ${host}: ${err.message}`);
        // Attempt reconnect
        if (apiClient?.client === client) {
          apiClient = null;
          connectRouter();
        }
      });
      const api = await client.connect();
      connectedHost = host;
      apiClient = { client, api };
      console.log(`[+] Connected to ${host}`);
      return api;
    } catch (err) {
      console.log(`[-] Failed ${host}: ${err.message}`);
    }
  }
  console.log("[!] All hosts failed");
  return null;
}

async function getRouterIdentity(api) {
  try {
    const identity = await api.menu("/system/identity").getAll();
    return identity[0]?.name || "MikroTik";
  } catch {
    return "MikroTik";
  }
}

async function getInterfaceStats(api) {
  try {
    const ifaces = await api.menu("/interface").getAll();
    const stats = {};
    for (const iface of ifaces) {
      if (ALL_INTERFACES.includes(iface.name)) {
        stats[iface.name] = {
          txBytes: parseInt(iface.txByte || "0"),
          rxBytes: parseInt(iface.rxByte || "0"),
          running: iface.running === true || iface.running === "true",
          disabled: iface.disabled === true || iface.disabled === "true",
        };
      }
    }
    return stats;
  } catch (err) {
    console.log(`[!] Stats error: ${err.message}`);
    return null;
  }
}

function calcSpeed(prev, curr, intervalMs) {
  const result = {};
  const intervalSec = intervalMs / 1000;
  for (const name of Object.keys(curr)) {
    if (prev[name]) {
      let txDiff = curr[name].txBytes - prev[name].txBytes;
      let rxDiff = curr[name].rxBytes - prev[name].rxBytes;
      if (txDiff < 0) txDiff = 0;
      if (rxDiff < 0) rxDiff = 0;
      result[name] = {
        txMbps: parseFloat(((txDiff * 8) / (intervalSec * 1e6)).toFixed(3)),
        rxMbps: parseFloat(((rxDiff * 8) / (intervalSec * 1e6)).toFixed(3)),
        txBytesTotal: curr[name].txBytes,
        rxBytesTotal: curr[name].rxBytes,
        running: curr[name].running,
        disabled: curr[name].disabled,
      };
    }
  }
  return result;
}

let monitorRunning = false;

async function startMonitor() {
  if (monitorRunning) return;
  monitorRunning = true;

  const api = await connectRouter();
  if (!api) {
    io.emit("error", { message: "Cannot connect to any router host" });
    monitorRunning = false;
    return;
  }

  routerName = await getRouterIdentity(api);
  io.emit("connected", { host: connectedHost, routerName });

  let prevStats = await getInterfaceStats(api);
  if (!prevStats) {
    io.emit("error", { message: "Failed to read interface stats" });
    monitorRunning = false;
    return;
  }

  const loop = async () => {
    const currStats = await getInterfaceStats(api);

    if (!currStats) {
      io.emit("status", { message: "Connection lost, reconnecting..." });
      if (apiClient?.client) {
        try {
          await apiClient.client.close();
        } catch {}
      }
      const newApi = await connectRouter();
      if (!newApi) {
        io.emit("error", { message: "Reconnection failed" });
        setTimeout(loop, 5000);
        return;
      }
      routerName = await getRouterIdentity(newApi);
      io.emit("connected", { host: connectedHost, routerName });
      prevStats = await getInterfaceStats(newApi);
      setTimeout(loop, POLL_INTERVAL);
      return;
    }

    const speeds = calcSpeed(prevStats, currStats, POLL_INTERVAL);
    prevStats = currStats;

    const wanSpeeds = {};
    const vlanSpeeds = {};
    for (const [name, data] of Object.entries(speeds)) {
      if (INTERFACES.includes(name)) wanSpeeds[name] = data;
      if (VLAN_INTERFACES.includes(name)) vlanSpeeds[name] = data;
    }

    io.emit("traffic", { timestamp: Date.now() / 1000, speeds: wanSpeeds });
    io.emit("vlan_traffic", { timestamp: Date.now() / 1000, speeds: vlanSpeeds });

    setTimeout(loop, POLL_INTERVAL);
  };

  setTimeout(loop, POLL_INTERVAL);
}

let adminWatchers = 0;
let adminPollRunning = false;
let adminFilters = { vlan: "", type: "all" }; // shared filter state

async function startAdminPoll() {
  if (adminPollRunning) return;
  adminPollRunning = true;
  console.log("[+] Admin poll started (1s interval)");

  const poll = async () => {
    if (adminWatchers <= 0 || !apiClient?.api) {
      adminPollRunning = false;
      console.log("[-] Admin poll stopped");
      return;
    }
    const { vlan, type } = adminFilters;
    const users = await getActiveUsers(apiClient.api, vlan);
    if (!users) {
      setTimeout(poll, 1000);
      return;
    }

    // Server-side type filter
    let filtered = users;
    if (type === "queue-only") filtered = users.filter(u => u.queueName);
    else if (type === "no-queue") filtered = users.filter(u => !u.queueName);

    io.emit("admin_users", {
      users: filtered,
      totalAll: users.length,
      totalQueued: users.filter(u => u.queueName).length,
      totalNoQueue: users.filter(u => !u.queueName).length,
      routerName,
      host: connectedHost,
    });
    setTimeout(poll, 1000);
  };
  poll();
}

io.on("connection", (socket) => {
  console.log("[*] Client connected");

  // Send current state immediately to new clients (fixes page-switch issue)
  if (monitorRunning && connectedHost) {
    socket.emit("connected", { host: connectedHost, routerName });
  }

  socket.on("start_monitor", () => startMonitor());

  // Admin panel: join watchers group
  socket.on("admin_watch", () => {
    adminWatchers++;
    startAdminPoll();
  });

  socket.on("admin_unwatch", () => {
    adminWatchers = Math.max(0, adminWatchers - 1);
  });

  socket.on("admin_filter", (filters) => {
    if (filters.vlan !== undefined) adminFilters.vlan = filters.vlan;
    if (filters.type !== undefined) adminFilters.type = filters.type;
  });
});

server.listen(WEB_PORT, WEB_HOST, () => {
  console.log(`[*] WAN interfaces: ${INTERFACES.join(", ")}`);
  console.log(`[*] VLAN interfaces: ${VLAN_INTERFACES.join(", ")}`);
  console.log(`[*] Router hosts: ${HOSTS.join(", ")}`);
  console.log(`[*] Server running at http://${WEB_HOST}:${WEB_PORT}`);
});
