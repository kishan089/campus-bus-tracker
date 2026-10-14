export type Pt = [number, number] // [lat, lng], the order Leaflet and campus.json use

export type ParsedPoints = { ok: true; points: Pt[]; note: string } | { ok: false; error: string }

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const round = (n: number) => Math.round(n * 1e7) / 1e7

function fromGeoJson(g: any): { coords: unknown[]; note: string } | string {
  if (g?.type === 'FeatureCollection') {
    const f = (g.features ?? []).find((x: any) => x?.geometry?.type === 'LineString')
    return f ? fromGeoJson(f) : 'This GeoJSON has no LineString. Draw the route as a line (not points or an area).'
  }
  if (g?.type === 'Feature') return fromGeoJson(g.geometry)
  if (g?.type === 'LineString' && Array.isArray(g.coordinates))
    return { coords: g.coordinates, note: 'GeoJSON line (longitude, latitude) converted to latitude, longitude' }
  return `GeoJSON of type "${g?.type}" is not a line. Draw the route as a LineString.`
}

/**
 * Reads a route typed or pasted by an admin.
 *  - GeoJSON (what geojson.io exports) stores [longitude, latitude]; it is converted.
 *  - A plain list of pairs is [latitude, longitude], the same order as campus.json.
 *  - A list of {lat, lng} objects also works.
 */
export function parseRoutePoints(text: string): ParsedPoints {
  if (!text.trim()) return { ok: false, error: 'Paste the route points.' }
  let data: any
  try { data = JSON.parse(text) } catch { return { ok: false, error: 'This is not valid JSON. Paste the coordinates exactly as exported.' } }

  let coords: unknown[]
  let note = 'List of [latitude, longitude] pairs'
  let geo = false
  if (Array.isArray(data)) {
    coords = data
    if (data.length && typeof data[0] === 'object' && !Array.isArray(data[0])) note = 'List of {lat, lng} points'
  } else {
    const g = fromGeoJson(data)
    if (typeof g === 'string') return { ok: false, error: g }
    coords = g.coords; note = g.note; geo = true
  }

  const points: Pt[] = []
  for (const [i, c] of coords.entries()) {
    let lat: unknown, lng: unknown
    if (Array.isArray(c)) { [lat, lng] = geo ? [c[1], c[0]] : [c[0], c[1]] }
    else if (c && typeof c === 'object') { lat = (c as any).lat; lng = (c as any).lng ?? (c as any).lon }
    if (!isNum(lat) || !isNum(lng)) return { ok: false, error: `Point ${i + 1} is not a pair of numbers.` }
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180)
      return { ok: false, error: `Point ${i + 1} is out of range (latitude must be within ±90, longitude within ±180). Are latitude and longitude swapped?` }
    points.push([round(lat), round(lng)])
  }
  if (points.length < 2) return { ok: false, error: 'A route needs at least 2 points.' }
  if (points.length > 5000) return { ok: false, error: 'At most 5000 points.' }
  return { ok: true, points, note }
}

/** Random password from a set with no look-alike characters (0/O, 1/l/I). */
export function generatePassword(len = 14): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint32Array(len))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}
