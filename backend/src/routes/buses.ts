import { Router } from "express";
import type { Deps } from "../deps";
import { AppError } from "../http/errors";
import { getBusRow, listBusRows, type BusRow } from "../repositories/buses";
import { redisReady } from "../redis";
import { busViews } from "../services/busViews";

export async function overlayRedisLocations(deps: Deps, rows: BusRow[]) {
  if (!redisReady(deps.redisPub) || rows.length === 0) return rows;
  try {
    const keys = rows.map((r) => `bus:${r.id}:location`);
    const cached = await deps.redisPub.mget(keys);
    return rows.map((row, i) => {
      if (!cached[i]) return row;
      try {
        const loc = JSON.parse(cached[i]!);
        return {
          ...row,
          locTripId: loc.locTripId ?? row.locTripId,
          lat: loc.lat, lng: loc.lng, speed: loc.speed, accuracy: loc.accuracy, heading: loc.heading,
          recordedAt: new Date(loc.recordedAt), receivedAt: new Date(loc.receivedAt),
          progressM: loc.progressM ?? null, offRouteM: loc.offRouteM ?? null, speedEstMps: loc.speedEstMps ?? null,
        };
      } catch { return row; }
    });
  } catch (e: any) {
    deps.log.warn({ err: e.message }, "redis mget failed");
    return rows;
  }
}

export function busesRouter(deps: Deps) {
  const r = Router();
  r.get("/", async (_req, res) => {
    const now = new Date();
    const rows = await overlayRedisLocations(deps, await listBusRows(deps.pool));
    res.json(await busViews(deps, rows, now));
  });
  r.get("/:id/location", async (req, res) => {
    const row = await getBusRow(deps.pool, req.params.id);
    if (!row) throw new AppError(404, "BUS_NOT_FOUND", "Unknown bus");
    const [overlaid] = await overlayRedisLocations(deps, [row]);
    const [{ id, status, lastSeenAt, location, progress }] = await busViews(deps, [overlaid], new Date());
    res.json({ id, status, lastSeenAt, location, progress });
  });
  return r;
}
