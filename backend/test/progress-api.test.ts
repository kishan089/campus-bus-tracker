import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createPool } from "../src/db";
import { buildPath, pointAt } from "../src/geo/geo";
import { createLogger } from "../src/logger";
import { loadCampus } from "../src/seed/seed";
import { bearer, loginToken } from "./helpers";

const config = loadConfig();
const log = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl, log);
const app = createApp({ pool, config, log });
const path = buildPath(loadCampus().routes[0].points);

let token: string;
const auth = () => bearer(token);
const startTrip = () => request(app).post("/trips/start").set(auth()).send({ busId: "bus-1", routeId: "route-a" });

/** Drive to progress `to` metres in `n` fixes, 3 s apart ending now, at the reported speed. */
async function driveTo(to: number, n = 10, speed = 6, from = 0) {
  for (let i = 1; i <= n; i++) {
    const [lat, lng] = pointAt(path, from + ((to - from) * i) / n);
    const res = await request(app).post("/location").set(auth())
      .send({ lat, lng, speed, accuracy: 8, ts: Date.now() - (n - i) * 3000 });
    expect(res.status).toBe(204);
  }
}
const bus = async () => (await request(app).get("/buses")).body[0];

beforeAll(async () => {
  token = await loginToken(app);
});
beforeEach(async () => { await pool.query("TRUNCATE gps_locations, trips RESTART IDENTITY CASCADE"); });
afterAll(async () => { await pool.end(); });

describe("route progress and ETA over the API", () => {
  it("stores progress with each fix and serves position, next stop and per-stop ETAs", async () => {
    await startTrip();
    await driveTo(700);
    const b = await bus();
    expect(b.status).toBe("LIVE");
    expect(b.progress.onRoute).toBe(true);
    expect(b.progress.s).toBeGreaterThan(690);
    expect(b.progress.s).toBeLessThan(710);
    expect(b.progress.next).toMatchObject({ stopId: "cse-department", headingTo: "LT4" });
    expect(Object.keys(b.progress.etas).sort()).toEqual(["chemical-dept", "cse-department", "dg-corner", "lt1", "lt4"]);
    expect(b.progress.speedEstMps).toBeGreaterThan(5);
    expect(b.progress.speedEstMps).toBeLessThan(6.1);
    expect(b.progress.position).toMatchObject({ lat: expect.any(Number), lng: expect.any(Number) });

    const row = (await pool.query("SELECT route_progress_m, off_route_m, speed_est_mps FROM gps_locations ORDER BY id DESC LIMIT 1")).rows[0];
    expect(row.route_progress_m).toBeGreaterThan(690);
    expect(row.off_route_m).toBeLessThan(5);
  });

  it("GET /stops/:id/arrivals lists approaching buses, soonest first, with dwell included", async () => {
    await startTrip();
    await driveTo(500);
    const r = await request(app).get("/stops/lt1/arrivals");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stopId: "lt1", stopName: "LT1" });
    const a = r.body.arrivals[0];
    expect(a).toMatchObject({ busId: "bus-1", status: "LIVE", justPassed: false, headingTo: "LT4" });
    expect(a.metres).toBeGreaterThan(700);
    expect(a.metres).toBeLessThan(760);
    // 2 stops (CSE, Chemical) lie between: ETA = metres / speed + 2 x 20 s
    expect(a.etaSeconds).toBeGreaterThan(a.metres / 6.1 + 38 - 6);
    expect(a.etaSeconds).toBeLessThan(a.metres / 5 + 42);
  });

  it("recognises a stop that was just passed and reports the next pass on the return leg", async () => {
    await startTrip();
    await driveTo(800); // CSE pass 1 is at 783 m
    const a = (await request(app).get("/stops/cse-department/arrivals")).body.arrivals[0];
    expect(a.justPassed).toBe(true);
    expect(a.behindM).toBeLessThan(40);
    expect(a.headingTo).toBe("DG CORNER");
    expect(a.metres).toBeGreaterThan(2000);
  });

  it("unknown stop -> 404; no running bus -> empty list", async () => {
    expect((await request(app).get("/stops/nope/arrivals")).status).toBe(404);
    expect((await request(app).get("/stops/lt1/arrivals")).body.arrivals).toEqual([]);
    expect((await bus()).progress).toBeNull();
  });

  it("gives no ETA from a bus that has gone quiet", async () => {
    await startTrip();
    await driveTo(500);
    await pool.query("UPDATE gps_locations SET received_at = now() - interval '3 minutes'");
    const b = await bus();
    expect(b.status).toBe("POSSIBLY_OFFLINE");
    expect(b.progress).toBeNull();
    expect((await request(app).get("/stops/lt1/arrivals")).body.arrivals).toEqual([]);
  });

  it("a new trip starts from DG Corner and does not inherit the old trip's progress", async () => {
    await startTrip();
    await driveTo(1500, 20); // 75 m per fix: fast, but a bus
    await request(app).post("/trips/end").set(auth());
    await startTrip();
    await driveTo(40, 2, 6, 10);
    const b = await bus();
    expect(b.progress.s).toBeLessThan(60);
    expect(b.progress.next.stopId).toBe("cse-department");
  });

  it("a fix far from the route is accepted and shown, but gets no ETA", async () => {
    await startTrip();
    const res = await request(app).post("/location").set(auth()).send({ lat: 25.31, lng: 83.05, speed: 5, accuracy: 8, ts: Date.now() });
    expect(res.status).toBe(204);
    const b = await bus();
    expect(b.location).toMatchObject({ lat: 25.31 });
    expect(b.progress).toMatchObject({ onRoute: false, next: null, etas: {}, position: null });
  });

  it("still stores the fix if the route cannot be loaded", async () => {
    const broken = createApp({ pool, config, log, routes: { get: () => Promise.reject(new Error("db hiccup")) } as any });
    await startTrip();
    const [lat, lng] = pointAt(path, 100);
    const res = await request(broken).post("/location").set(auth()).send({ lat, lng, speed: 5, accuracy: 8, ts: Date.now() });
    expect(res.status).toBe(204);
    const row = (await pool.query("SELECT route_progress_m FROM gps_locations")).rows[0];
    expect(row.route_progress_m).toBeNull();
    expect((await request(broken).get("/buses")).body[0].progress).toBeNull();
  });
});
