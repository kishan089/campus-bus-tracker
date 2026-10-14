import type { BusRow } from "../repositories/buses";

export type BusStatus =
  | "DISABLED" | "NOT_OPERATING" | "LOCATION_UNAVAILABLE"
  | "LIVE" | "DELAYED" | "POSSIBLY_OFFLINE" | "OFFLINE";

export interface StatusThresholds { liveS: number; delayedS: number; offlineS: number }

export function computeBusStatus(
  i: { active: boolean; hasActiveTrip: boolean; lastReceivedAt: Date | null },
  now: Date, t: StatusThresholds): BusStatus {
  if (!i.active) return "DISABLED";
  if (!i.hasActiveTrip) return "NOT_OPERATING";
  if (!i.lastReceivedAt) return "LOCATION_UNAVAILABLE";
  const age = (now.getTime() - i.lastReceivedAt.getTime()) / 1000;
  if (age < t.liveS) return "LIVE";
  if (age < t.delayedS) return "DELAYED";
  if (age < t.offlineS) return "POSSIBLY_OFFLINE";
  return "OFFLINE";
}

const SHOWS_LOCATION = new Set<BusStatus>(["LIVE", "DELAYED", "POSSIBLY_OFFLINE", "OFFLINE"]);

export function toBusView(row: BusRow, now: Date, t: StatusThresholds) {
  const hasActiveTrip = row.tripId !== null;
  // a fix left over from a previous trip is not a fix for the current one
  const fixIsCurrent = row.receivedAt !== null && (!hasActiveTrip || row.locTripId === row.tripId);
  const status = computeBusStatus(
    { active: row.active, hasActiveTrip, lastReceivedAt: fixIsCurrent ? row.receivedAt : null }, now, t);
  const location = SHOWS_LOCATION.has(status) && row.receivedAt && row.recordedAt
    ? {
        lat: row.lat!, lng: row.lng!, speed: row.speed, accuracy: row.accuracy, heading: row.heading,
        recordedAt: row.recordedAt.toISOString(), receivedAt: row.receivedAt.toISOString(),
        ageSeconds: Math.max(0, Math.round((now.getTime() - row.receivedAt.getTime()) / 1000)),
      }
    : null; // never expose an old position as if it were current
  return {
    id: row.id, name: row.name, status, routeId: row.routeId, tripId: row.tripId,
    lastSeenAt: row.receivedAt?.toISOString() ?? null, location,
  };
}
