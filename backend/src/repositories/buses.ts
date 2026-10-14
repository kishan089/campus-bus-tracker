import type { Db } from "../db";

export interface BusRow {
  id: string; name: string; active: boolean;
  tripId: number | null; routeId: string | null;
  locTripId: number | null; lat: number | null; lng: number | null;
  speed: number | null; accuracy: number | null; heading: number | null;
  recordedAt: Date | null; receivedAt: Date | null;
  progressM: number | null; offRouteM: number | null; speedEstMps: number | null;
}

const SQL = `
  SELECT b.id, b.name, b.active, t.id AS "tripId", t.route_id AS "routeId",
         l.trip_id AS "locTripId", l.lat, l.lng, l.speed, l.accuracy, l.heading,
         l.recorded_at AS "recordedAt", l.received_at AS "receivedAt",
         l.route_progress_m AS "progressM", l.off_route_m AS "offRouteM", l.speed_est_mps AS "speedEstMps"
    FROM buses b
    LEFT JOIN trips t ON t.bus_id = b.id AND t.status = 'ACTIVE'
    LEFT JOIN LATERAL (
      SELECT trip_id, lat, lng, speed, accuracy, heading, recorded_at, received_at,
               route_progress_m, off_route_m, speed_est_mps
        FROM gps_locations g WHERE g.bus_id = b.id
       ORDER BY g.received_at DESC, g.id DESC LIMIT 1) l ON true`;

export const listBusRows = async (db: Db) => (await db.query<BusRow>(`${SQL} ORDER BY b.id`)).rows;
export const getBusRow = async (db: Db, id: string) =>
  (await db.query<BusRow>(`${SQL} WHERE b.id = $1`, [id])).rows[0] ?? null;
