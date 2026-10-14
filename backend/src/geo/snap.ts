import type { LatLng, Path } from "./geo";

const rad = (d: number) => (d * Math.PI) / 180;

/** Distance (m) from p to segment a-b, and fraction t along it. Flat approximation, fine at campus scale. */
export function project(p: LatLng, a: LatLng, b: LatLng) {
  const kx = 111320 * Math.cos(rad(a[0]));
  const ky = 110540;
  const px = (p[1] - a[1]) * kx, py = (p[0] - a[0]) * ky;
  const bx = (b[1] - a[1]) * kx, by = (b[0] - a[0]) * ky;
  const len2 = bx * bx + by * by;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return { t, dist: Math.hypot(px - t * bx, py - t * by) };
}

/** Signed circular difference s - ref on a loop of length `total`, in (-total/2, total/2]. */
export function circDelta(s: number, ref: number, total: number): number {
  let d = (s - ref) % total;
  if (d > total / 2) d -= total;
  if (d < -total / 2) d += total;
  return d;
}

export interface Snap { s: number; offRoute: number }
export interface SnapOpts {
  back?: number;    // m behind lastS whose segments are searched
  ahead?: number;   // m ahead of lastS whose segments are searched
  backTol?: number; // a candidate more than this behind lastS is rejected (if any alternative exists)
  tieBand?: number; // candidates within this many m of the best distance count as ties
  maxOff?: number;  // farther than this from every windowed segment = lost lock, re-snap globally
}

/**
 * Snap a GPS fix to the route. `lastS` (previous progress) selects the leg:
 * among equally-near candidates (shared road), take the one closest to lastS
 * that hasn't moved backwards. Without lastS, ties resolve to the earliest pass.
 */
export function snapToPath(path: Path, p: LatLng, lastS?: number, o: SnapOpts = {}): Snap {
  const { back = 30, ahead = 300, backTol = 5, tieBand = 5, maxOff = 50 } = o;
  const { points, cum, total } = path;
  const windowed = lastS !== undefined;

  const cands: Snap[] = [];
  for (let i = 1; i < points.length; i++) {
    if (windowed) {
      const lo = cum[i - 1], hi = cum[i];
      const hit = [-total, 0, total].some((k) => lo <= lastS + ahead + k && hi >= lastS - back + k);
      if (!hit) continue;
    }
    const { t, dist } = project(p, points[i - 1], points[i]);
    cands.push({ s: cum[i - 1] + t * (cum[i] - cum[i - 1]), offRoute: dist });
  }
  if (!cands.length) return { s: 0, offRoute: Infinity };

  const minD = Math.min(...cands.map((c) => c.offRoute));
  if (windowed && minD > maxOff) return snapToPath(path, p, undefined, o);

  const near = cands.filter((c) => c.offRoute <= minD + tieBand);
  if (!windowed) return near[0]; // cands are in route order -> earliest pass

  const scored = near.map((c) => ({ c, d: circDelta(c.s, lastS, total) }));
  const fwd = scored.filter((x) => x.d >= -backTol);
  const pool = fwd.length ? fwd : scored;
  return pool.reduce((a, b) => (Math.abs(b.d) < Math.abs(a.d) ? b : a)).c;
}

/** Metres the bus still has to travel from progress s to reach progress stopS (wraps the loop). */
export const metresToStop = (s: number, stopS: number, total: number) =>
  (((stopS - s) % total) + total) % total;
