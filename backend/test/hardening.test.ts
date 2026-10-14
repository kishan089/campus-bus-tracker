import pino from "pino";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createPool } from "../src/db";
import { createLogger } from "../src/logger";
import { Metrics } from "../src/observability/metrics";
import { createRedisClient } from "../src/redis";
import { MemoryStore, RateLimiter, RedisStore } from "../src/security/rateLimit";
import { pointAt, buildPath } from "../src/geo/geo";
import { loadCampus } from "../src/seed/seed";
import { bearer, DEV_ADMIN, DEV_DRIVER, loginToken } from "./helpers";

const config = loadConfig();
const log = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl, log);
const withLimits = (limits: Partial<typeof config.limits>) => createApp({ pool, config: { ...config, limits: { ...config.limits, ...limits } }, log });
const app = createApp({ pool, config, log });
const REDIS_URL = process.env.TEST_REDIS_URL;
const path = buildPath(loadCampus().routes[0].points);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let admin: string, driver: string;
beforeAll(async () => { admin = await loginToken(app, DEV_ADMIN); driver = await loginToken(app, DEV_DRIVER); });
beforeEach(async () => { await pool.query("TRUNCATE gps_locations, trips RESTART IDENTITY CASCADE"); });
afterAll(async () => { await pool.end(); });

describe("rate limit stores", () => {
  it("MemoryStore counts per key and starts a new window when the old one ends", async () => {
    let now = 1000;
    const s = new MemoryStore(() => now);
    expect((await s.incr("a", 1000)).count).toBe(1);
    expect((await s.incr("a", 1000)).count).toBe(2);
    expect((await s.incr("b", 1000)).count).toBe(1);
    expect((await s.get("a"))?.resetMs).toBe(1000);
    now += 1001;
    expect(await s.get("a")).toBeNull();
    expect((await s.incr("a", 1000)).count).toBe(1);
    await s.del("a");
    expect(await s.get("a")).toBeNull();
  });

  it("RateLimiter falls back to memory when Redis fails or is down, instead of failing requests", async () => {
    const broken = { status: "ready", incr: () => Promise.reject(new Error("boom")), get: () => Promise.reject(new Error("boom")), del: () => Promise.reject(new Error("boom")), pttl: () => Promise.reject(new Error("boom")) } as any;
    const a = new RateLimiter(broken);
    expect((await a.incr("k", 1000)).count).toBe(1);
    expect((await a.incr("k", 1000)).count).toBe(2);
    expect((await a.get("k"))?.count).toBe(2);
    const down = new RateLimiter({ status: "end" } as any);
    expect((await down.incr("k", 1000)).count).toBe(1);
  });

  it.skipIf(!REDIS_URL)("RedisStore is shared between instances, sets an expiry, and repairs a key that has none", async () => {
    const redis = createRedisClient(REDIS_URL!, log);
    await redis.connect();
    try {
      const a = new RateLimiter(redis), b = new RateLimiter(redis); // two "server instances"
      await a.del("t1"); await a.del("t2");
      await a.incr("t1", 5000); await b.incr("t1", 5000);
      expect((await a.get("t1"))?.count).toBe(2);
      expect((await b.get("t1"))!.resetMs).toBeLessThanOrEqual(5000);
      await redis.set("rl:t2", "7"); // a counter left behind with no expiry
      const hit = await new RedisStore(redis).incr("t2", 5000);
      expect(hit.count).toBe(8);
      expect(await redis.pttl("rl:t2")).toBeGreaterThan(0);
      await a.del("t1"); await a.del("t2");
    } finally { redis.disconnect(); }
  });
});

