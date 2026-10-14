import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createPool } from "../src/db";
import { createLogger } from "../src/logger";
import { bearer, loginToken } from "./helpers";

const config = loadConfig();
const log = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl, log);
const app = createApp({ pool, config, log });

let driverId: number;
let token: string;
const auth = () => bearer(token);
const fix = (o: object = {}) => ({ lat: 25.2632, lng: 82.9876, speed: 5.5, accuracy: 8, heading: 90, ts: Date.now(), ...o });
const startTrip = () => request(app).post("/trips/start").set(auth()).send({ busId: "bus-1", routeId: "route-a" });

beforeAll(async () => {
  driverId = (await pool.query("SELECT id FROM users WHERE email = 'driver@example.com'")).rows[0].id;
  token = await loginToken(app);
});
beforeEach(async () => { await pool.query("TRUNCATE gps_locations, trips RESTART IDENTITY CASCADE"); });
afterAll(async () => { await pool.end(); });

describe("catalog", () => {
  it("GET /health", async () => {
    const r = await request(app).get("/health");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ok", db: "up" });
  });

  it("GET /routes/route-a returns the geometry and every stop pass in route order", async () => {
    const r = await request(app).get("/routes/route-a");
    expect(r.status).toBe(200);
    expect(r.body.points).toHaveLength(57);
    expect(r.body.points[0]).toEqual(r.body.points[56]); // closed loop
    const ids = r.body.stops.map((s: any) => s.stopId);
    expect(ids).toEqual(["dg-corner", "cse-department", "chemical-dept", "lt1", "lt4",
                         "lt1", "chemical-dept", "cse-department"]);
    const d = r.body.stops.map((s: any) => s.distAlongRouteM);
    expect([...d].sort((a, b) => a - b)).toEqual(d);
    expect(d[d.length - 1]).toBeLessThan(r.body.totalLengthM);
  });

  it("unknown route -> 404, and stops/landmarks are listed without duplicates", async () => {
    expect((await request(app).get("/routes/nope")).status).toBe(404);
    expect((await request(app).get("/stops")).body).toHaveLength(5);
    const lm = (await request(app).get("/landmarks")).body.map((l: any) => l.id);
    expect(lm).toHaveLength(5);
    expect(lm).not.toContain("lt1");
  });
});

describe("driver session", () => {
  it("GET /auth/me identifies the driver and rejects unknown ones", async () => {
    expect((await request(app).get("/auth/me")).status).toBe(401);
    const me = await request(app).get("/auth/me").set(auth());
    expect(me.body).toMatchObject({ id: driverId, name: "Dev Driver", role: "DRIVER", buses: [{ id: "bus-1", name: "Bus 1" }] });
  });

  it("GET /trips/active lets a refreshed page recover the running trip", async () => {
    expect((await request(app).get("/trips/active").set(auth())).body).toEqual({ trip: null });
    await startTrip();
    const active = await request(app).get("/trips/active").set(auth());
    expect(active.body.trip).toMatchObject({ busId: "bus-1", routeId: "route-a" });
    await request(app).post("/trips/end").set(auth());
    expect((await request(app).get("/trips/active").set(auth())).body).toEqual({ trip: null });
  });
});

