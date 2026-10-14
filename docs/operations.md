# Running it

What to know when the app is live. Commands are for Windows CMD unless noted.

## Is it healthy?

- `GET /health` returns `{"status":"ok","db":"up"}`. It returns **503** if the database is unreachable, and **503 `draining`** while the server is shutting down, so a load balancer stops sending it traffic.
- Admin → Overview shows: buses reporting, GPS health per bus, API latency and errors over the last 5 minutes, live WebSocket connections, database and Redis state.

## Finding out what happened to one request

Every response has an `x-request-id` header, and error bodies repeat it (`"requestId"`). When someone reports "it said error", ask for that id (or look at the browser's network tab) and search the logs for it. Logs are one JSON line per request with the method, path (no query string), status, time in ms and user id. **Headers, cookies, tokens, passwords and query strings are never logged.**

Log levels: 5xx are `error`, 4xx are `warn`, normal requests `info`; `/health` and `POST /location` (constant traffic) are `debug`. Set `LOG_LEVEL=debug` to see them.

## Errors in production

Set `SENTRY_DSN` (free Sentry project, platform "Node.js") and unexpected 5xx errors and crashes are reported, tagged with the request id. Nothing is sent without it. Request bodies, headers and cookies are never attached.

## Rate limits

| What | Default | Counted per |
|---|---|---|
| All API requests | 1200 / min | client IP |
| Sign-in and token refresh requests | 30 / min | client IP |
| Wrong passwords | 10 / 15 min | IP + account (and 30 / 15 min per account from anywhere) |
| `POST /location` | 120 / min | driver |
| Admin changes (not reads) | 120 / min | admin |

Clients over a limit get **429** with `Retry-After`. Counters live in Redis when it is up (shared by all server instances) and in memory otherwise; a Redis outage never makes requests fail.

**Campus caveat:** students on the campus Wi-Fi may all appear as one IP. That is why the general limit is high. If students report 429s, raise `RATE_LIMIT_PER_MINUTE`; do not lower the sign-in limits.

## Things the server cleans up by itself

- **Silent drivers:** a trip with no GPS fix for `STALE_TRIP_MINUTES` (30) is ended automatically at the time of its last fix, marked "automatically" in the trip history, and students' maps update. The driver's page then says the trip ended and they start a new one.
- **GPS history:** fixes older than `GPS_RETENTION_DAYS` (90) are deleted hourly in small batches. Trips and their statistics stay; only the map trail of very old trips is gone. At 2 buses, 90 days is roughly 150 MB, well inside a free database.
- **Impossible jumps:** a fix implying more than 45 m/s since the previous one is refused (422) and not stored.

## Shutting down and restarting

On SIGTERM or Ctrl+C the server marks itself draining, stops accepting connections, disconnects WebSocket clients (their pages reconnect and refetch automatically), closes Redis and the database, and exits 0. If that takes over 10 seconds it forces exit. An unexpected crash is logged, reported, and exits 1 so the host restarts it.

## Backups

- **Neon (production):** point-in-time restore is built in on the free plan (a short window; check the current length in the Neon console). Before any risky change, create a **branch** of the database from the console; it is instant and free to try things on.
- **Manual copy (works on any Postgres, and on your local Docker one):**
  `docker compose exec -T postgres pg_dump -U bus bustracker > backup.sql`
  Restore into an empty database: `docker compose exec -T postgres psql -U bus -d bustracker < backup.sql`
- What matters: `users`, `buses`, `routes`, `route_points`, `stops`, `route_stops`, `driver_buses`. Trips and GPS history are nice to keep; `refresh_tokens` can be thrown away (everyone signs in again).

## Secrets

- `JWT_SECRET`: 32+ random characters, set in the host's environment, never committed. Changing it signs every access token out within 15 minutes of the change (drivers' pages renew silently only if their refresh cookie is still valid; it is, so most won't notice).
- To sign **everyone** out now: `DELETE FROM refresh_tokens;` and change `JWT_SECRET`.
- Dev passwords exist only outside `NODE_ENV=production` (the seed skips them there). In production create the first admin with `npm run create-user -- --email you@example.com --name "Your Name" --role ADMIN`.

## When something is wrong

| Report | Look at |
|---|---|
| "The bus isn't on the map" | Overview: is there a trip in progress? Status and last fix age? "GPS health" flags (inaccurate / sparse / off route)? Driver's page open and screen on? |
| "Bus shows Offline but it's running" | The driver page must stay in the foreground with the screen on. Check the trip's GPS dropouts in Trips → Details. |
| "Driver can't start a trip" | "not assigned" → Accounts → Buses. "already has a trip" → Overview → End trip. |
| "Sign-in says wrong password" | Accounts → Reset password. Ten wrong tries blocks that person for 15 minutes. |
| Many 429s | Overview's API card; raise `RATE_LIMIT_PER_MINUTE` if it is campus NAT. |
| Slow | Overview's API card (median and 95th percentile). `statement_timeout` cancels any query over 15 s. |
