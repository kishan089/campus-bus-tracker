import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createPool } from "../src/db";
import { buildPath, pointAt } from "../src/geo/geo";
import { createLogger } from "../src/logger";
import { loadCampus } from "../src/seed/seed";
import { bearer, DEV_ADMIN, DEV_DRIVER, loginToken } from "./helpers";

const config = loadConfig();
const log = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl, log);
const app = createApp({ pool, config, log });
const campus = loadCampus();
const path = buildPath(campus.routes[0].points);

let admin: string, driver: string, adminId: number;
const A = () => bearer(admin);
const get = (p: string) => request(app).get(p).set(A());
const post = (p: string, body?: object) => request(app).post(p).set(A()).send(body);
const patch = (p: string, body: object) => request(app).patch(p).set(A()).send(body);
const put = (p: string, body: object) => request(app).put(p).set(A()).send(body);
const del = (p: string) => request(app).delete(p).set(A());

async function cleanup() {
  await pool.query("TRUNCATE gps_locations, trips RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM users WHERE email LIKE 'test-%@example.com'");
  await pool.query("DELETE FROM buses WHERE id LIKE 'test-%'");
  await pool.query("DELETE FROM route_stops WHERE stop_id LIKE 'test-%' OR route_id LIKE 'test-%'");
  await pool.query("DELETE FROM routes WHERE id LIKE 'test-%'");
  await pool.query("DELETE FROM stops WHERE id LIKE 'test-%'");
  await pool.query("DELETE FROM refresh_tokens");
  await pool.query("UPDATE users SET active = true, role = 'DRIVER' WHERE email = 'driver@example.com'");
  await pool.query("UPDATE buses SET active = true WHERE id = 'bus-1'");
  await pool.query("INSERT INTO driver_buses SELECT id, 'bus-1' FROM users WHERE email = 'driver@example.com' ON CONFLICT DO NOTHING");
  // put route-a back exactly as seeded
  await request(app).put("/admin/routes/route-a").set(bearer(admin)).send({ points: campus.routes[0].points, active: true });
  await pool.query("DELETE FROM audit_log"); // last, so the reset above leaves no trace
}

beforeAll(async () => {
  admin = await loginToken(app, DEV_ADMIN);
  driver = await loginToken(app, DEV_DRIVER);
  adminId = (await pool.query("SELECT id FROM users WHERE email = 'admin@example.com'")).rows[0].id;
  await cleanup();
});
beforeEach(cleanup);
afterAll(async () => { await cleanup(); await pool.end(); });

describe("access", () => {
  const endpoints: [string, string][] = [
    ["get", "/admin/overview"], ["get", "/admin/buses"], ["post", "/admin/buses"], ["get", "/admin/users"], ["post", "/admin/users"],
    ["get", "/admin/stops"], ["post", "/admin/stops"], ["get", "/admin/routes"], ["post", "/admin/routes/preview"],
    ["put", "/admin/routes/route-a"], ["get", "/admin/trips"], ["post", "/admin/trips/1/end"], ["get", "/admin/audit"],
    ["patch", "/admin/users/1"], ["delete", "/admin/buses/bus-1"],
  ];
  it.each(endpoints)("%s %s needs an admin: no token 401, driver 403", async (method, p) => {
    expect((await (request(app) as any)[method](p).send({})).status).toBe(401);
    expect((await (request(app) as any)[method](p).set(bearer(driver)).send({})).status).toBe(403);
  });
});

