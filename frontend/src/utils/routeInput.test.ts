import { describe, expect, it } from 'vitest'
import { generatePassword, parseRoutePoints } from './routeInput'

const ok = (t: string) => { const r = parseRoutePoints(t); if (!r.ok) throw new Error(r.error); return r }
const err = (t: string) => { const r = parseRoutePoints(t); if (r.ok) throw new Error('expected an error'); return r.error }

describe('parseRoutePoints', () => {
  it('reads a plain list as [latitude, longitude] and leaves it alone', () => {
    const r = ok('[[25.2632, 82.9864], [25.2632, 82.9877]]')
    expect(r.points).toEqual([[25.2632, 82.9864], [25.2632, 82.9877]])
    expect(r.note).toMatch(/latitude, longitude/)
  })

  it('converts GeoJSON, which stores [longitude, latitude], into [latitude, longitude]', () => {
    const geo = '{"type":"LineString","coordinates":[[82.9864342,25.2631986],[82.9876895,25.2632131]]}'
    expect(ok(geo).points).toEqual([[25.2631986, 82.9864342], [25.2632131, 82.9876895]])
    expect(ok(geo).note).toMatch(/GeoJSON/)
  })

  it('takes the first line from a geojson.io export (a FeatureCollection) and drops altitude', () => {
    const fc = JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [82.99, 25.26] } },
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[82.99, 25.26, 80], [83.0, 25.27, 81]] } },
    ] })
    expect(ok(fc).points).toEqual([[25.26, 82.99], [25.27, 83.0]])
  })

  it('accepts a single Feature and a list of {lat, lng} objects', () => {
    expect(ok('{"type":"Feature","geometry":{"type":"LineString","coordinates":[[82.9,25.2],[83,25.3]]}}').points[0]).toEqual([25.2, 82.9])
    expect(ok('[{"lat":25.2,"lng":82.9},{"lat":25.3,"lon":83}]').points).toEqual([[25.2, 82.9], [25.3, 83]])
  })

  it('catches swapped coordinates when a value is out of range', () => {
    expect(err('[[139.7, 35.6], [139.8, 35.7]]')).toMatch(/out of range.*swapped/) // longitude pasted first (Tokyo)
    expect(err('[[25.2, 82.9], [95.0, 10.0]]')).toMatch(/Point 2 is out of range/)
  })

  it('cannot tell from the numbers alone when a swap stays in range, as for Varanasi (25 N, 83 E): the preview has to catch that', () => {
    expect(parseRoutePoints('[[82.9864, 25.2632], [82.9877, 25.2632]]').ok).toBe(true)
  })

  it('explains what is wrong with input that is not a route', () => {
    expect(err('')).toMatch(/Paste/)
    expect(err('25.26, 82.99')).toMatch(/not valid JSON/)
    expect(err('[[25.2, 82.9]]')).toMatch(/at least 2 points/)
    expect(err('[[25.2, "x"], [1, 2]]')).toMatch(/Point 1 is not a pair of numbers/)
    expect(err('{"type":"Point","coordinates":[82.9,25.2]}')).toMatch(/not a line/)
    expect(err('{"type":"FeatureCollection","features":[]}')).toMatch(/no LineString/)
  })

  it('rounds to 7 decimal places (about a centimetre)', () => {
    expect(ok('[[25.123456789, 82.987654321], [1, 2]]').points[0]).toEqual([25.1234568, 82.9876543])
  })
})

describe('generatePassword', () => {
  it('is long, uses no look-alike characters, and differs each time', () => {
    const a = generatePassword(), b = generatePassword()
    expect(a).toHaveLength(14)
    expect(a).toMatch(/^[a-km-zA-HJ-NP-Z2-9]+$/)
    expect(a).not.toBe(b)
  })
})
