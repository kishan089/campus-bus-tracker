import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../services/api'
import type { Fix } from '../services/types'
import type { FixSource, GpsErrorKind } from './gpsSources'

export type SendState = 'idle' | 'sending' | 'ok' | 'offline' | 'rejected'

export interface TrackingState {
  fix: Fix | null
  gpsError: GpsErrorKind | null
  poorAccuracy: boolean
  sendState: SendState
  lastSentAt: number | null
  failedSends: number // consecutive
  rejection: string | null
  /** The bus is standing still and the phone has stopped reporting, so the last position is being repeated to say "still here". */
  parked: boolean
}

const INITIAL: TrackingState = {
  fix: null, gpsError: null, poorAccuracy: false, sendState: 'idle', lastSentAt: null, failedSends: 0, rejection: null, parked: false,
}

/** How long a standing bus's last position is repeated before the page admits it has no news. */
export const PARKED_MAX_MS = 15 * 60_000
const PARKED_BELOW_MPS = 1
const MIN_HEARTBEAT_MS = 10_000

interface Options {
  enabled: boolean
  intervalMs: number
  maxAccuracyM: number
  source: FixSource
  send: (fix: Fix) => Promise<void>
  /** Called when tracking cannot continue (login lost, or the trip no longer exists). */
  onFatal: (e: ApiError) => void
}

/**
 * Subscribes to a FixSource while `enabled`, and posts at most one fix per `intervalMs`.
 * - fixes worse than `maxAccuracyM` are shown but not sent (the server would reject them anyway)
 * - while the server is unreachable, the next fix after each interval retries; old fixes are not queued
 *   (a stale queue would be rejected by the server's timestamp check and would only delay fresh data)
 * - parked heartbeat: some phones send nothing while standing still, which would make a bus waiting at a stop drift to
 *   "GPS delayed". If the last fix said the bus was standing still (< 1 m/s), its position is repeated every 10 s (at most
 *   for 15 minutes). A bus that was moving is never repeated: silence there means a real GPS problem and must show.
 */
export function useGeoTracking({ enabled, intervalMs, maxAccuracyM, source, send, onFatal }: Options): TrackingState {
  const [state, setState] = useState<TrackingState>(INITIAL)
  const latest = useRef({ intervalMs, maxAccuracyM, send, onFatal })
  useEffect(() => { latest.current = { intervalMs, maxAccuracyM, send, onFatal } })

  useEffect(() => {
    if (!enabled) { setState(INITIAL); return }
    let lastAttempt = 0
    let inFlight = false
    let active = true
    let lastFix: { fix: Fix; at: number } | null = null

    const attempt = (fix: Fix, parked: boolean) => {
      const { send, onFatal } = latest.current
      lastAttempt = Date.now()
      inFlight = true
      setState((s) => ({ ...s, sendState: 'sending', parked }))
      send(fix)
        .then(() => active && setState((s) => ({ ...s, sendState: 'ok', lastSentAt: Date.now(), failedSends: 0, rejection: null })))
        .catch((e: unknown) => {
          if (!active) return
          if (e instanceof ApiError && (e.status === 401 || e.code === 'NO_ACTIVE_TRIP')) return onFatal(e)
          if (e instanceof ApiError && e.status === 0) {
            setState((s) => ({ ...s, sendState: 'offline', failedSends: s.failedSends + 1 }))
          } else {
            setState((s) => ({ ...s, sendState: 'rejected', rejection: e instanceof Error ? e.message : 'Rejected' }))
          }
        })
        .finally(() => { inFlight = false })
    }

    const handleFix = (fix: Fix) => {
      if (!active) return
      const { maxAccuracyM, intervalMs } = latest.current
      const poor = fix.accuracy !== null && fix.accuracy > maxAccuracyM
      lastFix = { fix, at: Date.now() }
      setState((s) => ({ ...s, fix, gpsError: null, poorAccuracy: poor }))
      if (poor || inFlight || Date.now() - lastAttempt < intervalMs) return
      attempt(fix, false)
    }

    const heartbeat = setInterval(() => {
      if (!active || inFlight || !lastFix) return
      const { maxAccuracyM, intervalMs } = latest.current
      const { fix, at } = lastFix
      const now = Date.now()
      const standing = fix.speed !== null && fix.speed < PARKED_BELOW_MPS
      const poor = fix.accuracy !== null && fix.accuracy > maxAccuracyM
      if (!standing || poor || now - at > PARKED_MAX_MS) return
      if (now - lastAttempt < Math.max(intervalMs, MIN_HEARTBEAT_MS)) return // a real send was recent enough
      attempt({ ...fix, speed: 0, heading: null, ts: now }, true)
    }, 1000)

    const unsubscribe = source(handleFix, (kind) => active && setState((s) => ({ ...s, gpsError: kind })))
    return () => { active = false; clearInterval(heartbeat); unsubscribe() }
  }, [enabled, source])

  return state
}
