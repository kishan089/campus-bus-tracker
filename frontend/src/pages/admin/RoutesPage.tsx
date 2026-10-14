import { useEffect, useMemo, useState } from 'react'
import { RouteMap } from '../../components/admin/RouteMap'
import { Card, confirmAction, ErrorNote, run } from '../../components/admin/ui'
import { useAsync } from '../../hooks/useAsync'
import { adminApi } from '../../services/api'
import type { AdminStop, RoutePreview } from '../../services/types'
import { formatKm } from '../../utils/format'
import { parseRoutePoints } from '../../utils/routeInput'

function Editor({ routeId, stops, onDone }: { routeId: string | null; stops: AdminStop[]; onDone: () => void }) {
  const [name, setName] = useState('')
  const [color, setColor] = useState('#2563eb')
  const [active, setActive] = useState(true)
  const [text, setText] = useState('')
  const [original, setOriginal] = useState('')
  const [loaded, setLoaded] = useState(routeId === null)
  const [preview, setPreview] = useState<{ forText: string; data: RoutePreview } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (routeId === null) return
    adminApi.route(routeId).then((r) => {
      setName(r.name); setColor(r.color); setActive(r.active)
      const t = JSON.stringify(r.points)
      setText(t); setOriginal(t); setLoaded(true)
    }).catch((e) => setError(e.message))
  }, [routeId])

  const parsed = useMemo(() => (text.trim() ? parseRoutePoints(text) : null), [text])
  const pathChanged = text !== original
  const previewed = preview?.forText === text ? preview.data : null
  const canSave = name.trim() !== '' && (routeId !== null && !pathChanged ? true : parsed?.ok === true && previewed !== null)

  const doPreview = () => {
    if (!parsed?.ok) return
    setBusy(true); setError(null)
    adminApi.previewRoute(parsed.points)
      .then((data) => setPreview({ forText: text, data }))
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false))
  }

  const save = () => void run(async () => {
    const points = parsed?.ok && pathChanged ? parsed.points : undefined
    if (routeId === null) await adminApi.createRoute({ name: name.trim(), color, points: (parsed as { points: [number, number][] }).points })
    else await adminApi.updateRoute(routeId, { name: name.trim(), color, active, ...(points ? { points } : {}) })
  }, setError, onDone)

  if (!loaded) return <Card><div className="muted">Loading…</div></Card>
  const mapStops = stops.map((s) => ({ ...s, matched: previewed ? !previewed.unmatchedStops.some((u) => u.id === s.id) : undefined }))

  return (
    <Card title={routeId ? `Edit route: ${routeId}` : 'New route'} actions={<button className="btn btn-small" onClick={onDone}>Close</button>}>
      <ErrorNote error={error} />
      <div className="form-row">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Colour<input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ padding: 2, height: 46 }} /></label>
        {routeId && <label style={{ flexDirection: 'row', display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" style={{ padding: 0 }} checked={active} onChange={(e) => setActive(e.target.checked)} />In service</label>}
      </div>

      <label>Path
        <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="Route points"
          placeholder={'Paste a GeoJSON line exported from geojson.io, or a list like [[25.2632, 82.9864], [25.2632, 82.9877], ...] (latitude, longitude)'} />
      </label>
      {parsed && !parsed.ok && <div className="alert error" role="alert">{parsed.error}</div>}
      {parsed?.ok && <div className="muted" data-testid="parse-note">{parsed.points.length} points read · {parsed.note}</div>}

      <div className="actions">
        <button className="btn" disabled={!parsed?.ok || busy} onClick={doPreview}>{busy ? 'Checking…' : 'Preview'}</button>
        <button className="btn btn-primary" disabled={!canSave} onClick={save}>{routeId ? 'Save changes' : 'Create route'}</button>
        {routeId && pathChanged && !previewed && <span className="muted">Preview the new path before saving it.</span>}
        {!routeId && !previewed && <span className="muted">Preview the path, then create.</span>}
      </div>

      {(parsed?.ok || previewed) && (
        <RouteMap points={parsed?.ok ? parsed.points : []} color={color} stops={mapStops} endpoints />
      )}

      {previewed && (
        <>
          <div data-testid="preview-summary"><b>{formatKm(previewed.totalLengthM)}</b> long · {previewed.passes.length} stop passes</div>
          {previewed.warnings.map((w) => <div key={w} className="alert">{w}</div>)}
          {previewed.unmatchedStops.length > 0 && (
            <div className="muted">Not on this route: {previewed.unmatchedStops.map((u) => `${u.name} (${u.nearestM} m away)`).join(', ')}</div>
          )}
          <div className="scroll-x">
            <table className="data">
              <thead><tr><th>#</th><th>Stop</th><th>Distance along route</th><th>Off the line</th></tr></thead>
              <tbody>{previewed.passes.map((p, i) => <tr key={`${p.stopId}-${p.s}`}><td>{i + 1}</td><td>{p.name}</td><td>{Math.round(p.s)} m</td><td>{p.offsetM} m</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  )
}

export default function RoutesPage() {
  const routes = useAsync(() => adminApi.routes(), [])
  const stops = useAsync(() => adminApi.stops(), [])
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const done = () => { setEditing(null); routes.reload(); stops.reload() }

  return (
    <>
      <ErrorNote error={actionError ?? routes.error} />
      {editing && <Editor key={editing} routeId={editing === 'new' ? null : editing} stops={stops.data ?? []} onDone={done} />}
      <Card title="Routes" actions={!editing && <button className="btn btn-small btn-primary" onClick={() => setEditing('new')}>New route</button>}>
        {!routes.data && !routes.error && <div className="muted">Loading…</div>}
        <div className="scroll-x">
          <table className="data">
            <thead><tr><th>Route</th><th>Length</th><th>Points</th><th>Stop passes</th><th>Status</th><th /></tr></thead>
            <tbody>
              {routes.data?.map((r) => (
                <tr key={r.id}>
                  <td><b style={{ color: r.color }}>●</b> <b>{r.name}</b><div className="muted">{r.id}</div></td>
                  <td>{formatKm(r.totalLengthM)}</td><td>{r.pointCount}</td><td>{r.passCount}</td>
                  <td>{r.active ? <span className="badge ok">In service</span> : <span className="badge bad">Off</span>}{r.hasActiveTrip && <span className="badge warn" style={{ marginLeft: 4 }}>Trip running</span>}</td>
                  <td className="actions">
                    <button className="btn btn-small" onClick={() => setEditing(r.id)}>Edit</button>
                    <button className="btn btn-small" onClick={() => {
                      if (confirmAction(`Delete ${r.name}? If it has trip history this is refused; switch it off instead.`)) void run(() => adminApi.deleteRoute(r.id), setActionError, routes.reload)
                    }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="muted">Trace a route on geojson.io and paste its GeoJSON here. Changing a path is blocked while a trip is running on it.</div>
      </Card>
    </>
  )
}
