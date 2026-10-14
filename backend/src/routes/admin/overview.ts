import { Router } from "express";
import type { Deps } from "../../deps";
import { listBusRows } from "../../repositories/buses";
import { redisReady } from "../../redis";
import { busViews } from "../../services/busViews";
import { recentAudit } from "../../services/audit";
import { overlayRedisLocations } from "../buses";

export function overviewRouter(deps: Deps) {
  const r = Router();
  const { pool } = deps;

  r.get("/overview", async (req, res) => {
    const now = new Date();
    const views = await busViews(deps, await overlayRedisLocations(deps, await listBusRows(pool)), now);

    const trips = (await pool.query(
      `SELECT t.id, t.bus_id AS "busId", b.name AS "busName", t.driver_id AS "driverId", u.name AS "driverName",
              t.route_id AS "routeId", t.started_at AS "startedAt"
         FROM trips t JOIN buses b ON b.id = t.bus_id JOIN users u ON u.id = t.driver_id
        WHERE t.status = 'ACTIVE' ORDER BY t.started_at`)).rows;

    // GPS health over the last 5 minutes, per bus
    const health = new Map((await pool.query(
      `SELECT bus_id AS "busId", count(*)::int AS fixes, avg(accuracy)::float AS "avgAccuracyM",
              CASE WHEN count(*) > 1 THEN extract(epoch FROM max(received_at) - min(received_at)) / (count(*) - 1) END AS "avgIntervalS",
              max(off_route_m)::float AS "maxOffRouteM"
         FROM gps_locations WHERE received_at > now() - interval '5 minutes' GROUP BY bus_id`)).rows.map((h) => [h.busId, h]));

    const driverOf = new Map(trips.map((t) => [t.busId, { id: t.driverId, name: t.driverName }]));
    const buses = views.map((v) => {
      const h = health.get(v.id);
      return {
        id: v.id, name: v.name, status: v.status, routeId: v.routeId, tripId: v.tripId,
        driver: driverOf.get(v.id) ?? null,
        speedKmh: v.location?.speed != null ? Math.round(v.location.speed * 3.6) : null,
        ageSeconds: v.location?.ageSeconds ?? null,
        lastSeenAt: v.lastSeenAt,
        position: v.location ? { lat: v.location.lat, lng: v.location.lng } : null,
        health: h ? {
          fixes: h.fixes, avgIntervalS: h.avgIntervalS === null ? null : Math.round(h.avgIntervalS * 10) / 10,
          avgAccuracyM: h.avgAccuracyM === null ? null : Math.round(h.avgAccuracyM),
          maxOffRouteM: h.maxOffRouteM === null ? null : Math.round(h.maxOffRouteM),
        } : null,
      };
    });

    const live = new Set(["LIVE", "DELAYED"]);
    const liveBusIds = new Set(buses.filter((b) => live.has(b.status)).map((b) => b.id));
    const fixesLastHour = (await pool.query("SELECT count(*)::int AS n FROM gps_locations WHERE received_at > now() - interval '1 hour'")).rows[0].n;

    res.json({
      serverTime: now.toISOString(),
      yourAddress: req.ip ?? null, // compare with your real public IP: if they differ, TRUST_PROXY_HOPS is wrong
      stats: {
        totalBuses: buses.length,
        activeBuses: buses.filter((b) => live.has(b.status)).length,
        disabledBuses: buses.filter((b) => b.status === "DISABLED").length,
        activeTrips: trips.length,
        onlineDrivers: trips.filter((t) => liveBusIds.has(t.busId)).length, // a driver whose bus is reporting right now
        connectedViewers: deps.io?.engine.clientsCount ?? 0,
        fixesLastHour,
      },
      system: {
        db: "up", // this query just ran
        redis: deps.redisPub ? (redisReady(deps.redisPub) ? "up" : "down") : "not configured",
        uptimeSeconds: Math.round(process.uptime()),
        wsConnections: deps.io?.engine.clientsCount ?? 0,
        api: deps.metrics?.snapshot() ?? null,
      },
      buses,
      trips,
      audit: await recentAudit(pool, 15),
    });
  });

  return r;
}
