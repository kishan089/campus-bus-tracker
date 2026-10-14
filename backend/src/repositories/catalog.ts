import type { Db } from "../db";

const ROUTE_COLS = `id, name, color, total_length_m AS "totalLengthM"`;

export async function listRoutes(db: Db) {
  return (await db.query(`SELECT ${ROUTE_COLS} FROM routes WHERE active ORDER BY id`)).rows;
}

export async function getRoute(db: Db, id: string) {
  const r = await db.query(`SELECT ${ROUTE_COLS} FROM routes WHERE id = $1 AND active`, [id]);
  if (!r.rows[0]) return null;
  const pts = await db.query(`SELECT lat, lng FROM route_points WHERE route_id = $1 ORDER BY seq`, [id]);
  const stops = await db.query(
    `SELECT rs.seq, s.id AS "stopId", s.name, s.lat, s.lng, rs.dist_along_route_m AS "distAlongRouteM"
       FROM route_stops rs JOIN stops s ON s.id = rs.stop_id
      WHERE rs.route_id = $1 ORDER BY rs.seq`, [id]);
  return { ...r.rows[0], points: pts.rows.map((p) => [p.lat, p.lng]), stops: stops.rows };
}

export async function listStops(db: Db) {
  return (await db.query(`SELECT id, name, lat, lng FROM stops ORDER BY name`)).rows;
}

export async function listLandmarks(db: Db) {
  return (await db.query(`SELECT id, name, category, lat, lng FROM landmarks ORDER BY name`)).rows;
}
