import { memo, useEffect } from 'react'
import { MapContainer, TileLayer, Polyline, CircleMarker, Marker, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import campus from '../data/campus.json'
import { useSmoothPosition } from '../hooks/useSmoothPosition'
import type { LatLng } from '../utils/geo'

const route = campus.routes[0]

export interface MapBus {
  id: string
  label: string
  pos: LatLng
  tone: 'live' | 'delayed' | 'stale' // stale = last known position, not current
}

export interface MapFocus { pos: LatLng; nonce: number }

const TONE = {
  live: { fill: '#dc2626', opacity: 1 },
  delayed: { fill: '#f59e0b', opacity: 1 },
  stale: { fill: '#6b7280', opacity: 0.6 },
}

const StaticLayers = memo(function StaticLayers({ selectedStopId }: { selectedStopId: string | null }) {
  return (
    <>
      <Polyline positions={route.points as LatLng[]} pathOptions={{ color: route.color, weight: 5 }} />
      {campus.landmarks.map((l) => (
        <CircleMarker key={l.id} center={l.pos as LatLng} radius={5} pathOptions={{ color: '#7c3aed', fillOpacity: 0.8 }}>
          <Tooltip>{l.name}</Tooltip>
        </CircleMarker>
      ))}
      {campus.stops.map((s) => (
        <CircleMarker key={s.id} center={s.pos as LatLng} radius={s.id === selectedStopId ? 11 : 7}
          pathOptions={{ color: '#fff', weight: 2, fillColor: s.id === selectedStopId ? '#2563eb' : '#16a34a', fillOpacity: 1 }}>
          <Tooltip permanent direction="right">{s.name}</Tooltip>
        </CircleMarker>
      ))}
    </>
  )
})

function FlyTo({ focus }: { focus: MapFocus | null }) {
  const map = useMap()
  useEffect(() => {
    if (focus) map.flyTo(focus.pos, Math.max(map.getZoom(), 18))
  }, [focus, map])
  return null
}

function createBusIcon(tone: MapBus['tone']) {
  return L.divIcon({
    className: 'bus-marker',
    html: `<div style="background: ${TONE[tone].fill}; width: 100%; height: 100%; border-radius: 50%; opacity: ${TONE[tone].opacity}"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11]
  })
}
// Created once: react-leaflet swaps the marker's DOM element whenever the icon object changes,
// so building a new icon on every render made markers blink once a second.
const ICONS = { live: createBusIcon('live'), delayed: createBusIcon('delayed'), stale: createBusIcon('stale') }

function BusMarker({ bus }: { bus: MapBus }) {
  const pos = useSmoothPosition(bus.pos)
  return (
    <Marker position={pos} icon={ICONS[bus.tone]}>
      <Tooltip permanent direction="top" offset={[0, -10]}>{bus.label}</Tooltip>
    </Marker>
  )
}

export default function CampusMap({ buses, focus, selectedStopId = null }: { buses: MapBus[]; focus: MapFocus | null; selectedStopId?: string | null }) {
  return (
    <MapContainer center={campus.center as LatLng} zoom={17} style={{ height: '100%', width: '100%' }}>
      <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <StaticLayers selectedStopId={selectedStopId} />
      {buses.map((b) => <BusMarker key={b.id} bus={b} />)}
      <FlyTo focus={focus} />
    </MapContainer>
  )
}
