# Release v1.1.0 — Admin Panel with Realtime User Monitoring

## New Features

### Admin Panel Authentication
- **SQLite-based user management** — admin credentials stored in `admin.db` (SHA-256 hashed)
- **Session-based login** with `express-session` — persistent across page reloads
- **Configurable defaults** via `ADMIN_USER` and `ADMIN_PASSWORD` in `.env` (used on first run only)
- **Login form** at `/admin` with username/password fields
- **Logout** button in header

### Realtime Connected Users Dashboard
- **Live upload/download rates** from MikroTik Simple Queues (`/queue/simple`)
- **1-second auto-refresh** via Socket.io — no manual refresh needed
- **Traffic columns**: ↑ Upload, ↓ Download, Total Bytes
- **Auto-connect** to router on server startup (no longer depends on monitoring page)

### Filters
- **VLAN filter** — dropdown populated from `MIKROTIK_VLAN_INTERFACES`
- **Type filter** — All / Queue Only / No Queue
- **Text search** — filter by IP, MAC, hostname, or interface
- Filters are synced to the server via Socket.io for live updates

### Stats Cards
- Total Users (filtered count)
- Dynamic / Static split
- Total Traffic (aggregate bytes)

## Changes
- Removed HTTP Basic Auth from admin routes
- Replaced random session secret with stable default (set `SESSION_SECRET` in `.env` for production)
- Increased RouterOS client timeout from 5s to 10s
- Added auto-reconnect on client error events
- Admin poll starts/stops based on viewer count (saves resources)
- Unlimited user count (was capped at 100)

## New Dependencies
- `better-sqlite3` — lightweight SQLite for admin credentials
- `express-session` — session management

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET`  | `/admin` | No | Admin dashboard (login form or users) |
| `POST` | `/api/admin/login` | No | Login with `{ username, password }` |
| `POST` | `/api/admin/logout` | Session | Destroy session |
| `GET`  | `/api/admin/me` | Session | Check auth status |
| `GET`  | `/api/admin/users` | Session | Get filtered user list (`?vlan=`, `?type=`) |
| `GET`  | `/api/admin/vlans` | Session | Get available VLAN interfaces |

## Socket.io Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `admin_watch` | Client → Server | Join admin watcher pool (starts 1s poll) |
| `admin_unwatch` | Client → Server | Leave watcher pool (stops poll if empty) |
| `admin_filter` | Client → Server | Update filters `{ vlan, type }` |
| `admin_users` | Server → Client | Push updated user list every 1s |

## Setup

```bash
# 1. Set admin password in .env (before first start)
ADMIN_USER=admin
ADMIN_PASSWORD=your_secure_password

# 2. Install dependencies
npm install

# 3. Start
npm start

# 4. Access admin panel at http://localhost:3000/admin
# Default: admin / admin (or value from ADMIN_PASSWORD)

# Reset admin password:
rm admin.db && npm start
```

## Breaking Changes
- Admin panel no longer uses HTTP Basic Auth — migrate to the new login form
- Existing browser Basic Auth sessions are invalid
