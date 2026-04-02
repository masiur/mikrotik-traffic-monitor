const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { RouterOSClient } = require("routeros-client");
const path = require("path");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
        timeout: 5,
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

io.on("connection", (socket) => {
  console.log("[*] Client connected");

  // Send current state immediately to new clients (fixes page-switch issue)
  if (monitorRunning && connectedHost) {
    socket.emit("connected", { host: connectedHost, routerName });
  }

  socket.on("start_monitor", () => startMonitor());
});

server.listen(WEB_PORT, WEB_HOST, () => {
  console.log(`[*] WAN interfaces: ${INTERFACES.join(", ")}`);
  console.log(`[*] VLAN interfaces: ${VLAN_INTERFACES.join(", ")}`);
  console.log(`[*] Router hosts: ${HOSTS.join(", ")}`);
  console.log(`[*] Server running at http://${WEB_HOST}:${WEB_PORT}`);
});
