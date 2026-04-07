# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Real-time MikroTik router traffic monitor. Single-process Node.js server that connects to MikroTik RouterOS API, polls interface stats every second, and pushes live speed data to browser clients via WebSocket.

## Commands

- `npm start` — run the server (production)
- `npm run dev` — run with `--watch` for auto-restart on file changes
- `docker compose up --build` — run via Docker

No test suite or linter is configured.

## Architecture

**Single entry point:** `server.js` — Express HTTP server + Socket.IO WebSocket server in one process.

**Data flow:**
1. Server connects to MikroTik router(s) via RouterOS API (TCP port 8728) with failover across multiple hosts
2. Polls `/interface` menu every `POLL_INTERVAL` seconds for byte counters
3. Calculates delta between polls to derive Mbps speeds
4. Emits `traffic` (WAN) and `vlan_traffic` (VLAN) events to all connected Socket.IO clients
5. Auto-reconnects on connection loss, trying each host in `MIKROTIK_HOSTS`

**Frontend pages (all in `public/`):**
- `index.html` — WAN traffic dashboard (Chart.js graphs, download=rx, upload=tx from router perspective)
- `vlans.html` — VLAN traffic dashboard (perspective is swapped: download=tx, upload=rx from user perspective)
- `admin.html` — Connected users table (IP, MAC, hostname from ARP + DHCP data), protected by HTTP Basic Auth

**Key API endpoints:**
- `GET /api/config` — public, returns app title/logo/interface list for frontend init
- `GET /api/admin/users` — Basic Auth protected, returns ARP/DHCP user list from router

**Socket.IO events:**
- Server emits: `connected`, `traffic`, `vlan_traffic`, `error`, `status`
- Client emits: `start_monitor` (triggers polling loop if not already running)

## Configuration

All config via `.env` (see `.env.example`). Key variables:
- `MIKROTIK_HOSTS` — comma-separated router IPs (failover order)
- `MIKROTIK_INTERFACES` / `MIKROTIK_VLAN_INTERFACES` — which interfaces to monitor
- `ADMIN_USER` / `ADMIN_PASSWORD` — credentials for `/admin` Basic Auth

## Important Patterns

- The `apiClient` global holds the active RouterOS connection (`{ client, api }`). Both the monitor loop and admin endpoint share it.
- `routeros-client` returns string values for booleans and numbers — always compare with both `true` and `"true"`, and `parseInt` byte counters.
- Byte counter rollover (64-bit wrap) is handled by clamping negative diffs to 0.
- No external dependencies for auth — Basic Auth is implemented inline using `Buffer.from(base64)`.
