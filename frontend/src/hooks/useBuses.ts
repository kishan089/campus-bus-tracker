import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from '../services/api'
import { getSocket, subscribe } from '../services/socket'
import type { Bus, Thresholds } from '../services/types'
import { DEFAULT_THRESHOLDS, deriveStatus } from '../utils/status'
import { useNow } from './useNow'

export interface BusesState {
  buses: Bus[] | null
  error: ApiError | null
  /** true while the WebSocket is connected */
  connected: boolean
}

/** A bus as last reported, plus when *this browser* learned of its newest fix (local clock, immune to clock skew). */
interface Raw { bus: Bus; seenAt: number | null }

/**
 * Initial state over REST, live changes over WebSocket, a REST refetch on every (re)connect and every 30 s as a safety net.
 * Returned buses have their status and ageSeconds re-derived every second, so a silent bus visibly goes
 * LIVE → DELAYED → OFFLINE even though no event arrives to say so.
 */
export function useBuses(enabled = true): BusesState {
  const [raw, setRaw] = useState<Raw[] | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [connected, setConnected] = useState(false)
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS)
  const rawRef = useRef<Raw[] | null>(null)
  const now = useNow(1000)

  useEffect(() => { rawRef.current = raw }, [raw])

  const fetchBuses = useCallback(async (signal?: AbortSignal) => {
    try {
      const list = await api.buses(signal)
      const at = Date.now()
      // the server's ageSeconds is measured on its own clock, so seenAt is right even if this phone's clock is off
      setRaw(list.map((bus) => ({ bus, seenAt: bus.location ? at - bus.location.ageSeconds * 1000 : null })))
      setError(null)
    } catch (e) {
      if (signal?.aborted) return
      setError(e instanceof ApiError ? e : new ApiError(0, 'NETWORK', 'Cannot reach the server'))
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    const ctrl = new AbortController()
    void fetchBuses(ctrl.signal)
    api.config(ctrl.signal).then((c) => setThresholds(c.status)).catch(() => { /* keep defaults */ })

    const sock = getSocket()
    const onConnect = () => { setConnected(true); void fetchBuses(ctrl.signal) } // catch up on anything missed
    const onDisconnect = () => setConnected(false)
    sock.on('connect', onConnect)
    sock.on('disconnect', onDisconnect)
    if (sock.connected) setConnected(true)

    const unsub = subscribe((ev) => {
      const known = rawRef.current?.find((r) => r.bus.id === ev.busId)
      if (known && ev.type === 'BUS_LOCATION_UPDATED' && known.bus.tripId === null) void fetchBuses(ctrl.signal) // missed the trip start

      setRaw((prev) => {
        if (!prev) return prev
        const i = prev.findIndex((r) => r.bus.id === ev.busId)
        if (i === -1) return prev
        const bus: Bus = { ...prev[i].bus }
        let seenAt = prev[i].seenAt
        if (ev.type === 'BUS_LOCATION_UPDATED') {
          bus.status = 'LIVE'
          bus.lastSeenAt = ev.receivedAt
          bus.location = {
            lat: ev.lat, lng: ev.lng, speed: ev.speed, accuracy: ev.accuracy, heading: ev.heading,
            recordedAt: new Date(ev.ts).toISOString(), receivedAt: ev.receivedAt, ageSeconds: 0,
          }
          bus.progress = ev.progress ?? null
          seenAt = Date.now()
        } else if (ev.type === 'BUS_TRIP_STARTED') {
          bus.status = 'LOCATION_UNAVAILABLE'
          bus.routeId = ev.routeId
          bus.tripId = ev.tripId
          bus.location = null
          bus.progress = null
          seenAt = null
        } else {
          bus.status = 'NOT_OPERATING'
          bus.tripId = null
          bus.location = null
          bus.progress = null
          seenAt = null
        }
        const next = [...prev]
        next[i] = { bus, seenAt }
        return next
      })
    })

    const visible = () => typeof document === 'undefined' || !document.hidden
    // a backgrounded tab does no polling (saves battery, and keeps a scale-to-zero database asleep)
    const timer = setInterval(() => { if (visible()) void fetchBuses(ctrl.signal) }, 30_000)
    // a free host that has been idle takes up to a minute to wake: keep trying every few seconds until the first answer
    const retry = setInterval(() => { if (rawRef.current === null && visible()) void fetchBuses(ctrl.signal) }, 5_000)
    // events can be missed while a tab is hidden, so refetch the moment it is shown again
    const onVisible = () => { if (visible()) void fetchBuses(ctrl.signal) }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      ctrl.abort(); unsub(); clearInterval(timer); clearInterval(retry)
      document.removeEventListener('visibilitychange', onVisible)
      sock.off('connect', onConnect); sock.off('disconnect', onDisconnect)
    }
  }, [enabled, fetchBuses])

  const buses = useMemo(() => {
    if (!raw) return null
    return raw.map(({ bus, seenAt }) => {
      if (!bus.location || seenAt === null) return bus
      const age = Math.max(0, (now - seenAt) / 1000)
      return { ...bus, status: deriveStatus(bus.status, age, thresholds), location: { ...bus.location, ageSeconds: age } }
    })
  }, [raw, now, thresholds])

  return { buses, error, connected }
}
