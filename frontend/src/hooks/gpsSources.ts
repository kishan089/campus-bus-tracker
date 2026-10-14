import { pointAt, type Path } from '../utils/geo'
import type { Fix } from '../services/types'

export type GpsErrorKind = 'denied' | 'unavailable' | 'timeout' | 'unsupported'

/** Anything that produces fixes: the real GPS, or the dev simulator. Returns an unsubscribe function. */
export type FixSource = (onFix: (fix: Fix) => void, onError: (kind: GpsErrorKind) => void) => () => void

const finite = (n: number | null | undefined): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null)

export const browserGpsSource: FixSource = (onFix, onError) => {
  if (!('geolocation' in navigator)) {
    onError('unsupported')
    return () => {}
  }
  const id = navigator.geolocation.watchPosition(
    (p) => {
      const speed = finite(p.coords.speed)
      const heading = finite(p.coords.heading)
      onFix({
        lat: p.coords.latitude, lng: p.coords.longitude,
        speed: speed === null ? null : Math.max(0, speed), // the server rejects negative speeds
        accuracy: finite(p.coords.accuracy), heading: heading === null ? null : ((heading % 360) + 360) % 360,
        ts: p.timestamp,
      })
    },
    (e) => onError(e.code === 1 ? 'denied' : e.code === 2 ? 'unavailable' : 'timeout'),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
  )
  return () => navigator.geolocation.clearWatch(id)
}

/** Dev tool: drives the bus around the route at `speedMps`, one fix per second, through the real pipeline. */
export function simulatedSource(path: Path, speedMps: number): FixSource {
  return (onFix) => {
    let dist = 0
    let last = Date.now()
    const t = setInterval(() => {
      const now = Date.now()
      dist += ((now - last) / 1000) * speedMps
      last = now
      const [lat, lng] = pointAt(path, dist)
      onFix({ lat, lng, speed: speedMps, accuracy: 5, heading: null, ts: now })
    }, 1000)
    return () => clearInterval(t)
  }
}
