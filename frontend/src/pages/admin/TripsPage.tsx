import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { RouteMap } from '../../components/admin/RouteMap'
import { Card, confirmAction, ErrorNote, run } from '../../components/admin/ui'
import { useAsync } from '../../hooks/useAsync'
import { adminApi } from '../../services/api'
import type { AdminTrip } from '../../services/types'
import { formatDuration, formatKm } from '../../utils/format'

const END_TEXT: Record<string, string> = { DRIVER: 'by the driver', ADMIN: 'by an admin', AUTO_TIMEOUT: 'automatically (driver went silent)' }

const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function TripsPage() {
  const [status, setStatus] = useState('')
  const [busId, setBusId] = useState('')
  const [extra, setExtra] = useState<AdminTrip[]>([])
  const [cursor, setCursor] = useState<number | null | undefined>(undefined)
  const buses = useAsync(() => adminApi.buses(), [])
  const first = useAsync(() => adminApi.trips({ status, busId }), [status, busId])
  const [moreError, setMoreError] = useState<string | null>(null)

  useEffect(() => { setExtra([]); setCursor(undefined) }, [status, busId])
  const next = cursor === undefined ? first.data?.nextBefore ?? null : cursor
  const trips = [...(first.data?.trips ?? []), ...extra]

  return (
    <Card title="Trips">
      <ErrorNote error={first.error ?? moreError} />
      <div className="form-row">
        <label>Status<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="ACTIVE">In progress</option><option value="COMPLETED">Finished</option></select></label>
        <label>Bus<select value={busId} onChange={(e) => setBusId(e.target.value)}><option value="">All buses</option>{buses.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
      </div>
      {!first.data && !first.error && <div className="muted">Loading…</div>}
      {first.data && trips.length === 0 && <div className="muted">No trips match.</div>}
      <div className="scroll-x">
        <table className="data">
          <thead><tr><th>Started</th><th>Bus</th><th>Driver</th><th>Route</th><th>Duration</th><th>GPS fixes</th><th>Ended</th><th /></tr></thead>
          <tbody>
            {trips.map((t) => (
              <tr key={t.id}>
                <td>{when(t.startedAt)}</td><td>{t.busName}</td><td>{t.driverName}</td><td>{t.routeName}</td>
                <td>{formatDuration(t.durationS)}{t.status === 'ACTIVE' && <span className="badge ok" style={{ marginLeft: 6 }}>live</span>}</td>
                <td>{t.fixCount}</td>
                <td>{t.status === 'ACTIVE' ? '–' : END_TEXT[t.endReason ?? ''] ?? 'by the driver'}</td>
                <td><Link to={`/admin/trips/${t.id}`}>Details</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {next !== null && (
        <button className="btn" onClick={() => void run(async () => {
          const r = await adminApi.trips({ status, busId, before: next })
          setExtra((e) => [...e, ...r.trips]); setCursor(r.nextBefore)
        }, setMoreError)}>Load older trips</button>
      )}
    </Card>
  )
}

export function TripDetailPage() {
  const id = Number(useParams().id)
  const nav = useNavigate()
  const trip = useAsync(() => adminApi.trip(id), [id])
  const [error, setError] = useState<string | null>(null)
  const t = trip.data

  return (
    <>
      <ErrorNote error={error ?? trip.error} />
      <Card title={t ? `${t.busName} · ${when(t.startedAt)}` : 'Trip'} actions={<Link to="/admin/trips" className="muted">← All trips</Link>}>
        {!t && !trip.error && <div className="muted">Loading…</div>}
        {t && (
          <>
            <div className="muted">
              {t.driverName} on {t.routeName} · {t.status === 'ACTIVE' ? 'in progress' : `ended ${when(t.endedAt!)}`} · {formatDuration(t.durationS)}
            </div>
            <div className="grid stats">
              <div className="stat"><b>{formatKm(t.stats.distanceM)}</b><span className="muted">Distance</span></div>
              <div className="stat"><b>{t.stats.avgSpeedKmh ?? '–'}</b><span className="muted">Avg km/h</span></div>
              <div className="stat"><b>{t.stats.maxSpeedKmh}</b><span className="muted">Top km/h</span></div>
              <div className="stat"><b>{t.fixCount}</b><span className="muted">GPS fixes</span></div>
              <div className="stat"><b>{t.stats.gaps}</b><span className="muted">GPS dropouts{t.stats.gaps > 0 && ` (longest ${formatDuration(t.stats.longestGapS)})`}</span></div>
              <div className="stat"><b>{t.stats.avgAccuracyM === null ? '–' : `±${t.stats.avgAccuracyM} m`}</b><span className="muted">Avg accuracy</span></div>
            </div>
            {t.trail.length > 1 ? <RouteMap points={t.trail} endpoints /> : <div className="muted">This trip sent no GPS fixes.</div>}
            {t.status === 'ACTIVE' && (
              <button className="btn btn-danger" onClick={() => {
                if (confirmAction('End this trip? Use this when the driver’s phone has died or the page was closed.'))
                  void run(() => adminApi.endTrip(t.id), setError, () => { trip.reload(); nav(0) })
              }}>End trip</button>
            )}
          </>
        )}
      </Card>
    </>
  )
}
