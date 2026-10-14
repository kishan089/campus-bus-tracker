import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io as connect } from "socket.io-client";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createPool } from "../src/db";
import type { Deps } from "../src/deps";
import { buildPath, pointAt } from "../src/geo/geo";
import { closeStaleTrips, purgeOldFixes, startJanitor } from "../src/jobs/janitor";
import { createShutdown } from "../src/lifecycle";
import { createLogger } from "../src/logger";
import { loadCampus } from "../src/seed/seed";
import { attachSocketServer } from "../src/websocket";
import { bearer, DEV_ADMIN, DEV_DRIVER, loginToken } from "./helpers";

const config = loadConfig();
const log = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl, log);
const emitted: any[] = [];
const deps: Deps = { pool, config, log, io: { emit: (_e: string, p: unknown) => emitted.push(p) } as any };
const app = createApp(deps);
const path = buildPath(loadCampus().routes[0].points);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let driver: string, admin: string;
const startTrip = () => request(app).post("/trips/start").set(bearer(driver)).send({ busId: "bus-1", routeId: "route-a" });
const post = (s: number, ts = Date.now(), speed = 5) => {
  const [lat, lng] = pointAt(path, s);
  return request(app).post("/location").set(bearer(driver)).send({ lat, lng, speed, accuracy: 8, ts });
};
const age = (sql: string) => pool.query(sql); // helper to backdate rows

beforeAll(async () => { driver = await loginToken(app, DEV_DRIVER); admin = await loginToken(app, DEV_ADMIN); });
beforeEach(async () => { emitted.length = 0; await pool.query("TRUNCATE gps_locations, trips RESTART IDENTITY CASCADE"); });
afterAll(async () => { await pool.end(); });

describe("closing trips whose driver went silent", () => {
  it("closes a trip with no recent fix, ends it at the last fix, and tells students", async () => {
    await startTrip(); await post(100);
    await age("UPDATE gps_locations SET received_at = now() - interval '40 minutes'");
    const closed = await closeStaleTrips(deps);
    expect(closed).toHaveLength(1);
    const t = (await pool.query("SELECT status, end_reason, extract(epoch FROM now() - ended_at) AS ago FROM trips")).rows[0];
    expect(t.status).toBe("COMPLETED");
    expect(t.end_reason).toBe("AUTO_TIMEOUT");
    expect(Number(t.ago)).toBeGreaterThan(39 * 60);           // ended when the last fix arrived, not when the janitor noticed
    expect(emitted).toContainEqual({ type: "BUS_TRIP_ENDED", busId: "bus-1" });
  });

  it("closes a trip that never sent a fix once it is old enough, using its start time", async () => {
    await startTrip();
    await age("UPDATE trips SET started_at = now() - interval '45 minutes'");
    expect(await closeStaleTrips(deps)).toHaveLength(1);
    expect((await pool.query("SELECT ended_at = started_at AS same FROM trips")).rows[0].same).toBe(true);
  });

  it("leaves trips alone that are still being heard from, or are new", async () => {
    await startTrip(); await post(100);
    await age("UPDATE gps_locations SET received_at = now() - interval '5 minutes'");
    expect(await closeStaleTrips(deps)).toHaveLength(0);
    await pool.query("UPDATE trips SET status='COMPLETED', ended_at=now(), end_reason='DRIVER'");
    await startTrip(); // no fixes yet, just started
    expect(await closeStaleTrips(deps)).toHaveLength(0);
    expect((await pool.query("SELECT status FROM trips WHERE status = 'ACTIVE'")).rows).toHaveLength(1);
  });

  it("frees the bus: the driver is told the trip is over, can start a new one, and the bus shows as not running", async () => {
    await startTrip(); await post(100);
    await age("UPDATE gps_locations SET received_at = now() - interval '40 minutes'");
    await closeStaleTrips(deps);
    expect((await request(app).get("/buses")).body[0]).toMatchObject({ status: "NOT_OPERATING", location: null });
    expect((await post(120)).body.error.code).toBe("NO_ACTIVE_TRIP");
    expect((await startTrip()).status).toBe(201);
  });

  it("records the reason in trip history, for the driver, the admin, and the janitor", async () => {
    await startTrip(); await request(app).post("/trips/end").set(bearer(driver));
    await startTrip();
    const id = (await request(app).get("/admin/trips?status=ACTIVE").set(bearer(admin))).body.trips[0].id;
    await request(app).post(`/admin/trips/${id}/end`).set(bearer(admin));
    await startTrip(); await age("UPDATE trips SET started_at = now() - interval '2 hours' WHERE status = 'ACTIVE'");
    await closeStaleTrips(deps);
    const reasons = (await request(app).get("/admin/trips").set(bearer(admin))).body.trips.map((t: any) => t.endReason);
    expect(reasons).toEqual(["AUTO_TIMEOUT", "ADMIN", "DRIVER"]);
  });

  it("when two servers run it at once, each trip is closed exactly once", async () => {
    await startTrip(); await age("UPDATE trips SET started_at = now() - interval '2 hours'");
    const [a, b] = await Promise.all([closeStaleTrips(deps), closeStaleTrips(deps)]);
    expect(a.length + b.length).toBe(1);
    expect(emitted.filter((e) => e.type === "BUS_TRIP_ENDED")).toHaveLength(1);
  });

  it("the background job does the same on its own schedule", async () => {
    await startTrip(); await age("UPDATE trips SET started_at = now() - interval '2 hours'");
    const fast = { ...deps, config: { ...config, ops: { ...config.ops, janitorIntervalS: 0.05 } } };
    const j = startJanitor(fast);
    await sleep(400);
    j.stop();
    expect((await pool.query("SELECT end_reason FROM trips")).rows[0].end_reason).toBe("AUTO_TIMEOUT");
  });
});

