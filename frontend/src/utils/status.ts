import type { BusStatus, Thresholds } from '../services/types'

export const DEFAULT_THRESHOLDS: Thresholds = { liveS: 15, delayedS: 120, offlineS: 600 }

/** LIVE or DELAYED: the position is recent enough to base a direction or ETA on. */
export const isMoving = (s: BusStatus) => s === 'LIVE' || s === 'DELAYED'

const HAS_FIX = new Set<BusStatus>(['LIVE', 'DELAYED', 'POSSIBLY_OFFLINE', 'OFFLINE'])

/**
 * Between server updates a bus must age on its own: a driver who loses signal sends nothing,
 * so no event ever tells the page the bus went stale. Statuses without a fix are left alone.
 */
export function deriveStatus(base: BusStatus, ageSeconds: number, t: Thresholds): BusStatus {
  if (!HAS_FIX.has(base)) return base
  if (ageSeconds < t.liveS) return 'LIVE'
  if (ageSeconds < t.delayedS) return 'DELAYED'
  if (ageSeconds < t.offlineS) return 'POSSIBLY_OFFLINE'
  return 'OFFLINE'
}
