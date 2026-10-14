import type { Pool } from "pg";
import type { Deps } from "../deps";
import { AppError } from "../http/errors";
import { isAssigned } from "../repositories/auth";
import { haversine } from "../geo/geo";
import { redisReady } from "../redis";
import { markActivity } from "./activity";
import { advanceProgress, buildProgressView, type BusProgressView } from "./progress";
import { modelOrNull } from "./busViews";
import { endActiveTrip, getActiveTripWithLastFix, insertLocation, insertTrip } from "../repositories/trips";

export async function startTrip(db: Pool, driverId: number, busId: string, routeId: string) {
  const bus = await db.query("SELECT active FROM buses WHERE id = $1", [busId]);
  if (!bus.rows[0]) throw new AppError(404, "BUS_NOT_FOUND", "Unknown bus");
  if (!bus.rows[0].active) throw new AppError(409, "BUS_DISABLED", "This bus is disabled");
  if (!(await isAssigned(db, driverId, busId))) throw new AppError(403, "BUS_NOT_ASSIGNED", "You are not assigned to this bus");
  const route = await db.query("SELECT 1 FROM routes WHERE id = $1 AND active", [routeId]);
  if (!route.rows[0]) throw new AppError(404, "ROUTE_NOT_FOUND", "Unknown route");
  try {
    return await insertTrip(db, busId, driverId, routeId);
  } catch (e: any) {
    if (e.code === "23505") { // unique violation on the partial indexes
      if (e.constraint === "one_active_trip_per_driver")
        throw new AppError(409, "DRIVER_HAS_ACTIVE_TRIP", "You already have an active trip");
      throw new AppError(409, "BUS_ALREADY_ACTIVE", "This bus already has an active trip");
    }
    throw e;
  }
}

export async function endTrip(db: Pool, driverId: number) {
  const trip = await endActiveTrip(db, driverId);
  if (!trip) throw new AppError(404, "NO_ACTIVE_TRIP", "No active trip to end");
  return trip;
}

export interface Fix {
  lat: number; lng: number; speed?: number | null; accuracy?: number | null; heading?: number | null;
  ts: number; // epoch milliseconds (what navigator.geolocation reports)
}

export async function ingestLocation(deps: Deps, driverId: number, fix: Fix, now: Date) {
  const skewMs = fix.ts - now.getTime();
  if (skewMs > deps.config.gps.maxFutureSkewS * 1000) throw new AppError(422, "INVALID_TIMESTAMP", "Timestamp is in the future");
  if (-skewMs > deps.config.gps.maxPastSkewS * 1000) throw new AppError(422, "INVALID_TIMESTAMP", "Timestamp is too old");
  if (fix.accuracy != null && fix.accuracy > deps.config.gps.maxAccuracyM)
    throw new AppError(422, "ACCURACY_TOO_LOW", `GPS accuracy worse than ${deps.config.gps.maxAccuracyM} m`);
  // the bus comes from the driver's active trip, never from the request body
  markActivity(deps); // a driver is talking to us: background jobs should be awake
  const trip = await getActiveTripWithLastFix(deps.pool, driverId);
  if (!trip) throw new AppError(409, "NO_ACTIVE_TRIP", "Start a trip before sending locations");

  // A fix that implies the bus travelled faster than any bus could since the last one is a GPS glitch or a spoof: refuse it
  // rather than let it move the bus on every student's map. Only checked against a recent fix, so one bad reading can't
  // make every later (correct) one look like a jump.
  const prev = trip.last;
  if (prev) {
    const dt = (fix.ts - prev.recordedAtMs) / 1000;
    if (dt > 0 && dt <= 120) {
      const dist = haversine([prev.lat, prev.lng], [fix.lat, fix.lng]);
      if (dist > 100 && dist / dt > deps.config.ops.maxJumpSpeedMps)
        throw new AppError(422, "IMPLAUSIBLE_JUMP", `Position moved ${Math.round(dist)} m in ${Math.round(dt)} s`);
    }
  }

  // Where on the route is the bus, and how fast is it cruising? Never allowed to block storing the fix itself.
  let state: ReturnType<typeof advanceProgress> | null = null;
  let progress: BusProgressView | null = null;
  const model = await modelOrNull(deps, trip.routeId);
  if (model) {
    state = advanceProgress(model, trip.last, { lat: fix.lat, lng: fix.lng, speed: fix.speed, tsMs: fix.ts }, deps.config.eta);
    progress = buildProgressView(model, state, deps.config.eta);
  }
  await insertLocation(deps.pool, trip.id, trip.busId, fix, state);

  if (redisReady(deps.redisPub)) {
    const loc = {
      locTripId: trip.id, lat: fix.lat, lng: fix.lng, speed: fix.speed, accuracy: fix.accuracy,
      heading: fix.heading, recordedAt: new Date(fix.ts).toISOString(), receivedAt: now.toISOString(),
      progressM: state?.s ?? null, offRouteM: state?.offRouteM ?? null, speedEstMps: state?.speedEstMps ?? null,
    };
    // keep in redis for up to 24h as a fallback
    await deps.redisPub.setex(`bus:${trip.busId}:location`, 86400, JSON.stringify(loc))
      .catch((e: Error) => deps.log.warn({ err: e.message }, "redis set failed"));
  }

  return { trip, fix, progress };
}
