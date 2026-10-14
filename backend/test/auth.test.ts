import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { burnPasswordCheck, hashPassword, verifyPassword } from "../src/auth/password";
import { LoginGuard } from "../src/auth/loginLimiter";
import { RateLimiter } from "../src/security/rateLimit";
import { loadConfig } from "../src/config";
import { createPool } from "../src/db";
import { createLogger } from "../src/logger";
import { bearer, DEV_ADMIN, DEV_DRIVER, loginToken } from "./helpers";

const config = loadConfig();
const log = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl, log);
const app = createApp({ pool, config, log });
const CSRF = { "X-Requested-With": "fetch" };

const cookieOf = (res: request.Response) => {
  const raw = (res.headers["set-cookie"] as unknown as string[] | undefined)?.find((c) => c.startsWith("refresh_token="));
  return { raw, pair: raw?.split(";")[0] };
};

beforeEach(async () => {
  await pool.query("TRUNCATE gps_locations, trips RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM refresh_tokens");
  await pool.query("UPDATE users SET active = true, role = 'DRIVER' WHERE email = 'driver@example.com'");
  await pool.query("DELETE FROM buses WHERE id = 'bus-2'");
});
afterAll(async () => { await pool.end(); });

describe("login", () => {
  it("returns an access token and the user, and sets the refresh token as an httpOnly cookie only", async () => {
    const r = await request(app).post("/auth/login").send(DEV_DRIVER);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ expiresIn: 900, user: { role: "DRIVER", name: "Dev Driver", buses: [{ id: "bus-1" }] } });
    expect(typeof r.body.accessToken).toBe("string");
    expect(JSON.stringify(r.body)).not.toMatch(/refresh|hash|password/i);
    const { raw } = cookieOf(r);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).not.toMatch(/Secure/i); // development only; production sets it
  });

  it("matches email case-insensitively", async () => {
    expect((await request(app).post("/auth/login").send({ ...DEV_DRIVER, email: "Driver@Example.COM" })).status).toBe(200);
  });

  it("gives the same answer for an unknown email, a wrong password and a disabled account", async () => {
    await pool.query("UPDATE users SET active = false WHERE email = 'driver@example.com'");
    const results = await Promise.all([
      request(app).post("/auth/login").send({ email: "nobody@example.com", password: "whatever-123" }),
      request(app).post("/auth/login").send({ email: "admin@example.com", password: "wrong-password" }),
      request(app).post("/auth/login").send(DEV_DRIVER), // right password, but disabled
    ]);
    for (const r of results) expect([r.status, r.body.error.code, r.body.error.message]).toEqual([401, "INVALID_CREDENTIALS", "Wrong email or password"]);
  });

  it("rejects malformed bodies", async () => {
    expect((await request(app).post("/auth/login").send({ email: "not-an-email", password: "x" })).status).toBe(400);
    expect((await request(app).post("/auth/login").send({})).status).toBe(400);
  });

  it("blocks repeated wrong guesses, even a correct password during the block, then lets a different account through", async () => {
    const strict = createApp({ pool, config: { ...config, auth: { ...config.auth, loginMaxAttempts: 3 } }, log });
    for (let i = 0; i < 3; i++)
      expect((await request(strict).post("/auth/login").send({ ...DEV_DRIVER, password: "wrong-wrong" })).status).toBe(401);
    const blocked = await request(strict).post("/auth/login").send(DEV_DRIVER);
    expect([blocked.status, blocked.body.error.code]).toEqual([429, "TOO_MANY_ATTEMPTS"]);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect((await request(strict).post("/auth/login").send(DEV_ADMIN)).status).toBe(200);
  });

  it("a successful login clears the failure count", async () => {
    const strict = createApp({ pool, config: { ...config, auth: { ...config.auth, loginMaxAttempts: 3 } }, log });
    for (let i = 0; i < 2; i++) await request(strict).post("/auth/login").send({ ...DEV_DRIVER, password: "wrong-wrong" });
    expect((await request(strict).post("/auth/login").send(DEV_DRIVER)).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await request(strict).post("/auth/login").send({ ...DEV_DRIVER, password: "wrong-wrong" })).status).toBe(401);
  });

  it("marks the cookie Secure when configured (production)", async () => {
    const secure = createApp({ pool, config: { ...config, auth: { ...config.auth, cookieSecure: true } }, log });
    expect(cookieOf(await request(secure).post("/auth/login").send(DEV_DRIVER)).raw).toMatch(/Secure/);
  });
});

