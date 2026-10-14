import { Router } from "express";
import type { Deps } from "../deps";
import { AppError } from "../http/errors";
import { listBusRows } from "../repositories/buses";
import { busViews } from "../services/busViews";
import { overlayRedisLocations } from "./buses";

export function arrivalsRouter(deps: Deps) {
  const r = Router();
  // Which buses are heading to this stop, soonest first. Only buses with a live position are listed.
  r.get("/stops/:id/arrivals", async (req, res) => {
    const stop = await deps.pool.query("SELECT id, name FROM stops WHERE id = $1", [req.params.id]);
    if (!stop.rows[0]) throw new AppError(404, "STOP_NOT_FOUND", "Unknown stop");
    const now = new Date();
    const views = await busViews(deps, await overlayRedisLocations(deps, await listBusRows(deps.pool)), now);
    const arrivals = views.flatMap((v) => {
      const e = v.progress?.etas[stop.rows[0].id];
      if (!e || !v.location) return [];
      return [{
        busId: v.id, busName: v.name, status: v.status,
        etaSeconds: Math.max(0, Math.round(e.etaSeconds - v.location.ageSeconds)), // the fix is already a few seconds old
        metres: e.metres, justPassed: e.justPassed, behindM: e.behindM, headingTo: e.headingTo,
        ageSeconds: v.location.ageSeconds,
      }];
    }).sort((a, b) => a.etaSeconds - b.etaSeconds);
    res.json({ stopId: stop.rows[0].id, stopName: stop.rows[0].name, arrivals });
  });
  return r;
}
