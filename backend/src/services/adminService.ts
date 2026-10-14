import { randomInt } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { hashPassword } from "../auth/password";
import { routeCache, type Deps } from "../deps";
import type { Db } from "../db";
import type { LatLng } from "../geo/geo";
import { AppError } from "../http/errors";
import { revokeAllRefreshTokens } from "../repositories/auth";
import { analyzeRoute, type StopPos } from "./routeBuilder";

export async function withTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

/** Turns "Main Gate" into "main-gate", and "main-gate-2" if that is taken. */
export async function uniqueId(db: Db, table: "buses" | "stops" | "routes", base: string): Promise<string> {
  const slug = base.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || table.slice(0, -1);
  for (let n = 1; n < 1000; n++) {
    const id = n === 1 ? slug : `${slug}-${n}`;
    if (!(await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rows[0]) return id;
  }
  throw new AppError(409, "ALREADY_EXISTS", "Could not find a free id");
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

export async function loadStops(db: Db): Promise<StopPos[]> {
  return (await db.query("SELECT id, name, lat, lng FROM stops ORDER BY id")).rows;
}
export async function loadPoints(db: Db, routeId: string): Promise<LatLng[]> {
  return (await db.query("SELECT lat, lng FROM route_points WHERE route_id = $1 ORDER BY seq", [routeId])).rows.map((p) => [p.lat, p.lng] as LatLng);
}

/** Rebuilds `route_stops` (and the stored length) from the current geometry. Call after any route or stop change. */
export async function recomputeRouteStops(db: Db, routeId?: string): Promise<void> {
  const routes = (await db.query(routeId ? "SELECT id FROM routes WHERE id = $1" : "SELECT id FROM routes", routeId ? [routeId] : [])).rows;
  const stops = await loadStops(db);
  for (const { id } of routes) {
    const points = await loadPoints(db, id);
    if (points.length < 2) continue;
    const a = analyzeRoute(points, stops);
    await db.query("UPDATE routes SET total_length_m = $2 WHERE id = $1", [id, a.totalLengthM]);
    await db.query("DELETE FROM route_stops WHERE route_id = $1", [id]);
    if (a.passes.length)
      await db.query(
        `INSERT INTO route_stops (route_id, seq, stop_id, dist_along_route_m)
         SELECT $1, * FROM unnest($2::int[], $3::text[], $4::float8[])`,
        [id, a.passes.map((_, i) => i + 1), a.passes.map((p) => p.stopId), a.passes.map((p) => p.s)]);
  }
}

export async function replacePoints(db: Db, routeId: string, points: LatLng[]) {
  await db.query("DELETE FROM route_points WHERE route_id = $1", [routeId]);
  await db.query(
    `INSERT INTO route_points (route_id, seq, lat, lng) SELECT $1, * FROM unnest($2::int[], $3::float8[], $4::float8[])`,
    [routeId, points.map((_, i) => i + 1), points.map((p) => p[0]), points.map((p) => p[1])]);
}

export async function activeTripsOnRoute(db: Db, routeId: string): Promise<number> {
  return (await db.query("SELECT count(*)::int AS n FROM trips WHERE route_id = $1 AND status = 'ACTIVE'", [routeId])).rows[0].n;
}

/** Routes are read from a per-process cache; drop it so this server sees the change at once (others within 5 minutes). */
export const refreshRouteModels = (deps: Deps) => routeCache(deps).invalidate();

// ---- accounts -------------------------------------------------------------------------------

const PW_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/l/I to misread
export const generatePassword = (len = 14) => Array.from({ length: len }, () => PW_ALPHABET[randomInt(PW_ALPHABET.length)]).join("");

export async function createUser(pool: Pool, u: { name: string; email: string; role: "DRIVER" | "ADMIN"; password?: string }) {
  const temporary = u.password ? null : generatePassword();
  const hash = await hashPassword(u.password ?? temporary!);
  const { rows } = await pool.query(
    `INSERT INTO users (role, name, email, password_hash) VALUES ($1, $2, $3, $4)
     RETURNING id, name, email, role, active, created_at AS "createdAt"`, [u.role, u.name, u.email.toLowerCase(), hash]);
  return { user: { ...rows[0], buses: [] as string[] }, temporaryPassword: temporary };
}

/** Ends everything this person is signed into, so a disabled or reset account cannot carry on with a refresh token. */
export const endSessions = (db: Db, userId: number) => revokeAllRefreshTokens(db, userId);
