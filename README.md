# Campus Bus Tracker

Real-time campus bus tracking (IIT BHU). Built in phases; each phase stays runnable.
Status: **Phase 10** — ready to deploy for ₹0 (Vercel + Render + Neon). Hardened, with admin dashboard, sign-in, stop arrival times and live updates.

## Port assignments (important — runs alongside the "keera" project)

| Service | Host port | Notes |
|---|---|---|
| Frontend (Vite) | **5174** | keera uses 5173 |
| Backend (Express) | **3001** | keera uses 3000 |
| PostgreSQL | **5433** | keera uses 5432 |
| Redis | 6379 | shared, first-come-first-served |

`strictPort: true` in `vite.config.ts` means Vite will **error immediately** if 5174 is also taken, rather than silently drifting to 5175 and breaking the CORS allow-list.

## Run it (Windows CMD / PowerShell)

Start the database (Postgres on host port **5433**, Redis on 6379):

```cmd
docker compose up -d
```

Backend (leave this window open):

```cmd
cd backend
copy .env.example .env
npm install
npm run migrate
npm run seed
npm run dev
```

Backend API is now available at **http://localhost:3001**

Frontend (second window):

```cmd
cd frontend
npm install
npm run dev
```

Open **http://localhost:5174** for the student map.

### See it work without driving anywhere

1. Open **http://localhost:5174/driver** and sign in with the seeded dev driver: `driver@example.com` / `driver-dev-123`.
2. Tick **"Dev: simulate a drive around Route A"**, choose Bus 1 and Route A, press **START TRIP**.
3. Open **http://localhost:5174** in another tab or window. The bus moves along the route, with its status, "last updated" time and next stop.
4. Press **END TRIP**: the bus becomes "Not running".

`http://localhost:5174/?sim=1` still shows the Phase 1 fake bus without the backend.

### Use a real phone as the bus

Browsers only allow GPS on `localhost` or **https**, so for a phone use the https dev server:

```cmd
cd frontend
npm run dev:phone
```

Allow Node.js through the Windows firewall for private networks when asked. Put the phone on the same Wi-Fi, open the `https://<your-PC-IP>:5174/driver` address Vite prints (or find it with `ipconfig`), accept the self-signed certificate warning, then sign in, choose Bus 1 / Route A and press START TRIP. Allow location when asked, keep the screen on, start from DG Corner.

If the phone can't reach your PC (college Wi-Fi often isolates devices), use a tunnel instead, e.g. `cloudflared tunnel --url http://localhost:5174`, and open the https address it prints.

## Putting it online

Step by step, with the free-plan limits and what they mean for this app: [docs/deploy.md](docs/deploy.md). The files that drive it are `render.yaml` (server) and `frontend/vercel.json` (website).

## Running it in production

See [docs/operations.md](docs/operations.md): health checks, finding a request by its id, rate limits (and the campus-Wi-Fi caveat), what cleans itself up, shutdown behaviour, backups, secrets, and a "something is wrong" table. New settings are in `backend/.env.example`; the defaults work as they are.

## Accounts and sign-in

Seeded for development only (`npm run seed` creates them everywhere except `NODE_ENV=production`):

| Role | Email | Password | Page |
|---|---|---|---|
| Driver (assigned to Bus 1) | `driver@example.com` | `driver-dev-123` | `/driver` |
| Admin | `admin@example.com` | `admin-dev-123` | `/admin` |

Create a real account (the password is typed at a hidden prompt, so it never lands in your shell history):

```cmd
cd backend
npm run create-user -- --email ravi@example.com --name "Ravi Kumar" --role DRIVER --bus bus-1
```

Running it again for the same email resets that person's password. Students need no account.

How sign-in works: a short-lived (15 min) access token lives in the page's memory only; a 7-day refresh token lives in an httpOnly cookie the page's JavaScript cannot read, and is replaced every time it is used. Reloading the page signs you back in from the cookie. Disabling a user (`UPDATE users SET active = false ...`) locks them out on their next request.

**Production needs `JWT_SECRET`** (32+ random characters); the server refuses to start without it:
`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`

## Admin dashboard

Sign in at **/admin** (`admin@example.com` / `admin-dev-123` in development).

| Page | What it does |
|---|---|
| Overview | Buses reporting, trips in progress, drivers online, students connected, fixes per hour. Each bus shows status, driver, speed, how old its last fix is, and GPS health over the last 5 minutes (flagged when inaccurate, sparse, or off the route). Refreshes every 5 s. "End trip" for a driver whose phone died. Recent changes. |
| Buses | Add, rename, set the registration number, disable or enable, delete. |
| Accounts | Create drivers and admins (a password is generated and shown **once**), reset a password, disable or enable, assign buses to a driver, delete. |
| Stops | Add and move stops by clicking the map. Which routes a stop is on is worked out for you. |
| Routes | Paste a path, **Preview** it on the map (length, which stops it passes and where, warnings), then save. |
| Trips | History with filters, then per trip: map trail, distance, average and top speed, GPS dropouts, accuracy. |

**Adding or changing a route:** trace it on geojson.io and paste the GeoJSON (it is converted from longitude-latitude for you), or paste a plain list of `[latitude, longitude]` pairs. Save is only enabled after a preview of exactly what is in the box. If the preview says no stop is within 15 m, the coordinates are probably swapped; the numbers alone can't reveal that for Varanasi, so the preview map and that warning are the check.

Rules the server enforces: a trip can't be running when you change a route's path, switch the route off, or disable a bus; you can't disable, demote or delete your own account; a bus, route, or account with trip history is disabled instead of deleted. Every change is recorded in the audit log.

