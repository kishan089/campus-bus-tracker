import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { hashPassword } from "../auth/password";

export interface Campus {
  routes: { id: string; name: string; color: string; points: [number, number][]; total: number;
            stopPasses: Record<string, number[]> }[];
  stops: { id: string; name: string; pos: [number, number] }[];
  landmarks: { id: string; name: string; category: string; pos: [number, number] }[];
}

// Phase 2: the frontend's campus.json is the source. From Phase 10 on the DB is, and the frontend reads the API.
export function loadCampus(file = process.env.CAMPUS_DATA ??
    path.resolve(__dirname, "../../../frontend/src/data/campus.json")): Campus {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export const DEV_DRIVER_PASSWORD = "driver-dev-123";
export const DEV_ADMIN_PASSWORD = "admin-dev-123";

export async function seed(pool: Pool, campus: Campus, opts: { devData: boolean }) {
  const stopIds = new Set(campus.stops.map((s) => s.id));
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    for (const s of campus.stops)
      await db.query(
        `INSERT INTO stops (id, name, lat, lng) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, lat = EXCLUDED.lat, lng = EXCLUDED.lng`,
        [s.id, s.name, s.pos[0], s.pos[1]]);
    for (const l of campus.landmarks)
      await db.query(
        `INSERT INTO landmarks (id, name, category, lat, lng) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category,
                                        lat = EXCLUDED.lat, lng = EXCLUDED.lng`,
        [l.id, l.name, l.category, l.pos[0], l.pos[1]]);

    for (const r of campus.routes) {
      await db.query(
        `INSERT INTO routes (id, name, color, total_length_m) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color,
                                        total_length_m = EXCLUDED.total_length_m`,
        [r.id, r.name, r.color, r.total]);

      await db.query("DELETE FROM route_points WHERE route_id = $1", [r.id]);
      await db.query(
        `INSERT INTO route_points (route_id, seq, lat, lng)
         SELECT $1, * FROM unnest($2::int[], $3::float8[], $4::float8[])`,
        [r.id, r.points.map((_, i) => i + 1), r.points.map((p) => p[0]), r.points.map((p) => p[1])]);

      const passes = Object.entries(r.stopPasses)
        .flatMap(([stopId, list]) => list.map((dist) => ({ stopId, dist })))
        .sort((a, b) => a.dist - b.dist);
      for (const p of passes)
        if (!stopIds.has(p.stopId)) throw new Error(`stopPasses references unknown stop "${p.stopId}"`);
      await db.query("DELETE FROM route_stops WHERE route_id = $1", [r.id]);
      for (const [i, p] of passes.entries())
        await db.query(
          `INSERT INTO route_stops (route_id, seq, stop_id, dist_along_route_m) VALUES ($1,$2,$3,$4)`,
          [r.id, i + 1, p.stopId, p.dist]);
    }

    await db.query(
      `INSERT INTO buses (id, name) VALUES ('bus-1', 'Bus 1') ON CONFLICT (id) DO NOTHING`);
    if (opts.devData) {
      // Known passwords, so they exist ONLY outside production (npm run seed passes devData=false there).
      // An existing row is touched only if it still has the Phase 2 placeholder hash, never a password someone chose.
      const dev = [
        { role: "DRIVER", name: "Dev Driver", email: "driver@example.com", password: DEV_DRIVER_PASSWORD },
        { role: "ADMIN", name: "Dev Admin", email: "admin@example.com", password: DEV_ADMIN_PASSWORD },
      ];
      for (const u of dev)
        await db.query(
          `INSERT INTO users (role, name, email, password_hash) VALUES ($1, $2, $3, $4)
           ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
             WHERE users.password_hash = 'DEV_ONLY_NOT_A_HASH'`,
          [u.role, u.name, u.email, await hashPassword(u.password)]);
      await db.query(
        `INSERT INTO driver_buses (driver_id, bus_id)
         SELECT id, 'bus-1' FROM users WHERE email = 'driver@example.com' ON CONFLICT DO NOTHING`);
    }
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