describe("buses", () => {
  it("creates a bus with a readable id, lists it, edits it, and refuses duplicates", async () => {
    const c = await post("/admin/buses", { name: "Night Shuttle", registrationNumber: "UP65 AB 1234" });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ id: "night-shuttle", name: "Night Shuttle", registrationNumber: "UP65 AB 1234", active: true, drivers: [] });
    const again = await post("/admin/buses", { name: "Night Shuttle" });
    expect(again.body.id).toBe("night-shuttle-2"); // id collision resolved, not an error
    const dupReg = await post("/admin/buses", { name: "Other", registrationNumber: "UP65 AB 1234" });
    expect([dupReg.status, dupReg.body.error.code]).toEqual([409, "ALREADY_EXISTS"]);

    const u = await patch("/admin/buses/night-shuttle", { name: "Night Bus", registrationNumber: null });
    expect(u.body).toMatchObject({ name: "Night Bus", registrationNumber: null });
    expect((await get("/admin/buses")).body.map((b: any) => b.id)).toEqual(expect.arrayContaining(["bus-1", "night-shuttle"]));
    await pool.query("DELETE FROM buses WHERE id LIKE 'night-%'");
  });

  it("validates input", async () => {
    expect((await post("/admin/buses", { name: "" })).status).toBe(400);
    expect((await post("/admin/buses", { name: "X", id: "Bad Id!" })).status).toBe(400);
    expect((await patch("/admin/buses/nope", { name: "X" })).status).toBe(404);
  });

  it("disables and re-enables a bus, but not while a trip is running on it", async () => {
    await request(app).post("/trips/start").set(bearer(driver)).send({ busId: "bus-1", routeId: "route-a" });
    const blocked = await patch("/admin/buses/bus-1", { active: false });
    expect([blocked.status, blocked.body.error.code]).toEqual([409, "BUS_IN_USE"]);
    await request(app).post("/trips/end").set(bearer(driver));
    expect((await patch("/admin/buses/bus-1", { active: false })).body.active).toBe(false);
    expect((await get("/buses")).body ?? null).toBeDefined();
    const start = await request(app).post("/trips/start").set(bearer(driver)).send({ busId: "bus-1", routeId: "route-a" });
    expect(start.body.error.code).toBe("BUS_DISABLED");
    expect((await patch("/admin/buses/bus-1", { active: true })).body.active).toBe(true);
  });

  it("deleting a bus with trip history is refused; one without history is deleted", async () => {
    await request(app).post("/trips/start").set(bearer(driver)).send({ busId: "bus-1", routeId: "route-a" });
    await request(app).post("/trips/end").set(bearer(driver));
    const refused = await del("/admin/buses/bus-1");
    expect([refused.status, refused.body.error.code]).toEqual([409, "IN_USE"]);
    await post("/admin/buses", { name: "Spare", id: "test-spare" });
    expect((await del("/admin/buses/test-spare")).status).toBe(204);
    expect((await del("/admin/buses/test-spare")).status).toBe(404);
  });
});

