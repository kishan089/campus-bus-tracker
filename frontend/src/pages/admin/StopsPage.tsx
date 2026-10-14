import { useState } from 'react'
import { MapPicker } from '../../components/admin/MapPicker'
import { Card, confirmAction, ErrorNote, run } from '../../components/admin/ui'
import { useAsync } from '../../hooks/useAsync'
import { adminApi } from '../../services/api'
import type { AdminStop } from '../../services/types'
import type { LatLng } from '../../utils/geo'

const EMPTY = { id: null as string | null, name: '', lat: '', lng: '' }

export default function StopsPage() {
  const stops = useAsync(() => adminApi.stops(), [])
  const routes = useAsync(async () => Promise.all((await adminApi.routes()).map((r) => adminApi.route(r.id))), [])
  const [form, setForm] = useState(EMPTY)
  const [actionError, setActionError] = useState<string | null>(null)

  const lat = Number(form.lat), lng = Number(form.lng)
  const valid = form.name.trim() !== '' && form.lat !== '' && form.lng !== '' && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
  const edit = (s: AdminStop) => setForm({ id: s.id, name: s.name, lat: String(s.lat), lng: String(s.lng) })

  return (
    <>
      <ErrorNote error={actionError ?? stops.error} />
      <Card title={form.id ? `Edit stop: ${form.id}` : 'Add a stop'}>
        <div className="muted">Click the map to place the stop. A stop within 15 m of a route's line becomes part of that route automatically.</div>
        <MapPicker value={valid ? [lat, lng] as LatLng : null} onPick={(la, ln) => setForm({ ...form, lat: String(la), lng: String(ln) })}
          stops={(stops.data ?? []).filter((s) => s.id !== form.id)}
          routes={(routes.data ?? []).map((r) => ({ id: r.id, color: r.color, points: r.points }))} />
        <div className="form-row">
          <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Latitude<input inputMode="decimal" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} /></label>
          <label>Longitude<input inputMode="decimal" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} /></label>
          <div className="actions">
            <button className="btn btn-primary" disabled={!valid} onClick={() => void run(
              () => form.id ? adminApi.updateStop(form.id, { name: form.name.trim(), lat, lng }) : adminApi.createStop({ name: form.name.trim(), lat, lng }),
              setActionError, () => { setForm(EMPTY); stops.reload(); routes.reload() })}>{form.id ? 'Save' : 'Add stop'}</button>
            {form.id && <button className="btn" onClick={() => setForm(EMPTY)}>Cancel</button>}
          </div>
        </div>
      </Card>
      <Card title="Stops">
        <div className="scroll-x">
          <table className="data">
            <thead><tr><th>Stop</th><th>Position</th><th>On routes</th><th /></tr></thead>
            <tbody>
              {stops.data?.map((s) => (
                <tr key={s.id}>
                  <td><b>{s.name}</b><div className="muted">{s.id}</div></td>
                  <td className="muted">{s.lat.toFixed(5)}, {s.lng.toFixed(5)}</td>
                  <td>{s.routes.length ? s.routes.join(', ') : <span className="badge warn">not on any route</span>}</td>
                  <td className="actions">
                    <button className="btn btn-small" onClick={() => edit(s)}>Edit</button>
                    <button className="btn btn-small" onClick={() => {
                      if (confirmAction(`Delete the stop ${s.name}? Students will no longer be able to pick it.`)) void run(() => adminApi.deleteStop(s.id), setActionError, () => { stops.reload(); routes.reload() })
                    }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  )
}
