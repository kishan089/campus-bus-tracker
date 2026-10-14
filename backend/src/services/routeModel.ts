import type { Db } from "../db";
import { buildPath, type LatLng, type Path } from "../geo/geo";

export interface StopPass { stopId: string; name: string; s: number }

export interface RouteModel {
  id: string;
  path: Path;
  passes: StopPass[];            // every time the route passes a stop, in route order
  turnaroundS: number | null;    // out-and-back routes: progress of the stop visited once in the middle
  turnaroundName: string | null;
  terminalName: string | null;   // where the return leg ends (the first stop)
}

export function buildRouteModel(id: string, points: LatLng[], passes: StopPass[]): RouteModel {
  const path = buildPath(points);
  const sorted = [...passes].sort((a, b) => a.s - b.s);
  const count = new Map<string, number>();
  for (const p of sorted) count.set(p.stopId, (count.get(p.stopId) ?? 0) + 1);
  const middleOnce = sorted.filter((p) => count.get(p.stopId) === 1 && p.s > 5 && p.s < path.total - 5);
  const turn = middleOnce.length === 1 ? middleOnce[0] : null; // exactly one => out-and-back
  return {
    id, path, passes: sorted,
    turnaroundS: turn?.s ?? null, turnaroundName: turn?.name ?? null,
    terminalName: turn && sorted[0] ? sorted[0].name : null,
  };
}

async function load(db: Db, id: string): Promise<RouteModel | null> {
  const route = await db.query("SELECT 1 FROM routes WHERE id = $1 AND active", [id]);
  if (!route.rows[0]) return null;
  const pts = await db.query("SELECT lat, lng FROM route_points WHERE route_id = $1 ORDER BY seq", [id]);
  const stops = await db.query(
    `SELECT rs.stop_id AS "stopId", s.name, rs.dist_along_route_m AS s
       FROM route_stops rs JOIN stops s ON s.id = rs.stop_id WHERE rs.route_id = $1 ORDER BY rs.seq`, [id]);
  return buildRouteModel(id, pts.rows.map((p) => [p.lat, p.lng] as LatLng), stops.rows);
}

/** Routes change rarely, so each process keeps them in memory and re-reads every few minutes. */
export class RouteModelCache {
  private entries = new Map<string, { model: RouteModel | null; at: number }>();
  private db: Db;
  private ttlMs: number;
  constructor(db: Db, ttlMs = 5 * 60_000) { this.db = db; this.ttlMs = ttlMs; }

  async get(routeId: string): Promise<RouteModel | null> {
    const hit = this.entries.get(routeId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.model;
    const model = await load(this.db, routeId);
    this.entries.set(routeId, { model, at: Date.now() });
    return model;
  }
  invalidate() { this.entries.clear(); }
}