describe("rate limits on the API", () => {
  it("caps requests per client address, with standard headers, and never limits /health", async () => {
    const a = withLimits({ apiPerMin: 5 });
    for (let i = 1; i <= 5; i++) {
      const r = await request(a).get("/config");
      expect(r.status).toBe(200);
      expect(r.headers["ratelimit-limit"]).toBe("5");
      expect(r.headers["ratelimit-remaining"]).toBe(String(5 - i));
    }
    const blocked = await request(a).get("/config");
    expect([blocked.status, blocked.body.error.code]).toEqual([429, "RATE_LIMITED"]);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect((await request(a).get("/health")).status).toBe(200);
  });

  it("caps sign-in requests per address whatever their outcome (separate from the failed-password counter)", async () => {
    const a = withLimits({ loginPerMin: 3 });
    for (let i = 0; i < 3; i++) expect((await request(a).post("/auth/login").send(DEV_DRIVER)).status).toBe(200);
    const r = await request(a).post("/auth/login").send(DEV_DRIVER);
    expect([r.status, r.body.error.code]).toEqual([429, "RATE_LIMITED"]);
  });

  it("caps location posts per driver", async () => {
    const a = withLimits({ locationPerMin: 3 });
    const tok = await loginToken(a);
    await request(a).post("/trips/start").set(bearer(tok)).send({ busId: "bus-1", routeId: "route-a" });
    const post = () => { const [lat, lng] = pointAt(path, 100); return request(a).post("/location").set(bearer(tok)).send({ lat, lng, speed: 5, accuracy: 8, ts: Date.now() }); };
    for (let i = 0; i < 3; i++) expect((await post()).status).toBe(204);
    const r = await post();
    expect([r.status, r.body.error.code]).toEqual([429, "RATE_LIMITED"]);
    expect((await request(a).get("/trips/active").set(bearer(tok))).status).toBe(200); // only /location is capped
  });

  it("caps admin changes per admin, but not reads", async () => {
    const a = withLimits({ adminPerMin: 2 });
    const tok = await loginToken(a, DEV_ADMIN);
    for (let i = 0; i < 2; i++) expect((await request(a).patch("/admin/buses/bus-1").set(bearer(tok)).send({ name: "Bus 1" })).status).toBe(200);
    expect((await request(a).patch("/admin/buses/bus-1").set(bearer(tok)).send({ name: "Bus 1" })).status).toBe(429);
    for (let i = 0; i < 5; i++) expect((await request(a).get("/admin/buses").set(bearer(tok))).status).toBe(200);
  });
});

