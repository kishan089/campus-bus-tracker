import { haversine, type LatLng } from "../geo/geo";
import { project } from "../geo/snap";

export interface StopPos { id: string; name: string; lat: number; lng: number }
export interface PassOut { stopId: string; name: string; s: number; offsetM: number }
export interface RouteAnalysis {
  totalLengthM: number;
  passes: PassOut[];                                        // every time the route passes a stop, in route order
  unmatchedStops: { id: string; name: string; nearestM: number }[]; // stops this route does not pass
  warnings: string[];
}

const MATCH_M = 15;     // a stop within this distance of the line is on the route
const CLUSTER_M = 25;   // hits closer together than this along the route are one pass
const GAP_WARN_M = 500; // two consecutive points further apart than this are probably a typo

/**
 * Works out where along a polyline each stop is passed. This is what the seed script `stop-progress.mjs`
 * did by hand; here it runs whenever an admin edits a route or a stop, so passes can never go stale.
 */
export function analyzeRoute(points: LatLng[], stops: StopPos[]): RouteAnalysis {
  const cum = [0];
  const warnings: string[] = [];
  for (let i = 1; i < points.length; i++) {
    const d = haversine(points[i - 1], points[i]);
    cum.push(cum[i - 1] + d);
    if (d > GAP_WARN_M) warnings.push(`Points ${i} and ${i + 1} are ${Math.round(d)} m apart. Is a point missing?`);
  }
  const total = cum[cum.length - 1];
  const closed = points.length > 2 && haversine(points[0], points[points.length - 1]) < 20;
  if (!closed) {
    warnings.push(`The route ends ${Math.round(haversine(points[0], points[points.length - 1]))} m from where it starts. ` +
      "Arrival times assume the bus drives a loop and comes back to the start.");
  }

  const passes: PassOut[] = [];
  const unmatchedStops: RouteAnalysis["unmatchedStops"] = [];
  for (const stop of stops) {
    const p: LatLng = [stop.lat, stop.lng];
    const hits: { s: number; dist: number }[] = [];
    let nearest = Infinity;
    for (let i = 1; i < points.length; i++) {
      const { t, dist } = project(p, points[i - 1], points[i]);
      nearest = Math.min(nearest, dist);
      if (dist <= MATCH_M) hits.push({ s: cum[i - 1] + t * (cum[i] - cum[i - 1]), dist });
    }
    hits.sort((a, b) => a.s - b.s);
    const clusters: typeof hits[] = [];
    for (const h of hits) {
      const last = clusters[clusters.length - 1];
      if (last && h.s - last[last.length - 1].s < CLUSTER_M) last.push(h); else clusters.push([h]);
    }
    let mine = clusters.map((c) => c.reduce((a, b) => (b.dist < a.dist ? b : a)));
    // On a closed loop the start and the end are the same place: keep one pass, not two.
    if (closed && mine.length > 1 && mine[0].s < 10 && mine[mine.length - 1].s > total - 10) mine = mine.slice(0, -1);
    if (mine.length === 0) unmatchedStops.push({ id: stop.id, name: stop.name, nearestM: Math.round(nearest) });
    for (const h of mine) passes.push({ stopId: stop.id, name: stop.name, s: Math.round(h.s * 10) / 10, offsetM: Math.round(h.dist * 10) / 10 });
  }
  passes.sort((a, b) => a.s - b.s);
  if (stops.length > 0 && passes.length === 0) warnings.push(`No stop lies within ${MATCH_M} m of this route. Are the coordinates in [lat, lng] order?`);
  return { totalLengthM: Math.round(total * 10) / 10, passes, unmatchedStops, warnings };
}
