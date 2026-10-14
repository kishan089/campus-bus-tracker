export type LatLng = [number, number]; // Leaflet order: [lat, lng]
export interface Path { points: LatLng[]; cum: number[]; total: number }

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversine(a: LatLng, b: LatLng): number {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function buildPath(points: LatLng[]): Path {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + haversine(points[i - 1], points[i]));
  }
  return { points, cum, total: cum[cum.length - 1] };
}

/** Position after travelling `d` metres along the path; wraps for looping routes. */
export function pointAt(path: Path, d: number): LatLng {
  const t = ((d % path.total) + path.total) % path.total;
  let i = 1;
  while (i < path.cum.length - 1 && path.cum[i] < t) i++;
  const seg = path.cum[i] - path.cum[i - 1];
  const f = seg === 0 ? 0 : (t - path.cum[i - 1]) / seg;
  const a = path.points[i - 1];
  const b = path.points[i];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}
