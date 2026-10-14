import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet'
import { useEffect } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import campus from '../../data/campus.json'
import type { LatLng } from '../../utils/geo'

function Fit({ points }: { points: LatLng[] }) {
  const map = useMap()
  useEffect(() => { if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [24, 24] }) }, [points, map])
  return null
}

export interface MapStop { id: string; name: string; lat: number; lng: number; matched?: boolean }

/** A path with its stops (matched ones green, others grey), optionally with a start and end marker. */
export function RouteMap({ points, color = '#2563eb', stops = [], endpoints = false }: {
  points: LatLng[]; color?: string; stops?: MapStop[]; endpoints?: boolean
}) {
  return (
    <div className="map-box">
      <MapContainer center={campus.center as LatLng} zoom={16} style={{ height: '100%', width: '100%' }}>
        <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {points.length > 1 && <Polyline positions={points} pathOptions={{ color, weight: 5 }} />}
        {stops.map((s) => (
          <CircleMarker key={s.id} center={[s.lat, s.lng]} radius={7}
            pathOptions={{ color: '#fff', weight: 2, fillColor: s.matched === false ? '#9ca3af' : '#16a34a', fillOpacity: 1 }}>
            <Tooltip>{s.name}{s.matched === false ? ' (not on this route)' : ''}</Tooltip>
          </CircleMarker>
        ))}
        {endpoints && points.length > 1 && (
          <>
            <CircleMarker center={points[0]} radius={9} pathOptions={{ color: '#fff', weight: 3, fillColor: '#16a34a', fillOpacity: 1 }}><Tooltip permanent direction="top">Start</Tooltip></CircleMarker>
            <CircleMarker center={points[points.length - 1]} radius={9} pathOptions={{ color: '#fff', weight: 3, fillColor: '#dc2626', fillOpacity: 1 }}><Tooltip permanent direction="bottom">End</Tooltip></CircleMarker>
          </>
        )}
        <Fit points={points} />
      </MapContainer>
    </div>
  )
}
