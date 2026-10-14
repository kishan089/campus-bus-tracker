import { Router } from "express";
import { z } from "zod";
import type { Deps } from "../../deps";
import { haversine, type LatLng } from "../../geo/geo";
import { AppError, guarded } from "../../http/errors";
import { intParam } from "../../http/params";
import { audit, recentAudit } from "../../services/audit";
import { broadcast } from "../../websocket";

const TRIP_SQL = `
  SELECT t.id, t.bus_id AS "busId", b.name AS "busName", t.driver_id AS "driverId", u.name AS "driverName",
         t.route_id AS "routeId", r.name AS "routeName", t.status,
         t.started_at AS "startedAt", t.ended_at AS "endedAt", t.end_reason AS "endReason",
         extract(epoch FROM coalesce(t.ended_at, now()) - t.started_at)::int AS "durationS",
         (SELECT count(*)::int FROM gps_locations g WHERE g.trip_id = t.id) AS "fixCount",
         (SELECT max(received_at) FROM gps_locations g WHERE g.trip_id = t.id) AS "lastFixAt"
    FROM trips t JOIN buses b ON b.id = t.bus_id JOIN users u ON u.id = t.driver_id JOIN routes r ON r.id = t.route_id`;

const MAX_TRAIL_POINTS = 1500;
const GAP_S = 30; // no fix for this long inside a trip counts as a GPS dropout

export function tripsAdminRouter(deps: Deps) {
  const r = Router();
  const { pool } = deps;
  const adminId = (req: any) => req.userId as number;

  r.get("/trips", async (req, res) => {
    const q = z.object({
      status: z.enum(["ACTIVE", "COMPLETED"]).optional(),
      busId: z.string().max(64).optional(),
      driverId: z.coerce.number().int().positive().optional(),
      before: z.coerce.number().int().positive().optional(),   // paging: trips older than this id
      limit: z.coerce.number().int().min(1).max(100).default(25),
    }).parse(req.query);
    const rows = (await pool.query(
      `${TRIP_SQL}
        WHERE ($1::text IS NULL OR t.status = $1) AND ($2::text IS NULL OR t.bus_id = $2)
          AND ($3::bigint IS NULL OR t.driver_id = $3) AND ($4::bigint IS NULL OR t.id < $4)
        ORDER BY t.id DESC LIMIT $5`,
      [q.status ?? null, q.busId ?? null, q.driverId ?? null, q.before ?? null, q.limit])).rows;
    res.json({ trips: rows, nextBefore: rows.length === q.limit ? rows[rows.length - 1].id : null });
  });

  r.get("/trips/:id", async (req, res) => {
    const id = intParam(req);
    const trip = (await pool.query(`${TRIP_SQL} WHERE t.id = $1`, [id])).rows[0];
    if (!trip) throw new AppError(404, "TRIP_NOT_FOUND", "Unknown trip");
    const pts = (await pool.query(
      `SELECT lat, lng, speed, accuracy, recorded_at AS "at" FROM gps_locations WHERE trip_id = $1 ORDER BY recorded_at, id LIMIT 50000`, [id])).rows;

    let distanceM = 0, maxSpeed = 0, gaps = 0, longestGapS = 0, accSum = 0, accN = 0;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].speed != null) maxSpeed = Math.max(maxSpeed, pts[i].speed);
      if (pts[i].accuracy != null) { accSum += pts[i].accuracy; accN++; }
      if (i === 0) continue;
      distanceM += haversine([pts[i - 1].lat, pts[i - 1].lng] as LatLng, [pts[i].lat, pts[i].lng] as LatLng);
      const gap = (new Date(pts[i].at).getTime() - new Date(pts[i - 1].at).getTime()) / 1000;
      if (gap > GAP_S) { gaps++; longestGapS = Math.max(longestGapS, Math.round(gap)); }
    }
    const span = pts.length > 1 ? (new Date(pts[pts.length - 1].at).getTime() - new Date(pts[0].at).getTime()) / 1000 : 0;
    const step = Math.max(1, Math.ceil(pts.length / MAX_TRAIL_POINTS)); // thin the trail for the map; stats above use every fix

    res.json({
      ...trip,
      stats: {
        distanceM: Math.round(distanceM),
        avgSpeedKmh: span > 0 ? Math.round((distanceM / span) * 3.6 * 10) / 10 : null,
        maxSpeedKmh: Math.round(maxSpeed * 3.6),
        avgAccuracyM: accN ? Math.round(accSum / accN) : null,
        gaps, longestGapS,
      },
      trail: pts.filter((_, i) => i % step === 0).map((p) => [p.lat, p.lng]),
    });
  });

  // For a trip whose driver vanished (phone died, browser closed): ends it so the bus can be used again.
  r.post("/trips/:id/end", guarded(async (req, res) => {
    const id = intParam(req);
    const ended = (await pool.query(
      `UPDATE trips SET status = 'COMPLETED', ended_at = now(), end_reason = 'ADMIN' WHERE id = $1 AND status = 'ACTIVE' RETURNING id, bus_id AS "busId"`, [id])).rows[0];
    if (!ended) {
      if (!(await pool.query("SELECT 1 FROM trips WHERE id = $1", [id])).rows[0]) throw new AppError(404, "TRIP_NOT_FOUND", "Unknown trip");
      throw new AppError(409, "TRIP_NOT_ACTIVE", "This trip has already ended");
    }
    broadcast.tripEnded(deps, ended.busId); // students' maps update at once
    await audit(pool, adminId(req), "trip.force-end", String(id), { busId: ended.busId });
    res.json({ tripId: id });
  }));

  r.get("/audit", async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit);
    res.json(await recentAudit(pool, limit));
  });

  return r;
}