describe("keeping the GPS table small", () => {
  it("removes fixes older than the retention period, in batches, and keeps the rest and the trips", async () => {
    await startTrip();
    for (let i = 0; i < 5; i++) await post(100 + i * 10, Date.now() - (5 - i) * 3000);
    await age("UPDATE gps_locations SET received_at = now() - interval '100 days' WHERE id <= 3");
    const removed = await purgeOldFixes(deps, 2); // batch of 2 forces two passes
    expect(removed).toBe(3);
    expect((await pool.query("SELECT count(*)::int AS n FROM gps_locations")).rows[0].n).toBe(2);
    expect((await pool.query("SELECT count(*)::int AS n FROM trips")).rows[0].n).toBe(1);
    expect(await purgeOldFixes(deps)).toBe(0);
  });
});

describe("a GPS jump no bus could make", () => {
  const T = () => Date.now();
  it("is refused and not stored, while ordinary movement is accepted", async () => {
    await startTrip();
    const t0 = T() - 20_000;
    expect((await post(100, t0)).status).toBe(204);
    expect((await post(140, t0 + 3000)).status).toBe(204);                // 40 m in 3 s (13 m/s)
    const jump = await post(1500, t0 + 6000);                              // 1.4 km in 3 s
    expect([jump.status, jump.body.error.code]).toEqual([422, "IMPLAUSIBLE_JUMP"]);
    expect((await pool.query("SELECT count(*)::int AS n FROM gps_locations")).rows[0].n).toBe(2);
    expect((await post(180, t0 + 9000)).status).toBe(204);                 // the real bus carries on
  });

  it("does not hold a grudge: after a gap of over two minutes a far-away fix is accepted", async () => {
    await startTrip();
    const t0 = T() - 250_000;
    await post(100, t0);
    expect((await post(1500, t0 + 200_000)).status).toBe(204);             // 200 s later: 7 m/s, and outside the check window anyway
  });

  it("only applies from 100 m up, so small GPS wobble at a standstill is never refused", async () => {
    await startTrip();
    const t0 = T() - 10_000;
    await post(100, t0);
    expect((await post(160, t0 + 1000)).status).toBe(204);                 // 60 m in 1 s is odd but under the floor
  });
});

