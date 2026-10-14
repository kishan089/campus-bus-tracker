import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { loadConfig, loadToolConfig } from "../src/config";
import { createPool } from "../src/db";
import type { Deps } from "../src/deps";
import { startJanitor } from "../src/jobs/janitor";
import { createLogger } from "../src/logger";
import { markActivity } from "../src/services/activity";
import { bearer, DEV_ADMIN, DEV_DRIVER, loginToken } from "./helpers";

const config = loadConfig();
const log = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl, log);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const prodEnv = { NODE_ENV: "production", DATABASE_URL: config.databaseUrl, JWT_SECRET: config.auth.jwtSecret }; // the same key, so tokens made by the test app are valid in these production-configured ones

afterAll(async () => { await pool.end(); });

describe("/ping: the keep-alive target", () => {
  it("answers without touching the database, and is never rate limited or counted", async () => {
    const deadPool = { query: () => Promise.reject(new Error("database is asleep")) } as any;
    const strict = { ...config, limits: { ...config.limits, apiPerMin: 2 } };
    const deps: Deps = { pool: deadPool, config: strict, log };
    const app = createApp(deps);
    for (let i = 0; i < 10; i++) {
      const r = await request(app).get("/ping");
      expect([r.status, r.text]).toEqual([200, "ok"]);
    }
    expect((await request(app).head("/ping")).status).toBe(200);
    expect(deps.metrics!.snapshot().requests).toBe(0);
    expect((await request(app).get("/health")).status).toBe(503); // /health, in contrast, does check the database
  });
});

describe("configuration for production", () => {
  it("has no Redis unless REDIS_URL is set; development defaults to the local one", () => {
    expect(loadConfig(prodEnv).redisUrl).toBeUndefined();
    expect(loadConfig({ ...prodEnv, REDIS_URL: "rediss://default:pw@host:6379" }).redisUrl).toBe("rediss://default:pw@host:6379");
    expect(loadConfig({ NODE_ENV: "development", DATABASE_URL: "postgres://x" }).redisUrl).toBe("redis://localhost:6379");
    expect(loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://x" }).redisUrl).toBeUndefined();
  });

  it("reads how many proxies sit in front, and rejects nonsense", () => {
    expect(loadConfig(prodEnv).trustProxyHops).toBe(1);
    expect(loadConfig({ ...prodEnv, TRUST_PROXY_HOPS: "2" }).trustProxyHops).toBe(2);
    expect(() => loadConfig({ ...prodEnv, TRUST_PROXY_HOPS: "9" })).toThrow();
    expect(() => loadConfig({ ...prodEnv, TRUST_PROXY_HOPS: "-1" })).toThrow();
  });

  it("command-line tools do not need JWT_SECRET, but the server still does", () => {
    const saved = { ...process.env };
    try {
      process.env.NODE_ENV = "production"; process.env.DATABASE_URL = "postgres://x"; delete process.env.JWT_SECRET;
      expect(loadToolConfig().env).toBe("production");
      expect(() => loadConfig()).toThrow(/JWT_SECRET/);
    } finally {
      process.env = saved;
    }
  });
});

describe("running behind Vercel and Render (two proxies)", () => {
  let admin: string;
  const behind = (hops: number) => createApp({ pool, config: { ...loadConfig({ ...prodEnv, TRUST_PROXY_HOPS: String(hops) }), limits: { ...config.limits } }, log });
  beforeAll(async () => { admin = await loginToken(createApp({ pool, config, log }), DEV_ADMIN); });

  const addressSeen = async (app: ReturnType<typeof behind>, xff: string) =>
    (await request(app).get("/admin/overview").set(bearer(admin)).set("X-Forwarded-For", xff)).body.yourAddress;

  it("reports the real client address when TRUST_PROXY_HOPS matches, and the proxy's when it is too low", async () => {
    const chain = "203.0.113.7, 76.76.21.21"; // client, then Vercel's edge as Render saw it
    expect(await addressSeen(behind(2), chain)).toBe("203.0.113.7");
    expect(await addressSeen(behind(1), chain)).toBe("76.76.21.21"); // the symptom to look for: everyone shares the proxy's address
  });

  it("counts each client separately for rate limits once the hops are right", async () => {
    const app = createApp({ pool, config: { ...loadConfig({ ...prodEnv, TRUST_PROXY_HOPS: "2" }), limits: { ...config.limits, apiPerMin: 3 } }, log });
    const hit = (client: string) => request(app).get("/config").set("X-Forwarded-For", `${client}, 76.76.21.21`);
    for (let i = 0; i < 3; i++) expect((await hit("203.0.113.7")).status).toBe(200);
    expect((await hit("203.0.113.7")).status).toBe(429);
    expect((await hit("198.51.100.9")).status).toBe(200); // a different student, same Vercel edge
  });
});

describe("the janitor and a database that sleeps", () => {
  it("sweeps once at boot, then stays quiet until a driver is active, then once more after the window", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const deps: Deps = { pool: { query } as any, config: { ...config, ops: { ...config.ops, janitorIntervalS: 0.02 } }, log };
    const j = startJanitor(deps);
    await sleep(150);
    const afterBoot = query.mock.calls.length;
    expect(afterBoot).toBeGreaterThanOrEqual(1);              // the boot sweep (and the daily purge)
    await sleep(200);
    expect(query.mock.calls.length).toBe(afterBoot);          // idle: no database traffic at all

    markActivity(deps);                                        // a driver starts a trip
    await sleep(150);
    expect(query.mock.calls.length).toBeGreaterThan(afterBoot);
    const whileActive = query.mock.calls.length;

    deps.activityAt = Date.now() - (config.ops.staleTripMinutes + 2) * 60_000; // ...and then goes quiet for longer than the window
    await sleep(150);
    const afterFinal = query.mock.calls.length;
    expect(afterFinal).toBeGreaterThan(whileActive);          // one final sweep to catch anything left behind
    await sleep(200);
    expect(query.mock.calls.length).toBe(afterFinal);         // then silence again
    j.stop();
  });

  it("starting a trip and sending a fix both count as activity", async () => {
    const deps: Deps = { pool, config, log };
    const app = createApp(deps);
    const driver = await loginToken(app, DEV_DRIVER);
    await pool.query("TRUNCATE gps_locations, trips RESTART IDENTITY CASCADE");
    expect(deps.activityAt).toBeUndefined();
    await request(app).post("/trips/start").set(bearer(driver)).send({ busId: "bus-1", routeId: "route-a" });
    expect(deps.activityAt).toBeGreaterThan(0);
    deps.activityAt = 1;
    await request(app).post("/location").set(bearer(driver)).send({ lat: 25.2632, lng: 82.9876, speed: 5, accuracy: 8, ts: Date.now() });
    expect(deps.activityAt).toBeGreaterThan(1000);
    await request(app).post("/trips/end").set(bearer(driver));
  });
});