## Updating from an older copy

Phases 6 to 9 add database migrations (route progress per fix; accounts, bus assignments and refresh tokens; the audit log; why each trip ended). After copying the new files:

```cmd
cd backend
npm install
npm run migrate
```

Also run `npm run seed` once. It upgrades the old dev driver (which had a placeholder password) to the sign-in above and assigns it to Bus 1; it never overwrites a password that was changed. Then restart `npm run dev`. New optional settings (`ETA_DWELL_SECONDS`, `ETA_DEFAULT_SPEED_MPS`, `ROUTE_OFF_ROUTE_M`) are in `.env.example`; the defaults work without them.

## Tests

Backend tests that need Redis are skipped unless you set `TEST_REDIS_URL` (CMD: `set TEST_REDIS_URL=redis://localhost:6379` then `npm test`). All other tests need only Postgres.

```cmd
cd backend
npm test            (needs the bustracker_test database; see Troubleshooting)
npm run smoke       (needs the backend running on port 3001)

cd ..\frontend
npm test
```

## Troubleshooting

- **Port 5173 in use** by Keera's Vite dev server: this project is intentionally pinned to **5174** instead. Do not change it.
- **Port 3000 in use** by Keera's backend: this project is intentionally pinned to **3001** instead. Do not change it.
- **Port 5432 already in use** by another project's Postgres: that's why this project uses 5433. Don't change it back.
- **Vite says "Port 5174 is already in use"**: another process grabbed 5174. Stop it first, or temporarily change `port` in `vite.config.ts` and `CORS_ORIGINS` in `backend/.env` together.
- **`npm test` can't find `bustracker_test`** (it's only created the first time the Postgres volume is made):
  `docker compose exec postgres psql -U bus -d bustracker -c "CREATE DATABASE bustracker_test;"`
- **GPS says "permission denied"**: allow location for the site in the browser's site settings, then tap *Retry GPS*.
- **Bus shows "Connection lost"**: the student page stopped getting answers from the API (backend stopped, or no network).

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | 503 if the DB is unreachable |
| GET | `/routes`, `/routes/:id` | `:id` includes points + every stop pass |
| GET | `/stops`, `/landmarks` | |
| GET | `/buses`, `/buses/:id/location` | status + last fix + `progress` (position on the route, next stop, per-stop ETAs); location and progress are hidden when the bus isn't operating, progress also when the bus has gone quiet |
| GET | `/stops/:id/arrivals` | buses heading to this stop, soonest first: ETA, distance, direction, "just passed" |
| GET | `/config` | status thresholds the page uses to age a silent bus |
| POST | `/auth/login`, `/auth/refresh`, `/auth/logout` | sign-in; refresh and logout use the httpOnly cookie and need the `X-Requested-With` header |
| GET | `/auth/me` | the signed-in user and their assigned buses |
| GET | `/trips/active` | driver |
| GET | `/admin/overview` | admin: headline numbers, per-bus status and GPS health, trips in progress, recent changes |
| GET/POST/PATCH/DELETE | `/admin/buses[/:id]` | admin: add, edit, disable (blocked mid-trip), delete (blocked if it has trip history) |
| GET/POST/PATCH/DELETE | `/admin/users[/:id]`, `PUT /admin/users/:id/buses` | admin: accounts, password reset, bus assignment |
| GET/POST/PATCH/DELETE | `/admin/stops[/:id]` | admin: a stop on a route's line becomes part of that route automatically |
| GET/POST/PUT/DELETE | `/admin/routes[/:id]`, `POST /admin/routes/preview` | admin: paths from pasted points; preview is a dry run |
| GET | `/admin/trips[?status&busId&before&limit]`, `/admin/trips/:id` | admin: history, trail on a map, distance, speeds, GPS dropouts |
| POST | `/admin/trips/:id/end` | admin: end a trip whose driver vanished |
| GET | `/admin/audit` | admin: who changed what |
| POST | `/trips/start`, `/trips/end` | driver |
| POST | `/location` | driver; `ts` is epoch **milliseconds**; the bus comes from the active trip |

Errors look like `{ "error": { "code", "message" } }`. Bus status: `LIVE` (<15 s), `DELAYED` (<2 min), `POSSIBLY_OFFLINE` (<10 min), `OFFLINE`, `LOCATION_UNAVAILABLE`, `NOT_OPERATING`, `DISABLED`. Thresholds are env vars, measured against server receive time.

## How the ETA works

For every fix the server works out how far along the route loop the bus is (`s`, metres), using the previous position to tell the outbound and return legs apart. The ETA to a stop is:

```
ETA = distance to the stop / the bus's cruising speed  +  dwell x (stops passed on the way)
```

The cruising speed is smoothed from the phone's reading (or from progress between fixes) and ignores time spent stopped; dwell is `ETA_DWELL_SECONDS` per stop. No ETA is given while the bus is off its route or has gone quiet. A stop the bus has just passed says so and shows the next arrival (on the return leg). Nothing is learned from history yet; that is the next improvement, and the stored progress per fix is what it will use.

## Not done yet (by design)

- ETA from historical trip times (the data is now being stored per fix).
- A change-password screen for drivers (an admin resets passwords for now).
- Deployment itself (Phase 10) and a measured load test (Phase 11).
- Editing a route's path point by point on the map (you paste the points instead).
- Admin dashboard, rate limiting, auto-closing abandoned trips (Phases 8-9).

Design decisions are in [docs/decisions.md](docs/decisions.md).