describe("WebSocket limits", () => {
  async function serve(limits: { maxConnections?: number; maxPerIp?: number }) {
    const d: Deps = { pool, config: { ...config, ws: { ...config.ws, ...limits } }, log };
    const server = createServer(createApp(d));
    d.io = attachSocketServer(server, d);
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://localhost:${(server.address() as AddressInfo).port}`;
    const client = () => connect(url, { path: "/socket.io/", transports: ["websocket"], reconnection: false });
    const stop = async () => { d.io!.close(); await new Promise((r) => server.close(r)); };
    return { client, stop, d };
  }
  const outcome = (c: ReturnType<ReturnType<typeof connect>["io"]["socket"]>) => new Promise<string>((resolve) => {
    c.on("connect", () => resolve("connected"));
    c.on("connect_error", (e: Error) => resolve(e.message));
  });

  it("caps connections per address, and frees a place when one leaves", async () => {
    const s = await serve({ maxPerIp: 2 });
    const a = s.client(), b = s.client();
    expect(await outcome(a)).toBe("connected");
    expect(await outcome(b)).toBe("connected");
    const c = s.client();
    expect(await outcome(c)).toBe("too_many_connections");
    a.close(); await sleep(100);
    const d = s.client();
    expect(await outcome(d)).toBe("connected");
    [b, c, d].forEach((x) => x.close());
    await s.stop();
  });

  it("caps connections overall", async () => {
    const s = await serve({ maxConnections: 1 });
    const a = s.client();
    expect(await outcome(a)).toBe("connected");
    expect(await outcome(s.client())).toBe("server_busy");
    a.close(); await s.stop();
  });

  it("drops a client that sends events, since the server only ever sends", async () => {
    const s = await serve({});
    const a = s.client();
    await outcome(a);
    const reason = new Promise<string>((r) => a.on("disconnect", r));
    a.emit("hello", { not: "expected" });
    expect(await reason).toBe("io server disconnect");
    await s.stop();
  });
});

describe("graceful shutdown", () => {
  it("turns /health to 503, stops listening, disconnects clients, closes the pool, then exits 0", async () => {
    const p = createPool(config.databaseUrl, log);
    const d: Deps = { pool: p, config, log };
    const server = createServer(createApp(d));
    d.io = attachSocketServer(server, d);
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://localhost:${(server.address() as AddressInfo).port}`;
    const client = connect(url, { path: "/socket.io/", transports: ["websocket"], reconnection: false });
    await new Promise<void>((r) => client.on("connect", () => r()));
    const disconnected = new Promise<string>((r) => client.on("disconnect", r));

    const exit = vi.fn(); const stopJobs = vi.fn(); const closeRedis = vi.fn();
    const shutdown = createShutdown({ deps: d, server, stopJobs, closeRedis, exit, timeoutMs: 5000 });
    const done = shutdown("SIGTERM");
    expect(d.draining).toBe(true);
    await done;
    expect(await disconnected).toBeTruthy();
    expect(server.listening).toBe(false);
    expect(stopJobs).toHaveBeenCalled(); expect(closeRedis).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
    await expect(p.query("SELECT 1")).rejects.toThrow(); // the pool was closed
    await shutdown("SIGTERM");                            // a second signal does nothing
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe("error reporting", () => {
  it("reports unexpected server errors with the request id, but not ordinary client errors", async () => {
    const reports: any[] = [];
    const reporter = { capture: (e: unknown, ctx: any) => reports.push({ message: (e as Error).message, ...ctx }) };
    const broken = createApp({ pool: { query: () => Promise.reject(new Error("weird failure")) } as any, config, log }, reporter);
    const r = await request(broken).get("/routes").set("X-Request-Id", "trace-500-abcdef");
    expect([r.status, r.body.error.code, r.body.error.requestId]).toEqual([500, "INTERNAL", "trace-500-abcdef"]);
    expect(reports).toEqual([{ message: "weird failure", requestId: "trace-500-abcdef", url: "/routes", method: "GET" }]);
    await request(broken).get("/admin/buses");   // 401
    await request(broken).get("/nope");          // 404
    expect(reports).toHaveLength(1);
  });
});
