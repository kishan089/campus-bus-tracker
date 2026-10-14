import { Router } from "express";
import { z } from "zod";
import type { Deps } from "../deps";
import { requireDriver } from "../http/auth";
import { rateLimit } from "../security/rateLimit";
import { markActivity } from "../services/activity";
import { getActiveTripView } from "../repositories/trips";
import { endTrip, ingestLocation, startTrip } from "../services/tripService";
import { broadcast } from "../websocket";

const startSchema = z.object({ busId: z.string().min(1).max(64), routeId: z.string().min(1).max(64) });

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  speed: z.number().min(0).max(100).nullish(),      // m/s
  accuracy: z.number().min(0).nullish(),            // m
  heading: z.number().min(0).max(360).nullish(),    // degrees
  ts: z.number().int().positive(),                  // epoch ms
});

export function tripsRouter(deps: Deps) {
  const r = Router();
  const auth = requireDriver(deps);

  r.get("/trips/active", auth, async (req, res) => {
    res.json({ trip: await getActiveTripView(deps.pool, req.driverId!) });
  });

  r.post("/trips/start", auth, async (req, res) => {
    const b = startSchema.parse(req.body);
    markActivity(deps);
    const trip = await startTrip(deps.pool, req.driverId!, b.busId, b.routeId);
    broadcast.tripStarted(deps, b.busId, b.routeId, trip.tripId);
    res.status(201).json(trip);
  });

  r.post("/trips/end", auth, async (req, res) => {
    const trip = await endTrip(deps.pool, req.driverId!);
    broadcast.tripEnded(deps, trip.busId);
    res.json(trip);
  });

  const perDriver = rateLimit(deps, { name: "loc", max: deps.config.limits.locationPerMin, key: (req) => (req.driverId ? String(req.driverId) : undefined) });
  r.post("/location", auth, perDriver, async (req, res) => {
    const now = new Date();
    const { trip, fix, progress } = await ingestLocation(deps, req.driverId!, locationSchema.parse(req.body), now);
    broadcast.location(deps, {
      busId: trip.busId, lat: fix.lat, lng: fix.lng, speed: fix.speed ?? null,
      accuracy: fix.accuracy ?? null, heading: fix.heading ?? null, ts: fix.ts, receivedAt: now.toISOString(), progress,
    });
    res.status(204).end();
  });
  return r;
}