describe("trips and location", () => {
  it("a bus with no trip is NOT_OPERATING with no location", async () => {
    const bus = (await request(app).get("/buses")).body[0];
    expect(bus).toMatchObject({ id: "bus-1", status: "NOT_OPERATING", location: null, tripId: null });
  });

  it("requires a known driver", async () => {
    const noAuth = await request(app).post("/trips/start").send({ busId: "bus-1", routeId: "route-a" });
    expect(noAuth.status).toBe(401);
    const bad = await request(app).post("/trips/start").set({ Authorization: "Bearer not-a-token" }).send({});
    expect(bad.status).toBe(401);
  });

  it("start trip -> LOCATION_UNAVAILABLE until the first fix, then LIVE", async () => {
    const start = await startTrip();
    expect(start.status).toBe(201);
    expect(start.body).toMatchObject({ busId: "bus-1", routeId: "route-a", status: "ACTIVE" });

    expect((await request(app).get("/buses")).body[0].status).toBe("LOCATION_UNAVAILABLE");

    const post = await request(app).post("/location").set(auth()).send(fix());
    expect(post.status).toBe(204);

    const bus = (await request(app).get("/buses")).body[0];
    expect(bus.status).toBe("LIVE");
    expect(bus.location).toMatchObject({ lat: 25.2632, lng: 82.9876, accuracy: 8 });
    const one = await request(app).get("/buses/bus-1/location");
    expect(one.body.location.lat).toBe(25.2632);
    expect((await pool.query("SELECT count(*)::int AS n FROM gps_locations")).rows[0].n).toBe(1);
  });

  it("status degrades with age and never shows an old fix as live", async () => {
    await startTrip();
    await request(app).post("/location").set(auth()).send(fix());
    await pool.query("UPDATE gps_locations SET received_at = now() - interval '30 seconds'");
    let bus = (await request(app).get("/buses")).body[0];
    expect(bus.status).toBe("DELAYED");
    expect(bus.location.ageSeconds).toBeGreaterThanOrEqual(30);
    await pool.query("UPDATE gps_locations SET received_at = now() - interval '11 minutes'");
    bus = (await request(app).get("/buses")).body[0];
    expect(bus.status).toBe("OFFLINE");
  });

  it("rejects a second trip on the same bus, and a second trip for the same driver", async () => {
    await startTrip();
    const again = await startTrip();
    expect(again.status).toBe(409);
    expect(again.body.error.code).toMatch(/BUS_ALREADY_ACTIVE|DRIVER_HAS_ACTIVE_TRIP/);
    const unknownBus = await request(app).post("/trips/start").set(auth()).send({ busId: "bus-9", routeId: "route-a" });
    expect(unknownBus.status).toBe(404);
  });

  it("validates GPS input", async () => {
    await startTrip();
    const send = (body: object) => request(app).post("/location").set(auth()).send(body);
    expect((await send(fix({ lat: 91 }))).status).toBe(400);
    expect((await send(fix({ lng: "x" }))).status).toBe(400);
    expect((await send({ lat: 25 })).body.error.code).toBe("VALIDATION_ERROR");
    const future = await send(fix({ ts: Date.now() + 120_000 }));
    expect([future.status, future.body.error.code]).toEqual([422, "INVALID_TIMESTAMP"]);
    const old = await send(fix({ ts: Date.now() - 3_600_000 }));
    expect(old.body.error.code).toBe("INVALID_TIMESTAMP");
    const poor = await send(fix({ accuracy: 500 }));
    expect([poor.status, poor.body.error.code]).toEqual([422, "ACCURACY_TOO_LOW"]);
    expect((await pool.query("SELECT count(*)::int AS n FROM gps_locations")).rows[0].n).toBe(0);
  });

  it("ignores a busId in the body: the bus comes from the driver's active trip", async () => {
    await startTrip();
    await request(app).post("/location").set(auth()).send({ ...fix(), busId: "bus-2" });
    expect((await pool.query("SELECT bus_id FROM gps_locations")).rows[0].bus_id).toBe("bus-1");
  });

  it("rejects locations with no active trip and malformed JSON", async () => {
    const noTrip = await request(app).post("/location").set(auth()).send(fix());
    expect([noTrip.status, noTrip.body.error.code]).toEqual([409, "NO_ACTIVE_TRIP"]);
    const bad = await request(app).post("/location").set(auth()).set("content-type", "application/json").send("{oops");
    expect(bad.status).toBe(400);
  });

  it("end trip -> NOT_OPERATING, location hidden, history kept, more fixes rejected", async () => {
    await startTrip();
    await request(app).post("/location").set(auth()).send(fix());
    const end = await request(app).post("/trips/end").set(auth());
    expect(end.status).toBe(200);
    const bus = (await request(app).get("/buses")).body[0];
    expect(bus).toMatchObject({ status: "NOT_OPERATING", location: null });
    expect(bus.lastSeenAt).not.toBeNull();
    expect((await request(app).post("/location").set(auth()).send(fix())).status).toBe(409);
    expect((await request(app).post("/trips/end").set(auth())).status).toBe(404);
    expect((await pool.query("SELECT count(*)::int AS n FROM gps_locations")).rows[0].n).toBe(1);
  });

  it("a new trip does not inherit the previous trip's last fix", async () => {
    await startTrip();
    await request(app).post("/location").set(auth()).send(fix());
    await request(app).post("/trips/end").set(auth());
    await startTrip();
    expect((await request(app).get("/buses")).body[0].status).toBe("LOCATION_UNAVAILABLE");
  });
});
