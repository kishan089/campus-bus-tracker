# Putting it online, for ₹0

```
students' phones ──► Vercel (the website, and a proxy for /api) ──► Render (the server) ──► Neon (Postgres)
         └────────── live updates go straight to Render (WebSocket) ───────┘
UptimeRobot pings Render every 5 minutes so it doesn't fall asleep
```

Everything below was checked against the providers' pages in October 2026. Free plans change; if a number here looks different on their site, trust their site and tell me.

## What the free plans mean for this app

| | What you get | What it means here |
|---|---|---|
| **Render** (server) | A free web service sleeps after 15 minutes without an incoming request or WebSocket message. 750 free hours a month. May restart at any time. Waking takes up to about a minute. | The pinger below keeps it awake. 24 h × 31 days = 744 h, so one service fits in 750 hours; a second one would not. |
| **Neon** (database) | 100 compute-hours a month, 0.5 GB storage, and it sleeps after 5 idle minutes (this can't be turned off on free). Compute stops if the monthly hours run out. | The server is built to let it sleep: the cleanup job is quiet when no bus is running, and the keep-alive address `/ping` never touches the database. Open dashboards in a hidden tab also stop polling. Watch **Usage** in the Neon console in the first weeks. |
| **Redis** | Upstash's free tier is 500,000 commands a month. This app sends about 6 per GPS fix. | **Not used.** One server doesn't need it; leave `REDIS_URL` unset. |
| **Vercel** (website) | Hobby plan, 100 GB bandwidth a month. Its proxy carries normal requests but not WebSockets. | `/api` goes through Vercel (so the sign-in cookie belongs to your site); the live-updates socket connects to Render directly. Hobby is meant for personal, non-commercial use; check their terms. |
| **UptimeRobot** | Free monitoring with 5-minute checks. | Keeps Render awake. |

**About a card:** Render usually lets you start without one, but it sometimes asks for a card to verify the account (a small hold of about $1 that is cancelled). Indian debit cards often have *online international transactions* switched off by default; if the verification fails, open your bank's app, find card controls, and enable it (you can switch it off again afterwards). Free services are suspended, not billed, if you use up the free hours.

## 1. Put the project on GitHub

Create an empty repository on github.com (no README), then in CMD from the project folder:

```cmd
git init
git add .
git status
```

Check that no `.env` file is listed (`.gitignore` excludes them). Then:

```cmd
git commit -m "Campus bus tracker"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/campus-bus-tracker.git
git push -u origin main
```

## 2. Neon: the database

1. neon.com → create a project. Pick the **AWS Asia Pacific (Singapore)** region, next to Render's Singapore region.
2. Press **Connect**, choose the **direct** connection (not "pooled"), and copy the string. It looks like `postgresql://user:password@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`.

## 3. Create the tables and the first admin (from your PC)

CMD, in the `backend` folder. Put the whole `set` value in quotes, because passwords can contain `&` or `%`, which CMD treats specially:

```cmd
set "DATABASE_URL=postgresql://user:password@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require"
npm run migrate:prod
set NODE_ENV=production
npm run seed
npm run create-user -- --email you@gmail.com --name "Your Name" --role ADMIN
```

- `migrate:prod` creates the tables. `seed` (in production mode) adds the route, stops and landmarks and **does not** create the dev accounts.
- `create-user` asks for the password at a hidden prompt (10+ characters). This is the account you sign in to `/admin` with.
- Close that CMD window afterwards, so the database password isn't left in it.

Buses, drivers and assignments you then create in the Admin pages. (`seed` also adds "Bus 1".)

## 4. Render: the server

1. render.com → **New → Blueprint** → connect your GitHub repo. It reads `render.yaml`.
2. It asks for two values:
   - `DATABASE_URL`: the same Neon string as above.
   - `CORS_ORIGINS`: type `https://placeholder.vercel.app` for now; you'll replace it in step 6.
3. Create. The first build takes a few minutes. When it's live, copy the address (`https://campus-bus-api-xxxx.onrender.com`) and open `/ping` on it: it should say `ok`.

The start command applies any new database migrations every time the server starts, so future updates need no manual step.

## 5. Vercel: the website

1. In CMD, from `frontend`, point `vercel.json` at your server and push it:

```cmd
node scripts/configure-vercel.mjs https://campus-bus-api-xxxx.onrender.com
git add vercel.json
git commit -m "Point the website at the server"
git push
```

2. vercel.com → **Add New → Project** → import the repo → set **Root Directory** to `frontend` (framework Vite is detected) → add an environment variable:
   `VITE_SOCKET_URL` = `https://campus-bus-api-xxxx.onrender.com`
3. Deploy, and copy the site address (`https://something.vercel.app`).

## 6. Tell the server which site may call it

Render → your service → **Environment** → set `CORS_ORIGINS` to the exact Vercel address (https, no trailing slash) → Save (it redeploys).

## 7. Keep it awake

uptimerobot.com → **Add New Monitor** → HTTP(s) → URL `https://campus-bus-api-xxxx.onrender.com/ping` → interval **5 minutes** (anything under 15 works).

## 8. Check it works

- Open the Vercel address: the map loads. After a long idle it may say the server is waking up and then load by itself.
- `/admin` → sign in → **Overview** → find "Your address as the server sees it". It must be **your real public IP** (search "what is my IP"). If it shows something else, Vercel's proxy is being counted as the visitor, so all students would share one rate limit: in Render set `TRUST_PROXY_HOPS` to 1 or 2 until it matches.
- Accounts → create a driver, Buses → assign it to a bus, Routes should list Route A.
- On a phone: `https://your-site.vercel.app/driver` → sign in → Start trip. It's https, so the GPS permission just works (no certificate warning). Check the bus on the map from another device.

## Day to day

- **Updating:** `git push`. Render rebuilds and migrates; Vercel redeploys the site.
- **Rolling back:** Render and Vercel both keep previous deploys you can re-activate.
- **Logs:** Render → Logs. Find one request by its id (see `operations.md`).
- **Free-tier usage:** Neon console → Usage; Render dashboard → hours. Close admin dashboards when you're not using them (a visible tab keeps the database awake).

## If something is wrong

| Symptom | Likely cause |
|---|---|
| Site loads but buses never appear; "waking up" for over 2 minutes | Render crashed or never started: Render → Logs. Often a wrong `DATABASE_URL`. |
| Browser console shows a CORS error | `CORS_ORIGINS` doesn't exactly match the Vercel address. |
| Sign-in says "Could not sign in" or the server hit an error | Render → Logs; usually the database string or a failed migration. |
| "Connection lost" banner constantly | `VITE_SOCKET_URL` missing or wrong in Vercel (redeploy after fixing: it is baked in at build time). |
| Everyone gets 429 errors | `TRUST_PROXY_HOPS` is too low (see step 8). |
| Fine for days, then database errors mid-month | Neon's free compute-hours ran out: Usage in the Neon console. |
| Maps show grey squares | OpenStreetMap's public tile servers are for light use. For a larger audience, move to a tile provider with a free tier. |
