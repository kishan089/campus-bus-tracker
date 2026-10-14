import { Router } from "express";
import { z } from "zod";
import type { Deps } from "../../deps";
import { AppError, guarded } from "../../http/errors";
import { audit } from "../../services/audit";
import {
  activeTripsOnRoute, ID_PATTERN, loadStops, recomputeRouteStops, refreshRouteModels, replacePoints, uniqueId, withTx,
} from "../../services/adminService";
import { analyzeRoute } from "../../services/routeBuilder";

const name = z.string().trim().min(1).max(80);
const idParam = z.string().regex(ID_PATTERN);
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
const points = z.array(z.tuple([lat, lng])).min(2, "A route needs at least 2 points").max(5000, "At most 5000 points");
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #2563eb");

const ROUTE_LIST = `
  SELECT r.id, r.name, r.color, r.active, r.total_length_m AS "totalLengthM",
         (SELECT count(*)::int FROM route_points p WHERE p.route_id = r.id) AS "pointCount",
         (SELECT count(*)::int FROM route_stops s WHERE s.route_id = r.id) AS "passCount",
         EXISTS (SELECT 1 FROM trips t WHERE t.route_id = r.id AND t.status = 'ACTIVE') AS "hasActiveTrip"
    FROM routes r`;

export function networkRouter(deps: Deps) {
  const r = Router();
  const { pool } = deps;
  const adminId = (req: any) => req.userId as number;

  // ---------------- stops ----------------
  r.get("/stops", async (_req, res) => {
    res.json((await pool.query(
      `SELECT s.id, s.name, s.lat, s.lng,
              COALESCE((SELECT array_agg(DISTINCT rs.route_id ORDER BY rs.route_id) FROM route_stops rs WHERE rs.stop_id = s.id), '{}') AS routes
         FROM stops s ORDER BY s.name`)).rows);
  });

  r.post("/stops", guarded(async (req, res) => {
    const b = z.object({ name, lat, lng, id: idParam.optional() }).parse(req.body);
    const id = await withTx(pool, async (c) => {
      const id = b.id ?? (await uniqueId(c, "stops", b.name));
      await c.query("INSERT INTO stops (id, name, lat, lng) VALUES ($1, $2, $3, $4)", [id, b.name, b.lat, b.lng]);
      await recomputeRouteStops(c); // the new stop may lie on existing routes
      return id;
    });
    refreshRouteModels(deps);
    await audit(pool, adminId(req), "stop.create", id, { name: b.name });
    res.status(201).json((await pool.query("SELECT id, name, lat, lng FROM stops WHERE id = $1", [id])).rows[0]);
  }));

  r.patch("/stops/:id", guarded(async (req, res) => {
    const b = z.object({ name: name.optional(), lat: lat.optional(), lng: lng.optional() }).parse(req.body);
    await withTx(pool, async (c) => {
      const u = await c.query(
        `UPDATE stops SET name = COALESCE($2, name), lat = COALESCE($3, lat), lng = COALESCE($4, lng) WHERE id = $1 RETURNING id`,
        [req.params.id, b.name ?? null, b.lat ?? null, b.lng ?? null]);
      if (!u.rows[0]) throw new AppError(404, "STOP_NOT_FOUND", "Unknown stop");
      await recomputeRouteStops(c); // moving a stop changes where along each route it is passed
    });
    refreshRouteModels(deps);
    await audit(pool, adminId(req), "stop.update", req.params.id, b);
    res.json((await pool.query("SELECT id, name, lat, lng FROM stops WHERE id = $1", [req.params.id])).rows[0]);
  }));

  r.delete("/stops/:id", guarded(async (req, res) => {
    await withTx(pool, async (c) => {
      await c.query("DELETE FROM route_stops WHERE stop_id = $1", [req.params.id]);
      const gone = await c.query("DELETE FROM stops WHERE id = $1 RETURNING id", [req.params.id]);
      if (!gone.rows[0]) throw new AppError(404, "STOP_NOT_FOUND", "Unknown stop");
    });
    refreshRouteModels(deps);
    await audit(pool, adminId(req), "stop.delete", req.params.id);
    res.status(204).end();
  }));

  // ---------------- routes ----------------
  r.get("/routes", async (_req, res) => { res.json((await pool.query(`${ROUTE_LIST} ORDER BY r.id`)).rows); });

  r.get("/routes/:id", async (req, res) => {
    const route = (await pool.query(`${ROUTE_LIST} WHERE r.id = $1`, [req.params.id])).rows[0];
    if (!route) throw new AppError(404, "ROUTE_NOT_FOUND", "Unknown route");
    const pts = (await pool.query("SELECT lat, lng FROM route_points WHERE route_id = $1 ORDER BY seq", [req.params.id])).rows;
    const passes = (await pool.query(
      `SELECT rs.seq, s.id AS "stopId", s.name, rs.dist_along_route_m AS s FROM route_stops rs JOIN stops s ON s.id = rs.stop_id
        WHERE rs.route_id = $1 ORDER BY rs.seq`, [req.params.id])).rows;
    res.json({ ...route, points: pts.map((p) => [p.lat, p.lng]), passes });
  });

  // Dry run: what would these points do? Nothing is saved.
  r.post("/routes/preview", async (req, res) => {
    const { points: pts } = z.object({ points }).parse(req.body);
    res.json({ pointCount: pts.length, ...analyzeRoute(pts, await loadStops(pool)) });
  });

  r.post("/routes", guarded(async (req, res) => {
    const b = z.object({ name, points, color: color.optional(), id: idParam.optional() }).parse(req.body);
    const id = await withTx(pool, async (c) => {
      const id = b.id ?? (await uniqueId(c, "routes", b.name));
      const a = analyzeRoute(b.points, await loadStops(c));
      await c.query("INSERT INTO routes (id, name, color, total_length_m) VALUES ($1, $2, $3, $4)", [id, b.name, b.color ?? "#2563eb", a.totalLengthM]);
      await replacePoints(c, id, b.points);
      await recomputeRouteStops(c, id);
      return id;
    });
    refreshRouteModels(deps);
    await audit(pool, adminId(req), "route.create", id, { name: b.name, points: b.points.length });
    res.status(201).json((await pool.query(`${ROUTE_LIST} WHERE r.id = $1`, [id])).rows[0]);
  }));

  r.put("/routes/:id", guarded(async (req, res) => {
    const b = z.object({ name: name.optional(), color: color.optional(), active: z.boolean().optional(), points: points.optional() }).parse(req.body);
    const id = req.params.id as string;
    if (!(await pool.query("SELECT 1 FROM routes WHERE id = $1", [id])).rows[0]) throw new AppError(404, "ROUTE_NOT_FOUND", "Unknown route");
    // A bus part-way round the old path has no meaningful place on a new one.
    if ((b.points || b.active === false) && (await activeTripsOnRoute(pool, id)) > 0)
      throw new AppError(409, "ROUTE_IN_USE", "A trip is running on this route. End it before changing the path or switching the route off.");
    await withTx(pool, async (c) => {
      await c.query("UPDATE routes SET name = COALESCE($2, name), color = COALESCE($3, color), active = COALESCE($4, active) WHERE id = $1",
        [id, b.name ?? null, b.color ?? null, b.active ?? null]);
      if (b.points) { await replacePoints(c, id, b.points); await recomputeRouteStops(c, id); }
    });
    refreshRouteModels(deps);
    await audit(pool, adminId(req), b.points ? "route.update-path" : "route.update", id, { ...b, points: b.points?.length });
    res.json((await pool.query(`${ROUTE_LIST} WHERE r.id = $1`, [id])).rows[0]);
  }));

  r.delete("/routes/:id", guarded(async (req, res) => {
    const gone = await pool.query("DELETE FROM routes WHERE id = $1 RETURNING id", [req.params.id]); // trips reference it: 23503 -> 409
    if (!gone.rows[0]) throw new AppError(404, "ROUTE_NOT_FOUND", "Unknown route");
    refreshRouteModels(deps);
    await audit(pool, adminId(req), "route.delete", req.params.id);
    res.status(204).end();
  }));

  return r;
}