describe("accounts", () => {
  it("creates a driver with a generated password that works once, and stores no readable password", async () => {
    const c = await post("/admin/users", { name: "Test Driver", email: "Test-One@Example.com", role: "DRIVER" });
    expect(c.status).toBe(201);
    expect(c.body.user).toMatchObject({ email: "test-one@example.com", role: "DRIVER", active: true });
    expect(c.body.temporaryPassword).toMatch(/^[A-Za-z2-9]{14}$/);
    expect(JSON.stringify(c.body)).not.toMatch(/scrypt/);
    const login = await request(app).post("/auth/login").send({ email: "test-one@example.com", password: c.body.temporaryPassword });
    expect(login.status).toBe(200);
    expect(login.body.user.buses).toEqual([]);
  });

  it("accepts an admin-chosen password, enforcing the minimum length, and refuses duplicate emails", async () => {
    expect((await post("/admin/users", { name: "T", email: "test-two@example.com", role: "DRIVER", password: "short" })).status).toBe(400);
    const ok = await post("/admin/users", { name: "T", email: "test-two@example.com", role: "DRIVER", password: "a-chosen-password" });
    expect(ok.body.temporaryPassword).toBeNull();
    const dup = await post("/admin/users", { name: "T2", email: "TEST-TWO@example.com", role: "ADMIN" });
    expect([dup.status, dup.body.error.message]).toEqual([409, "That email is already registered"]);
  });

  it("assigning buses lets the driver start a trip on them, and replaces the previous set", async () => {
    const u = (await post("/admin/users", { name: "T", email: "test-three@example.com", role: "DRIVER", password: "a-chosen-password" })).body.user;
    await post("/admin/buses", { name: "Test Bus", id: "test-bus" });
    const tok = (await request(app).post("/auth/login").send({ email: "test-three@example.com", password: "a-chosen-password" })).body.accessToken;
    const start = () => request(app).post("/trips/start").set(bearer(tok)).send({ busId: "test-bus", routeId: "route-a" });
    expect((await start()).body.error.code).toBe("BUS_NOT_ASSIGNED");
    const a = await put(`/admin/users/${u.id}/buses`, { busIds: ["test-bus"] });
    expect(a.body.buses).toEqual(["test-bus"]);
    expect((await start()).status).toBe(201);
    await request(app).post("/trips/end").set(bearer(tok));
    expect((await put(`/admin/users/${u.id}/buses`, { busIds: [] })).body.buses).toEqual([]);
    expect((await start()).body.error.code).toBe("BUS_NOT_ASSIGNED");
    expect((await put(`/admin/users/${u.id}/buses`, { busIds: ["no-such-bus"] })).status).toBe(404);
    expect((await put(`/admin/users/${adminId}/buses`, { busIds: ["bus-1"] })).body.error.code).toBe("NOT_A_DRIVER");
  });

  it("disabling locks the person out at once and ends their sessions; resetting a password does too", async () => {
    const u = (await post("/admin/users", { name: "T", email: "test-four@example.com", role: "DRIVER", password: "a-chosen-password" })).body.user;
    const login = await request(app).post("/auth/login").send({ email: "test-four@example.com", password: "a-chosen-password" });
    const cookie = (login.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
    expect((await request(app).get("/auth/me").set(bearer(login.body.accessToken))).status).toBe(200);

    expect((await patch(`/admin/users/${u.id}`, { active: false })).body.active).toBe(false);
    expect((await request(app).get("/auth/me").set(bearer(login.body.accessToken))).status).toBe(401);
    expect((await request(app).post("/auth/refresh").set({ "X-Requested-With": "x" }).set("Cookie", cookie)).status).toBe(401);

    await patch(`/admin/users/${u.id}`, { active: true, password: "a-new-password-1" });
    expect((await request(app).post("/auth/login").send({ email: "test-four@example.com", password: "a-chosen-password" })).status).toBe(401);
    expect((await request(app).post("/auth/login").send({ email: "test-four@example.com", password: "a-new-password-1" })).status).toBe(200);
  });

  it("an admin cannot lock themselves out, but can edit their own name", async () => {
    expect((await patch(`/admin/users/${adminId}`, { active: false })).body.error.code).toBe("CANNOT_MODIFY_SELF");
    expect((await patch(`/admin/users/${adminId}`, { role: "DRIVER" })).body.error.code).toBe("CANNOT_MODIFY_SELF");
    expect((await del(`/admin/users/${adminId}`)).body.error.code).toBe("CANNOT_MODIFY_SELF");
    expect((await patch(`/admin/users/${adminId}`, { name: "Dev Admin" })).status).toBe(200);
  });

  it("deletes an account with no trips; refuses one with trip history", async () => {
    const u = (await post("/admin/users", { name: "T", email: "test-five@example.com", role: "DRIVER" })).body.user;
    expect((await del(`/admin/users/${u.id}`)).status).toBe(204);
    await request(app).post("/trips/start").set(bearer(driver)).send({ busId: "bus-1", routeId: "route-a" });
    await request(app).post("/trips/end").set(bearer(driver));
    const driverId = (await pool.query("SELECT id FROM users WHERE email = 'driver@example.com'")).rows[0].id;
    expect((await del(`/admin/users/${driverId}`)).body.error.code).toBe("IN_USE");
  });
});

describe("stops", () => {
  const onRoute = () => { const [lat, lng] = pointAt(path, 300); return { lat, lng }; };

  it("a new stop on the route is picked up with its place along the route, and moving it updates that", async () => {
    const before = (await get("/admin/routes/route-a")).body.passes.length;
    const c = await post("/admin/stops", { name: "Test Stop", id: "test-stop", ...onRoute() });
    expect(c.status).toBe(201);
    const route = (await get("/admin/routes/route-a")).body;
    const passes = route.passes.filter((p: any) => p.stopId === "test-stop");
    expect(route.passes.length).toBe(before + 2); // outbound and return
    expect(passes[0].s).toBeGreaterThan(290);
    expect(passes[0].s).toBeLessThan(310);
    expect(route.passes.map((p: any) => p.s)).toEqual([...route.passes.map((p: any) => p.s)].sort((a, b) => a - b));

    const [lat, lng] = pointAt(path, 600);
    await patch("/admin/stops/test-stop", { lat, lng });
    const moved = (await get("/admin/routes/route-a")).body.passes.filter((p: any) => p.stopId === "test-stop");
    expect(moved[0].s).toBeGreaterThan(590);
    expect(moved[0].s).toBeLessThan(610);
  });

  it("a stop away from every route is saved but belongs to no route", async () => {
    await post("/admin/stops", { name: "Test Far", id: "test-far", lat: 25.3, lng: 83.0 });
    expect((await get("/admin/stops")).body.find((s: any) => s.id === "test-far").routes).toEqual([]);
  });

  it("deleting a stop removes it from the route's passes", async () => {
    await post("/admin/stops", { name: "Test Stop", id: "test-stop", ...onRoute() });
    expect((await del("/admin/stops/test-stop")).status).toBe(204);
    expect((await get("/admin/routes/route-a")).body.passes.some((p: any) => p.stopId === "test-stop")).toBe(false);
    expect((await del("/admin/stops/test-stop")).status).toBe(404);
  });

  it("a route change reaches the live ETA logic at once (the route cache is refreshed)", async () => {
    await post("/admin/stops", { name: "Test Stop", id: "test-stop", ...onRoute() });
    await request(app).post("/trips/start").set(bearer(driver)).send({ busId: "bus-1", routeId: "route-a" });
    const [lat, lng] = pointAt(path, 100);
    await request(app).post("/location").set(bearer(driver)).send({ lat, lng, speed: 5, accuracy: 8, ts: Date.now() });
    const bus = (await request(app).get("/buses")).body[0];
    expect(bus.progress.etas["test-stop"].metres).toBeGreaterThan(150);
    expect(bus.progress.etas["test-stop"].metres).toBeLessThan(250);
  });

  it("validates coordinates", async () => {
    expect((await post("/admin/stops", { name: "Bad", lat: 200, lng: 0 })).status).toBe(400);
    expect((await patch("/admin/stops/nope", { name: "X" })).status).toBe(404);
  });
});

describe("routes", () => {
  const square = [[25.2700, 82.9800], [25.2700, 82.9815], [25.2712, 82.9815], [25.2712, 82.9800], [25.2700, 82.9800]];

  it("previews without saving: length, passes and warnings", async () => {
    const p = await post("/admin/routes/preview", { points: campus.routes[0].points });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ pointCount: 57, unmatchedStops: [], warnings: [] });
    expect(p.body.passes).toHaveLength(8);
    expect(p.body.totalLengthM).toBeCloseTo(campus.routes[0].total, 0);
    const open = await post("/admin/routes/preview", { points: square.slice(0, 3) });
    expect(open.body.warnings.join(" ")).toMatch(/ends .* from where it starts/);
    expect(open.body.unmatchedStops.length).toBe(5);
    expect((await get("/admin/routes")).body.map((r: any) => r.id)).toEqual(["route-a"]);
  });

  it("rejects bad points", async () => {
    for (const points of [[], [[25.1, 82.9]], [[95, 10], [20, 20]], [[25.1, "x"], [1, 2]]])
      expect((await post("/admin/routes/preview", { points })).status).toBe(400);
  });

  it("creates a route, serves it with its points, and a driver can run a trip on it", async () => {
    const c = await post("/admin/routes", { name: "Test Loop", id: "test-loop", color: "#ff0000", points: square });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ id: "test-loop", color: "#ff0000", pointCount: 5, active: true });
    expect(c.body.totalLengthM).toBeGreaterThan(400);
    const d = (await get("/admin/routes/test-loop")).body;
    expect(d.points).toEqual(square);
    expect((await request(app).get("/routes/test-loop")).body.points).toHaveLength(5); // the public endpoint sees it too
    const start = await request(app).post("/trips/start").set(bearer(driver)).send({ busId: "bus-1", routeId: "test-loop" });
    expect(start.status).toBe(201);
    await request(app).post("/trips/end").set(bearer(driver));
  });

  it("editing the path recomputes the length and passes; deactivating hides it from the public list", async () => {
    await post("/admin/routes", { name: "Test Loop", id: "test-loop", points: square });
    const before = (await get("/admin/routes/test-loop")).body.totalLengthM;
    const bigger = [[25.2700, 82.9800], [25.2700, 82.9830], [25.2712, 82.9830], [25.2712, 82.9800], [25.2700, 82.9800]];
    expect((await put("/admin/routes/test-loop", { points: bigger })).body.totalLengthM).toBeGreaterThan(before);
    expect((await put("/admin/routes/test-loop", { active: false })).body.active).toBe(false);
    expect((await request(app).get("/routes")).body.some((r: any) => r.id === "test-loop")).toBe(false);
    expect((await put("/admin/routes/test-loop", { color: "red" })).status).toBe(400);
  });

  it("will not change or switch off a route while a trip is running on it", async () => {
    await request(app).post("/trips/start").set(bearer(driver)).send({ busId: "bus-1", routeId: "route-a" });
    const blocked = await put("/admin/routes/route-a", { points: square });
    expect([blocked.status, blocked.body.error.code]).toEqual([409, "ROUTE_IN_USE"]);
    expect((await put("/admin/routes/route-a", { active: false })).body.error.code).toBe("ROUTE_IN_USE");
    expect((await put("/admin/routes/route-a", { name: "Route A (renamed)" })).status).toBe(200); // harmless edits are fine
    await put("/admin/routes/route-a", { name: "Route A" });
  });

  it("deletes an unused route and refuses one with trip history", async () => {
    await post("/admin/routes", { name: "Test Loop", id: "test-loop", points: square });
    expect((await del("/admin/routes/test-loop")).status).toBe(204);
    await request(app).post("/trips/start").set(bearer(driver)).send({ busId: "bus-1", routeId: "route-a" });
    await request(app).post("/trips/end").set(bearer(driver));
    expect((await del("/admin/routes/route-a")).body.error.code).toBe("IN_USE");
  });
});