describe("refresh and logout", () => {
  const signIn = async () => cookieOf(await request(app).post("/auth/login").send(DEV_DRIVER)).pair!;

  it("rotates: a new access token and a new cookie, and the old cookie stops working", async () => {
    const first = await signIn();
    const r = await request(app).post("/auth/refresh").set(CSRF).set("Cookie", first);
    expect(r.status).toBe(200);
    expect(r.body.accessToken).toBeTruthy();
    const second = cookieOf(r).pair!;
    expect(second).not.toBe(first);
    expect((await request(app).get("/auth/me").set(bearer(r.body.accessToken))).status).toBe(200);
    expect((await request(app).post("/auth/refresh").set(CSRF).set("Cookie", first)).status).toBe(401);
  });

  it("replaying an already-used token ends every session of that user", async () => {
    const first = await signIn();
    const second = cookieOf(await request(app).post("/auth/refresh").set(CSRF).set("Cookie", first)).pair!;
    await pool.query("UPDATE refresh_tokens SET revoked_at = now() - interval '1 minute' WHERE revoked_at IS NOT NULL"); // not a tab race any more
    expect((await request(app).post("/auth/refresh").set(CSRF).set("Cookie", first)).status).toBe(401); // the replay (a thief, or a stolen copy)
    expect((await request(app).post("/auth/refresh").set(CSRF).set("Cookie", second)).status).toBe(401); // legit holder is out too
  });

  it("two tabs refreshing at the same moment do not log each other out", async () => {
    const first = await signIn();
    const winner = await request(app).post("/auth/refresh").set(CSRF).set("Cookie", first);
    const loser = await request(app).post("/auth/refresh").set(CSRF).set("Cookie", first); // same old cookie, a moment later
    expect(loser.status).toBe(401);
    // the browser now holds the winner's cookie, so the loser's retry succeeds
    expect((await request(app).post("/auth/refresh").set(CSRF).set("Cookie", cookieOf(winner).pair!)).status).toBe(200);
  });

  it("needs the cookie and the custom header", async () => {
    const c = await signIn();
    expect((await request(app).post("/auth/refresh").set("Cookie", c)).body.error.code).toBe("CSRF");
    expect((await request(app).post("/auth/refresh").set(CSRF)).status).toBe(401);
    expect((await request(app).post("/auth/refresh").set(CSRF).set("Cookie", "refresh_token=made-up")).status).toBe(401);
  });

  it("refuses to refresh for a user who has been disabled", async () => {
    const c = await signIn();
    await pool.query("UPDATE users SET active = false WHERE email = 'driver@example.com'");
    expect((await request(app).post("/auth/refresh").set(CSRF).set("Cookie", c)).status).toBe(401);
  });

  it("logout revokes the session and clears the cookie", async () => {
    const c = await signIn();
    const out = await request(app).post("/auth/logout").set(CSRF).set("Cookie", c);
    expect(out.status).toBe(204);
    expect(cookieOf(out).raw).toMatch(/refresh_token=;/);
    expect((await request(app).post("/auth/refresh").set(CSRF).set("Cookie", c)).status).toBe(401);
  });

  it("stores only a hash of the refresh token", async () => {
    const c = await signIn();
    const stored = (await pool.query("SELECT token_hash FROM refresh_tokens")).rows.map((r) => r.token_hash);
    expect(stored).toHaveLength(1);
    expect(c).not.toContain(stored[0]);
    expect(stored[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("access tokens and roles", () => {
  const forge = (opts: jwt.SignOptions, secret = config.auth.jwtSecret, claims: object = { role: "DRIVER" }) =>
    jwt.sign(claims, secret, { subject: "1", issuer: "campus-bus-tracker", ...opts });

  it("requires a valid bearer token", async () => {
    const get = (h: Record<string, string> = {}) => request(app).get("/trips/active").set(h);
    expect((await get()).status).toBe(401);
    expect((await get({ Authorization: "Basic abc" })).status).toBe(401);
    expect((await get({ Authorization: "Bearer garbage" })).body.error.code).toBe("UNAUTHENTICATED");
    expect((await get(bearer(forge({ expiresIn: 60 }, "some-other-secret")))).status).toBe(401);          // wrong key
    expect((await get(bearer(forge({ expiresIn: 60, issuer: "someone-else" })))).status).toBe(401);       // wrong issuer
    const unsigned = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from('{"sub":"1","iss":"campus-bus-tracker"}').toString("base64url")}.`;
    expect((await get(bearer(unsigned))).status).toBe(401);                                                // alg: none
    expect((await get(bearer(forge({ expiresIn: 60 })))).status).toBe(200);                                // control: the same token, validly signed
  });

  it("tells an expired token apart, so a client knows to refresh", async () => {
    const r = await request(app).get("/trips/active").set(bearer(forge({ expiresIn: -10 })));
    expect([r.status, r.body.error.code]).toEqual([401, "TOKEN_EXPIRED"]);
  });

  it("a driver cannot reach admin endpoints; an admin can, and sees no password data", async () => {
    const driver = await loginToken(app);
    expect((await request(app).get("/admin/users").set(bearer(driver))).status).toBe(403);
    expect((await request(app).get("/admin/users")).status).toBe(401);
    const admin = await request(app).get("/admin/users").set(bearer(await loginToken(app, DEV_ADMIN)));
    expect(admin.status).toBe(200);
    expect(admin.body.map((u: any) => u.email)).toEqual(expect.arrayContaining(["driver@example.com", "admin@example.com"]));
    expect(admin.body.find((u: any) => u.email === "driver@example.com").buses).toEqual(["bus-1"]);
    expect(JSON.stringify(admin.body)).not.toMatch(/scrypt|password|hash/i);
  });

  it("an admin cannot drive", async () => {
    const admin = await loginToken(app, DEV_ADMIN);
    const r = await request(app).post("/trips/start").set(bearer(admin)).send({ busId: "bus-1", routeId: "route-a" });
    expect(r.status).toBe(403);
  });

  it("disabling a driver locks them out at once, without waiting for the token to expire", async () => {
    const token = await loginToken(app);
    expect((await request(app).get("/trips/active").set(bearer(token))).status).toBe(200);
    await pool.query("UPDATE users SET active = false WHERE email = 'driver@example.com'");
    expect((await request(app).get("/trips/active").set(bearer(token))).status).toBe(401);
  });

  it("uses the role in the database, not the one inside the token", async () => {
    const token = await loginToken(app);
    await pool.query("UPDATE users SET role = 'ADMIN' WHERE email = 'driver@example.com'");
    expect((await request(app).get("/trips/active").set(bearer(token))).status).toBe(403);
  });
});

describe("a driver can only take their own buses", () => {
  it("starting a trip on an unassigned bus is refused until it is assigned", async () => {
    await pool.query("INSERT INTO buses (id, name) VALUES ('bus-2', 'Bus 2')");
    const token = await loginToken(app);
    const start = () => request(app).post("/trips/start").set(bearer(token)).send({ busId: "bus-2", routeId: "route-a" });
    const refused = await start();
    expect([refused.status, refused.body.error.code]).toEqual([403, "BUS_NOT_ASSIGNED"]);
    await pool.query("INSERT INTO driver_buses SELECT id, 'bus-2' FROM users WHERE email = 'driver@example.com'");
    expect((await start()).status).toBe(201);
    await pool.query("DELETE FROM driver_buses WHERE bus_id = 'bus-2'");
  });
});

describe("passwords", () => {
  it("hashes with a random salt and verifies", async () => {
    const [a, b] = [await hashPassword("correct horse battery"), await hashPassword("correct horse battery")];
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("correct horse batterz", a)).toBe(false);
  });
  it("rejects anything that is not a hash, including the old dev placeholder", async () => {
    for (const bad of ["DEV_ONLY_NOT_A_HASH", "", "scrypt$1$2", "bcrypt$x$y$z$a$b", "scrypt$99999999$8$1$AAAA$AAAA"])
      expect(await verifyPassword("x", bad)).toBe(false);
  });
  it("burnPasswordCheck takes about as long as a real check", async () => {
    const h = await hashPassword("pw");
    await burnPasswordCheck("warm-up");
    const time = async (f: () => Promise<unknown>) => { const t = performance.now(); await f(); return performance.now() - t; };
    const real = await time(() => verifyPassword("pw", h));
    const burn = await time(() => burnPasswordCheck("pw"));
    expect(burn).toBeGreaterThan(real * 0.4);
  });
});

describe("LoginGuard", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("blocks one address guessing one account, but not a different address or account", async () => {
    const g = new LoginGuard(new RateLimiter(), 3, 9, 60_000);
    for (let i = 0; i < 3; i++) await g.fail("1.1.1.1", "a@x.com");
    expect(await g.blockedFor("1.1.1.1", "A@x.com")).toBeGreaterThan(0); // email compared case-insensitively
    expect(await g.blockedFor("2.2.2.2", "a@x.com")).toBeNull();
    expect(await g.blockedFor("1.1.1.1", "b@x.com")).toBeNull();
  });

  it("blocks guessing one account from many addresses, with a looser cap", async () => {
    const g = new LoginGuard(new RateLimiter(), 3, 6, 60_000);
    for (let i = 0; i < 6; i++) await g.fail(`10.0.0.${i}`, "a@x.com"); // never more than one failure per address
    expect(await g.blockedFor("10.9.9.9", "a@x.com")).toBeGreaterThan(0);
  });

  it("forgets failures after the window, and after a successful sign-in", async () => {
    const g = new LoginGuard(new RateLimiter(), 2, 6, 60);
    await g.fail("1.1.1.1", "a@x.com"); await g.fail("1.1.1.1", "a@x.com");
    expect(await g.blockedFor("1.1.1.1", "a@x.com")).not.toBeNull();
    await sleep(90);
    expect(await g.blockedFor("1.1.1.1", "a@x.com")).toBeNull();
    const g2 = new LoginGuard(new RateLimiter(), 2, 6, 60_000);
    await g2.fail("1.1.1.1", "a@x.com"); await g2.fail("1.1.1.1", "a@x.com");
    await g2.succeeded("1.1.1.1", "a@x.com");
    expect(await g2.blockedFor("1.1.1.1", "a@x.com")).toBeNull();
  });
});

describe("production config", () => {
  const env = { NODE_ENV: "production", DATABASE_URL: "postgres://x" };
  it("refuses to start without a real JWT secret", () => {
    expect(() => loadConfig(env)).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...env, JWT_SECRET: "too-short" })).toThrow(/JWT_SECRET/);
  });
  it("with a secret: secure cookies on, secret used as given", () => {
    const c = loadConfig({ ...env, JWT_SECRET: "x".repeat(40) });
    expect(c.auth).toMatchObject({ cookieSecure: true, jwtSecret: "x".repeat(40) });
  });
});