describe("headers, request ids and logs", () => {
  it("sends security headers and no server fingerprint", async () => {
    const r = await request(app).get("/config");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["strict-transport-security"]).toBeTruthy();
    expect(r.headers["x-frame-options"]).toBeTruthy();
    expect(r.headers["x-powered-by"]).toBeUndefined();
  });

  it("gives every response a request id, reuses a sane incoming one, and repeats it in error bodies", async () => {
    const generated = await request(app).get("/config");
    expect(generated.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const echoed = await request(app).get("/config").set("X-Request-Id", "client-trace-12345");
    expect(echoed.headers["x-request-id"]).toBe("client-trace-12345");
    const hostile = await request(app).get("/config").set("X-Request-Id", "bad id with spaces\tand junk");
    expect(hostile.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const err = await request(app).get("/admin/buses").set("X-Request-Id", "trace-for-401-abc");
    expect(err.status).toBe(401);
    expect(err.body.error.requestId).toBe("trace-for-401-abc");
    expect((await request(app).get("/nope")).body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("never writes tokens, cookies or query strings to the logs", async () => {
    const lines: string[] = [];
    const logger = pino({ level: "info" }, { write: (s: string) => { lines.push(s); } });
    const a = createApp({ pool, config, log: logger });
    await request(a).get("/buses?secretquery=hunter2").set("Authorization", "Bearer super-secret-token-123").set("Cookie", "refresh_token=cookie-secret-456");
    await request(a).post("/auth/login").send({ email: DEV_DRIVER.email, password: "a-very-wrong-password" });
    const all = lines.join("\n");
    expect(all).not.toContain("super-secret-token-123");
    expect(all).not.toContain("cookie-secret-456");
    expect(all).not.toContain("hunter2");
    expect(all).not.toContain("a-very-wrong-password");
    const entry = lines.map((l) => JSON.parse(l)).find((l) => l.req?.url === "/buses");
    expect(entry).toMatchObject({ req: { method: "GET", url: "/buses" }, res: { statusCode: 200 } });
    expect(entry.req.id).toBeTruthy();
    expect(typeof entry.responseTime).toBe("number");
    const warn = lines.map((l) => JSON.parse(l)).find((l) => l.req?.url === "/auth/login");
    expect(warn.level).toBe(40); // a 401 is logged at warn
  });
});

describe("input hardening", () => {
  it.each([
    ["get", "/admin/trips/abc"], ["get", "/admin/trips/0"], ["post", "/admin/trips/abc/end"],
    ["patch", "/admin/users/abc"], ["delete", "/admin/users/-1"], ["put", "/admin/users/abc/buses"],
  ])("%s %s is a 400 for the admin, not a database error", async (method, p) => {
    const r = await (request(app) as any)[method](p).set(bearer(admin)).send({});
    expect([r.status, r.body.error.code]).toEqual([400, "INVALID_ID"]);
  });

  it("admin routes accept a large path (3000 points), other endpoints stay small", async () => {
    const big = Array.from({ length: 3000 }, (_, i) => [25.26 + (i % 50) * 0.00001, 82.99 + i * 0.000001]);
    const ok = await request(app).post("/admin/routes/preview").set(bearer(admin)).send({ points: big });
    expect(ok.status).toBe(200);
    expect(ok.body.pointCount).toBe(3000);
    const tooBig = await request(app).post("/auth/login").send({ email: "a@b.co", password: "x".repeat(20_000) });
    expect([tooBig.status, tooBig.body.error.code]).toEqual([400, "MALFORMED_BODY"]);
  });
});

describe("metrics", () => {
  it("computes percentiles over a window and ignores old samples", () => {
    const m = new Metrics();
    const t0 = 1_000_000;
    for (let i = 1; i <= 100; i++) m.record(200, i, t0 + i);       // 1..100 ms
    m.record(500, 5, t0 + 200); m.record(404, 5, t0 + 201);
    m.record(200, 9999, t0 - 10 * 60_000);                          // too old to count
    m.rateLimited(t0 + 300);
    const s = m.snapshot(5 * 60_000, t0 + 1000);
    expect(s).toMatchObject({ requests: 102, serverErrors: 1, clientErrors: 1, rateLimited: 1 });
    // 102 samples: 1..100 plus two of 5 ms; nearest-rank percentiles
    expect(s.p50Ms).toBe(49);
    expect(s.p95Ms).toBe(95);
    expect(s.p99Ms).toBe(99);
  });

  it("the admin overview reports API health, and polling itself is not counted", async () => {
    const metrics = new Metrics(); // one set of numbers shared by a strict app and an open one
    const strict = createApp({ pool, config: { ...config, limits: { ...config.limits, apiPerMin: 2 } }, log, metrics });
    const open = createApp({ pool, config, log, metrics });
    const tok = await loginToken(open, DEV_ADMIN);
    for (let i = 0; i < 3; i++) await request(strict).get("/config"); // the third is limited
    await sleep(20);
    const first = (await request(open).get("/admin/overview").set(bearer(tok))).body.system.api;
    await request(open).get("/admin/overview").set(bearer(tok));
    const second = (await request(open).get("/admin/overview").set(bearer(tok))).body.system.api;
    expect(first.requests).toBeGreaterThanOrEqual(4); // the sign-in and three /config calls
    expect(first.rateLimited).toBe(1);
    expect(first.clientErrors + first.serverErrors).toBe(0); // a 429 is counted as limited, not as a client error
    expect(second.requests).toBe(first.requests);        // overview polls don't add to the numbers
    expect(first.p95Ms).toBeGreaterThanOrEqual(0);
    expect((await request(open).get("/admin/overview").set(bearer(tok))).body.system.wsConnections).toBe(0);
  });
});

describe("shutdown", () => {
  it("/health turns 503 while draining so a load balancer stops sending traffic", async () => {
    const deps = { pool, config, log } as any;
    const a = createApp(deps);
    expect((await request(a).get("/health")).status).toBe(200);
    deps.draining = true;
    const r = await request(a).get("/health");
    expect([r.status, r.body.status]).toEqual([503, "draining"]);
  });
});
