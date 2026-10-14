import { routeCache, type Deps } from "../deps";
import type { BusRow } from "../repositories/buses";
import { buildProgressView, type BusProgressView } from "./progress";
import { toBusView } from "./busStatus";
import type { RouteModel } from "./routeModel";

/** A route lookup that never throws: ETA is an extra, so a failed lookup must not take a fix or a bus list down with it. */
export async function modelOrNull(deps: Deps, routeId: string): Promise<RouteModel | null> {
  try { return await routeCache(deps).get(routeId); }
  catch (e) { deps.log.warn({ err: (e as Error).message, routeId }, "route model unavailable, skipping progress/ETA"); return null; }
}

/**
 * Bus views plus route progress and ETAs. Progress is only attached while the bus is LIVE or DELAYED:
 * an ETA computed from a position that may be minutes old would be a promise nobody can keep.
 */
export async function busViews(deps: Deps, rows: BusRow[], now: Date) {
  return Promise.all(rows.map(async (row) => {
    const view = toBusView(row, now, deps.config.status);
    let progress: BusProgressView | null = null;
    if ((view.status === "LIVE" || view.status === "DELAYED") && row.routeId && row.progressM != null) {
      const model = await modelOrNull(deps, row.routeId);
      if (model) {
        progress = buildProgressView(model, {
          s: row.progressM, offRouteM: row.offRouteM ?? 0, speedEstMps: row.speedEstMps ?? deps.config.eta.defaultSpeedMps,
        }, deps.config.eta);
      }
    }
    return { ...view, progress };
  }));
}
