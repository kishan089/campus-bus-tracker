import { useMemo, useState } from 'react'
import CampusMap, { type MapBus, type MapFocus } from '../map/CampusMap'
import BusList from '../components/BusList'
import StopArrivals from '../components/StopArrivals'
import campus from '../data/campus.json'
import { useBuses, type BusesState } from '../hooks/useBuses'
import { useSimulatedBus } from '../hooks/useSimulatedBus'
import type { Bus } from '../services/types'
import { buildPath, type LatLng } from '../utils/geo'
import { isMoving } from '../utils/status'

const route = campus.routes[0]
const path = buildPath(route.points as LatLng[])

const STOPS = campus.stops.map((s) => ({ id: s.id, name: s.name }))

function useStoredStop(): [string | null, (id: string | null) => void] {
  const [id, setId] = useState<string | null>(() => {
    try {
      const v = localStorage.getItem('stopId')
      return v && STOPS.some((s) => s.id === v) ? v : null
    } catch { return null }
  })
  const set = (next: string | null) => {
    setId(next)
    try { next ? localStorage.setItem('stopId', next) : localStorage.removeItem('stopId') } catch { /* private mode */ }
  }
  return [id, set]
}

/** Everything shown here about direction, next stop and ETA comes from the server (bus.progress). */
function StudentView({ buses, error, connected }: BusesState) {
  const [focus, setFocus] = useState<MapFocus | null>(null)
  const [stopId, setStopId] = useStoredStop()

  const { mapBuses, towards, offRoute } = useMemo(() => {
    const mapBuses: MapBus[] = []
    const towards: Record<string, { name: string; metres: number; seconds: number } | null> = {}
    const offRoute: Record<string, boolean> = {}
    for (const b of buses ?? []) {
      if (!b.location) continue
      const p = isMoving(b.status) ? b.progress : null
      const pos: LatLng = p?.position ? [p.position.lat, p.position.lng] : [b.location.lat, b.location.lng]
      mapBuses.push({
        id: b.id, pos,
        label: isMoving(b.status) ? b.name : `${b.name} (last known)`,
        tone: b.status === 'LIVE' ? 'live' : b.status === 'DELAYED' ? 'delayed' : 'stale',
      })
      offRoute[b.id] = !!p && !p.onRoute
      towards[b.id] = p?.next
        ? { name: p.next.name, metres: p.next.metres, seconds: Math.max(0, p.next.etaSeconds - b.location.ageSeconds) }
        : null
    }
    return { mapBuses, towards, offRoute }
  }, [buses])

  const locate = (b: Bus) => {
    const m = mapBuses.find((x) => x.id === b.id)
    if (m) setFocus({ pos: m.pos, nonce: Date.now() })
  }

  return (
    <div className="map-wrap">
      <CampusMap buses={mapBuses} focus={focus} selectedStopId={stopId} />
      <div className="sheet">
        <StopArrivals stops={STOPS} stopId={stopId} onSelect={setStopId} buses={buses} />
        <BusList buses={buses} error={error} connected={connected} towards={towards} offRoute={offRoute} onLocate={locate} />
      </div>
    </div>
  )
}

function LiveStudent() {
  return <StudentView {...useBuses()} />
}

/** `/?sim=1` keeps the Phase 1 demo: a fake bus looping the route, shown through the same UI. */
function SimulatedStudent() {
  const { pos, s } = useSimulatedBus(path, 8)
  const state = useMemo<BusesState>(() => {
    const at = Date.now()
    const bus: Bus = {
      id: 'bus-sim', name: 'Bus 1 (simulated)', status: 'LIVE', routeId: route.id, tripId: 0,
      lastSeenAt: new Date(at).toISOString(),
      location: { lat: pos[0], lng: pos[1], speed: 8, accuracy: 5, heading: null,
        recordedAt: new Date(at).toISOString(), receivedAt: new Date(at).toISOString(), ageSeconds: 0 },
    }
    return { buses: [bus], error: null, connected: true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, s])
  return <StudentView {...state} />
}

export default function StudentPage() {
  const simulated = useMemo(() => new URLSearchParams(window.location.search).has('sim'), [])
  return simulated ? <SimulatedStudent /> : <LiveStudent />
}
