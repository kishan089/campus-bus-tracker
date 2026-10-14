import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMapEvents } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import campus from '../../data/campus.json'
import type { LatLng } from '../../utils/geo'

const CENTER = campus.center as LatLng

function Clicks({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onPick(Math.round(e.latlng.lat * 1e7) / 1e7, Math.round(e.latlng.lng * 1e7) / 1e7) })
  return null
}

/** Click the map to set a position. Other stops and routes are drawn for reference. */
export function MapPicker({ value, onPick, stops = [], routes = [] }: {
  value: LatLng | null; onPick: (lat: number, lng: number) => void
  stops?: { id: string; name: string; lat: number; lng: number }[]; routes?: { id: string; color: string; points: LatLng[] }[]
}) {
  return (
    <div className="map-box">
      <MapContainer center={value ?? CENTER} zoom={17} style={{ height: '100%', width: '100%' }}>
        <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {routes.map((r) => <Polyline key={r.id} positions={r.points} pathOptions={{ color: r.color, weight: 4, opacity: 0.6 }} />)}
        {stops.map((s) => (
          <CircleMarker key={s.id} center={[s.lat, s.lng]} radius={6} pathOptions={{ color: '#fff', weight: 2, fillColor: '#16a34a', fillOpacity: 1 }}>
            <Tooltip>{s.name}</Tooltip>
          </CircleMarker>
        ))}
        {value && <CircleMarker center={value} radius={10} pathOptions={{ color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }} />}
        <Clicks onPick={onPick} />
      </MapContainer>
    </div>
  )
}
