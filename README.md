# MikroTik Real-Time Traffic Monitor

A real-time web dashboard for monitoring WAN interface traffic on MikroTik routers. Built with Node.js, Socket.IO, and Chart.js.

## Features

- **Real-time graphs** — live download/upload speed per interface (updates every second)
- **Multi-host failover** — configure multiple router IPs; app tries each until one connects
- **Auto-reconnect** — recovers automatically if the router connection drops
- **Summary cards** — total bandwidth and per-interface speed at a glance
- **Interface status** — shows RUNNING / DOWN / DISABLED state
- **Dark UI** — clean, minimal dashboard designed for always-on monitoring

## Prerequisites

- **Node.js** v18+ installed on the monitoring machine
- **MikroTik RouterOS** with API service enabled
- Network connectivity from the monitoring machine to the router's API port

### Enable RouterOS API

On your MikroTik router (via Winbox, WebFig, or terminal):

```
/ip service enable api
```

The default API port is **8728**. Verify it's enabled under **IP > Services**.

### Create a dedicated API user (recommended)

```
/user add name=netmonitor password=netmonitor group=read
```

The `read` group is sufficient — the app only reads interface statistics.

## Setup

1. **Clone / copy the project**

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Configure environment**

   Copy `.env.example` to `.env` and edit:

   ```bash
   cp .env.example .env
   ```

   ```env
   # Router IPs — comma-separated, tries each in order until one connects
   MIKROTIK_HOSTS=192.168.88.1,10.0.0.1

   # RouterOS API credentials
   MIKROTIK_USER=netmonitor
   MIKROTIK_PASSWORD=netmonitor

   # API port (default 8728, SSL: 8729)
   MIKROTIK_PORT=8728

   # Interfaces to monitor (must match exact names from /interface/print)
   MIKROTIK_INTERFACES=ether5-bracnet,ether8-Orbit,ether9-starlink

   # Polling interval in seconds
   POLL_INTERVAL=1

   # Web server
   WEB_HOST=0.0.0.0
   WEB_PORT=3000
   ```

   **To find your interface names**, run on the router terminal:

   ```
   /interface print
   ```

4. **Start the server**

   ```bash
   npm start
   ```

   Or with auto-reload during development:

   ```bash
   npm run dev
   ```

5. **Open the dashboard**

   ```
   http://localhost:3000
   ```

## How It Works

1. **server.js** connects to the MikroTik router via the RouterOS API (port 8728) using the `routeros-client` library
2. Every second, it reads `/interface` stats (tx/rx byte counters) for the configured interfaces
3. It calculates the speed delta (Mbps) between consecutive polls
4. Results are pushed to the browser via **Socket.IO** (WebSocket)
5. The browser renders live-updating **Chart.js** line graphs per interface

```
MikroTik Router ──(API port 8728)──> server.js ──(WebSocket)──> Browser Dashboard
```

## Project Structure

```
mikrotik/
├── .env                # Router credentials & config (not committed)
├── .env.example        # Template for .env
├── .gitignore
├── package.json
├── server.js           # Node.js backend — API polling + WebSocket server
├── public/
│   └── index.html      # Dashboard UI — charts, summary cards
└── README.md
```

## Performance Impact on Router

**Minimal.** The app makes one lightweight API read (`/interface getAll`) per second — the same call Winbox uses to display interface traffic. MikroTik routers handle this without measurable CPU or memory impact. Safe for production use.

## Tech Stack

- **Node.js** + **Express** — web server
- **Socket.IO** — real-time WebSocket communication
- **routeros-client** — MikroTik RouterOS API client
- **Chart.js** — browser-side charting
- **dotenv** — environment configuration
