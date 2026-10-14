import type { Deps } from "../deps";
import { broadcast } from "../websocket";

/**
 * Ends trips whose driver has gone silent (phone died, browser closed, lost signal for good), so the bus is not stuck
 * "in use" and students don't see a dead bus as running. The end time is the last fix, not the moment of cleanup.
 * One atomic UPDATE: if several servers run this, each trip is closed (and announced) by exactly one of them.
 */
export async function closeStaleTrips(deps: Deps): Promise<{ id: number; busId: string }[]> {
  const { rows } = await deps.pool.query(
    `UPDATE trips t
        SET status = 'COMPLETED', end_reason = 'AUTO_TIMEOUT',
            ended_at = COALESCE((SELECT max(received_at) FROM gps_locations g WHERE g.trip_id = t.id), t.started_at)
      WHERE t.status = 'ACTIVE'
        AND COALESCE((SELECT max(received_at) FROM gps_locations g WHERE g.trip_id = t.id), t.started_at)
            < now() - ($1::float8 * interval '1 second')
  RETURNING t.id, t.bus_id AS "busId"`, [deps.config.ops.staleTripMinutes * 60]);
  for (const r of rows) {
    broadcast.tripEnded(deps, r.busId);
    deps.log.info({ tripId: r.id, busId: r.busId }, "closed a trip whose driver went silent");
  }
  return rows;
}

/** GPS history is the biggest table by far. Keeps the last N days and removes the rest in small batches. */
export async function purgeOldFixes(deps: Deps, batch = 5000, maxBatches = 20): Promise<number> {
  let removed = 0;
  for (let i = 0; i < maxBatches; i++) {
    const r = await deps.pool.query(
      `DELETE FROM gps_locations WHERE id IN (
         SELECT id FROM gps_locations WHERE received_at < now() - ($1::float8 * interval '1 day') ORDER BY id LIMIT $2)`,
      [deps.config.ops.gpsRetentionDays, batch]);
    removed += r.rowCount ?? 0;
    if ((r.rowCount ?? 0) < batch) break;
  }
  if (removed) deps.log.info({ removed, keepDays: deps.config.ops.gpsRetentionDays }, "purged old GPS fixes");
  return removed;
}

export function startJanitor(deps: Deps) {
  let running = false;
  let lastPurge = 0;
  let sweepNeeded = true; // the first run after boot always sweeps: a restart may have left trips behind
  const DAY = 24 * 3_600_000;
  const tick = async () => {
    if (running) return; // a slow run must not overlap the next one
    // Nothing can have gone stale since the last sweep unless a trip started or a fix arrived within the stale window.
    // Staying quiet then lets a scale-to-zero database sleep; the run that ends the window is the final sweep.
    const quietFor = Date.now() - (deps.activityAt ?? 0);
    const windowMs = (deps.config.ops.staleTripMinutes + 1) * 60_000;
    if (quietFor > windowMs && !sweepNeeded) return;
    running = true;
    try {
      await closeStaleTrips(deps);
      sweepNeeded = quietFor <= windowMs;
      if (Date.now() - lastPurge > DAY) { lastPurge = Date.now(); await purgeOldFixes(deps); }
    } catch (e) {
      deps.log.error({ err: (e as Error).message }, "janitor run failed"); // never takes the server down
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, deps.config.ops.janitorIntervalS * 1000);
  timer.unref();
  void tick();
  return { stop: () => clearInterval(timer), runOnce: tick };
}
