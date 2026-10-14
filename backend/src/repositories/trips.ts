import type { Db } from "../db";

export async function insertTrip(db: Db, busId: string, driverId: number, routeId: string) {
  const { rows } = await db.query(
    `INSERT INTO trips (bus_id, driver_id, route_id) VALUES ($1, $2, $3)
     RETURNING id AS "tripId", bus_id AS "busId", route_id AS "routeId", status, started_at AS "startedAt"`,
    [busId, driverId, routeId]);
  return rows[0];
}

export async function endActiveTrip(db: Db, driverId: number) {
  const { rows } = await db.query(
    `UPDATE trips SET status = 'COMPLETED', ended_at = now(), end_reason = 'DRIVER'
      WHERE driver_id = $1 AND status = 'ACTIVE'
  RETURNING id AS "tripId", bus_id AS "busId", ended_at AS "endedAt"`, [driverId]);
  return rows[0] ?? null;
}

export async function getActiveTripForDriver(db: Db, driverId: number) {
  const { rows } = await db.query<{ id: number; busId: string; routeId: string }>(
    `SELECT id, bus_id AS "busId", route_id AS "routeId" FROM trips WHERE driver_id = $1 AND status = 'ACTIVE'`,
    [driverId]);
  return rows[0] ?? null;
}

export async function insertLocation(
  db: Db, tripId: number, busId: string,
  f: { lat: number; lng: number; speed?: number | null; accuracy?: number | null; heading?: number | null; ts: number },
  p: { s: number; offRouteM: number; speedEstMps: number } | null = null) {
  await db.query(
    `INSERT INTO gps_locations (trip_id, bus_id, lat, lng, speed, accuracy, heading, recorded_at,
                                route_progress_m, off_route_m, speed_est_mps)
     VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8::float8 / 1000), $9, $10, $11)`,
    [tripId, busId, f.lat, f.lng, f.speed ?? null, f.accuracy ?? null, f.heading ?? null, f.ts,
     p?.s ?? null, p?.offRouteM ?? null, p?.speedEstMps ?? null]);
}

/** The driver's active trip plus its latest fix that has progress (what the next fix is snapped relative to). */
export async function getActiveTripWithLastFix(db: Db, driverId: number) {
  const { rows } = await db.query(
    `SELECT t.id, t.bus_id AS "busId", t.route_id AS "routeId",
            l.route_progress_m AS "progressM", l.off_route_m AS "offRouteM",
            l.speed_est_mps AS "speedEstMps", l.recorded_at AS "recordedAt", l.lat, l.lng
       FROM trips t
       LEFT JOIN LATERAL (
         SELECT route_progress_m, off_route_m, speed_est_mps, recorded_at, lat, lng
           FROM gps_locations g
          WHERE g.trip_id = t.id AND g.route_progress_m IS NOT NULL
          ORDER BY g.recorded_at DESC, g.id DESC LIMIT 1) l ON true
      WHERE t.driver_id = $1 AND t.status = 'ACTIVE'`, [driverId]);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id as number, busId: r.busId as string, routeId: r.routeId as string,
    last: r.progressM === null ? null : {
      s: r.progressM as number, offRouteM: (r.offRouteM ?? 0) as number,
      recordedAtMs: new Date(r.recordedAt).getTime(), speedEstMps: r.speedEstMps as number | null,
      lat: r.lat as number, lng: r.lng as number,
    },
  };
}

export async function getActiveTripView(db: Db, driverId: number) {
  const { rows } = await db.query(
    `SELECT id AS "tripId", bus_id AS "busId", route_id AS "routeId", started_at AS "startedAt"
       FROM trips WHERE driver_id = $1 AND status = 'ACTIVE'`, [driverId]);
  return rows[0] ?? null;
}