describe("trips and overview", () => {
  async function drive(to = 500, n = 8) {
    await request(app).post("/trips/start").set(bearer(driver)).send({ busId: "bus-1", routeId: "route-a" });
    for (let i = 1; i <= n; i++) {
      const [lat, lng] = pointAt(path, (to * i) / n);
      await request(app).post("/location").set(bearer(driver)).send({ lat, lng, speed: 6, accuracy: 10, ts: Date.now() - (n - i) * 3000 });
    }
  }

  it("overview counts what is running and reports GPS health", async () => {
    const idle = (await get("/admin/overview")).body;
    expect(idle.stats).toMatchObject({ totalBuses: 1, activeBuses: 0, activeTrips: 0, onlineDrivers: 0 });
    await drive();
    // the test posts its 8 fixes in a few milliseconds; spread their arrival times as a real 3 s feed would have
    await pool.query(`UPDATE gps_locations g SET received_at = now() - ((8 - x.n) * interval '3 seconds')
                        FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM gps_locations) x WHERE x.id = g.id`);
    const o = (await get("/admin/overview")).body;
    expect(o.stats).toMatchObject({ activeBuses: 1, activeTrips: 1, onlineDrivers: 1, fixesLastHour: 8 });
    expect(o.system).toMatchObject({ db: "up" });
    const bus = o.buses[0];
    expect(bus).toMatchObject({ id: "bus-1", status: "LIVE", driver: { name: "Dev Driver" }, speedKmh: 22 });
    expect(bus.health).toMatchObject({ fixes: 8, avgAccuracyM: 10 });
    expect(bus.health.avgIntervalS).toBeCloseTo(3, 0);
    expect(o.trips).toHaveLength(1);
    expect(JSON.stringify(o)).not.toMatch(/scrypt|password/i);
  });

  it("lists trips with filters and paging, and shows one with its trail and statistics", async () => {
    await drive(600, 10);
    await request(app).post("/trips/end").set(bearer(driver));
    await drive(300, 5);
    const all = (await get("/admin/trips")).body;
    expect(all.trips.map((t: any) => t.status)).toEqual(["ACTIVE", "COMPLETED"]); // newest first
    expect(all.trips[1]).toMatchObject({ busName: "Bus 1", driverName: "Dev Driver", routeName: "Route A", fixCount: 10 });
    expect((await get("/admin/trips?status=COMPLETED")).body.trips).toHaveLength(1);
    expect((await get("/admin/trips?busId=nope")).body.trips).toHaveLength(0);
    const page = (await get("/admin/trips?limit=1")).body;
    expect(page.trips).toHaveLength(1);
    expect((await get(`/admin/trips?limit=1&before=${page.nextBefore}`)).body.trips[0].id).toBe(page.nextBefore - 1);

    const detail = (await get(`/admin/trips/${all.trips[1].id}`)).body;
    expect(detail.trail).toHaveLength(10);
    expect(detail.stats.distanceM).toBeGreaterThan(450);
    expect(detail.stats.distanceM).toBeLessThan(650);
    expect(detail.stats.maxSpeedKmh).toBe(22);
    expect(detail.stats.gaps).toBe(0);
    expect((await get("/admin/trips/99999")).status).toBe(404);
  });

  it("counts GPS dropouts inside a trip", async () => {
    await request(app).post("/trips/start").set(bearer(driver)).send({ busId: "bus-1", routeId: "route-a" });
    for (const ago of [200, 190, 100, 90]) { // a 90 s hole in the middle
      const [lat, lng] = pointAt(path, 100);
      await request(app).post("/location").set(bearer(driver)).send({ lat, lng, speed: 5, accuracy: 8, ts: Date.now() - ago * 1000 });
    }
    const id = (await get("/admin/trips?status=ACTIVE")).body.trips[0].id;
    expect((await get(`/admin/trips/${id}`)).body.stats).toMatchObject({ gaps: 1, longestGapS: 90 });
  });

  it("force-ends a trip whose driver vanished, so the bus can be used again", async () => {
    await drive();
    const id = (await get("/admin/trips?status=ACTIVE")).body.trips[0].id;
    expect((await post(`/admin/trips/${id}/end`)).status).toBe(200);
    expect((await get("/buses")).status).toBe(200);
    expect((await request(app).get("/buses")).body[0].status).toBe("NOT_OPERATING");
    expect((await post(`/admin/trips/${id}/end`)).body.error.code).toBe("TRIP_NOT_ACTIVE");
    expect((await post("/admin/trips/99999/end")).status).toBe(404);
  });
});

describe("audit log", () => {
  it("records who did what, including a driver's password change without the password", async () => {
    await post("/admin/buses", { name: "Test Bus", id: "test-bus" });
    const u = (await post("/admin/users", { name: "T", email: "test-six@example.com", role: "DRIVER" })).body.user;
    await patch(`/admin/users/${u.id}`, { password: "super-secret-pass-1" });
    await patch("/admin/buses/test-bus", { active: false });
    const log = (await get("/admin/audit")).body;
    expect(log.map((e: any) => e.action)).toEqual(["bus.disable", "user.reset-password", "user.create", "bus.create"]);
    expect(log[0]).toMatchObject({ userName: "Dev Admin", target: "test-bus" });
    expect(JSON.stringify(log)).not.toContain("super-secret-pass-1");
    expect((await get("/admin/overview")).body.audit).toHaveLength(4);
  });
});
