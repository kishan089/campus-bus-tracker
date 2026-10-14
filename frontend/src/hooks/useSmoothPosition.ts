import { useEffect, useRef, useState } from 'react'
import { haversine, type LatLng } from '../utils/geo'

export const lerpLatLng = (a: LatLng, b: LatLng, t: number): LatLng => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

const SNAP_BEYOND_M = 150

/**
 * Glides from the last shown position to each new target instead of jumping. A new target mid-glide
 * starts from where the marker currently is. Big jumps (new trip, long gap) snap rather than sweep across campus.
 */
export function useSmoothPosition(target: LatLng, durationMs = 1000): LatLng {
  const [pos, setPos] = useState<LatLng>(target)
  const current = useRef<LatLng>(target)

  useEffect(() => {
    const from = current.current
    if (from[0] === target[0] && from[1] === target[1]) return
    if (haversine(from, target) > SNAP_BEYOND_M) {
      current.current = target
      setPos(target)
      return
    }
    const start = performance.now()
    let raf = 0
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs)
      const p = lerpLatLng(from, target, t)
      current.current = p
      setPos(p)
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depend on the numbers, not the array identity
  }, [target[0], target[1], durationMs])

  return pos
}
