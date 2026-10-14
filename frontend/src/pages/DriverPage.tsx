import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import campus from '../data/campus.json'
import { browserGpsSource, simulatedSource, type GpsErrorKind } from '../hooks/gpsSources'
import { useGeoTracking } from '../hooks/useGeoTracking'
import { useNow } from '../hooks/useNow'
import { useWakeLock } from '../hooks/useWakeLock'
import RequireRole from '../components/RequireRole'
import { api, ApiError, driverApi } from '../services/api'
import { logout } from '../services/auth'
import type { ActiveTrip, Bus, RouteSummary, SessionUser } from '../services/types'
import { buildPath, type LatLng } from '../utils/geo'
import { formatAge, msToKmh } from '../utils/format'

const MAX_ACCURACY_M = 100 // keep in sync with the backend's MAX_ACCURACY_M
const INTERVALS_S = [2, 3, 5, 10]
const DEV = import.meta.env.DEV
const simPath = buildPath(campus.routes[0].points as LatLng[])

const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
  del: (k: string) => { try { localStorage.removeItem(k) } catch { /* private mode */ } },
}

const GPS_ERRORS: Record<GpsErrorKind, string> = {
  denied: 'Location permission was denied. Allow location for this site in your browser settings, then tap “Retry GPS”.',
  unavailable: 'Your phone cannot determine its location. Make sure location services are switched on.',
  timeout: 'Still looking for a GPS signal… move to an open area.',
  unsupported: 'This browser does not support GPS.',
}

export default function DriverPage() {
  return (
    <div className="page">
      <RequireRole role="DRIVER" title="Driver sign-in">{(user) => <DriverConsole key={user.id} user={user} />}</RequireRole>
    </div>
  )
}

interface Boot { buses: Bus[]; routes: RouteSummary[] }

function DriverConsole({ user }: { user: SessionUser }) {
  const d = driverApi
  const [boot, setBoot] = useState<Boot | { error: string } | null>(null)
  const [trip, setTrip] = useState<ActiveTrip | null>(null)
  const [tracking, setTracking] = useState(false)
  const [busId, setBusId] = useState('')
  const [routeId, setRouteId] = useState('')
  const [intervalS, setIntervalS] = useState(() => { const n = Number(store.get('gpsIntervalS')); return INTERVALS_S.includes(n) ? n : 3 })
  const [simulate, setSimulate] = useState(false)
  const [simSpeed, setSimSpeed] = useState(8)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const now = useNow(1000)

  const load = useCallback(async () => {
    try {
      const [active, buses, routes] = await Promise.all([d.activeTrip(), api.buses(), api.routes()])
      // a driver only sees the buses they are assigned to (the server checks this again when the trip starts)
      const mine = buses.filter((b) => user.buses.some((m) => m.id === b.id))
      setBoot({ buses: mine, routes })
      setTrip(active)
      setBusId(active?.busId ?? mine.find((b) => b.tripId === null && b.status !== 'DISABLED')?.id ?? '')
      setRouteId(active?.routeId ?? routes[0]?.id ?? '')
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return // the session is gone; the sign-in form takes over
      setBoot({ error: e instanceof Error ? e.message : 'Could not load' })
    }
  }, [d, user])
  useEffect(() => { void load() }, [load])

  const source = useMemo(
    () => (simulate ? simulatedSource(simPath, simSpeed) : browserGpsSource),
    // `attempt` gives "Retry GPS" a fresh subscription
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [simulate, simSpeed, attempt],
  )
  const gps = useGeoTracking({
    enabled: tracking && trip !== null,
    intervalMs: intervalS * 1000,
    maxAccuracyM: MAX_ACCURACY_M,
    source,
    send: (fix) => d.sendLocation(fix),
    onFatal: (e) => {
      if (e.status === 401) return // signed out; this page is replaced by the sign-in form
      setTracking(false); setTrip(null)
      setMessage('This trip was ended elsewhere. Start a new one.')
    },
  })
  const screenOn = useWakeLock(tracking)

  useEffect(() => {
    if (!tracking) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [tracking])

  async function start() {
    setBusy(true); setMessage(null)
    try { setTrip(await d.startTrip(busId, routeId)); setTracking(true) }
    catch (e) { setMessage(e instanceof ApiError ? e.message : 'Could not start the trip.') }
    finally { setBusy(false) }
  }

  async function end() {
    setBusy(true); setMessage(null); setTracking(false)
    try { await d.endTrip(); setTrip(null) }
    catch (e) {
      if (e instanceof ApiError && e.code === 'NO_ACTIVE_TRIP') setTrip(null)
      else setMessage(`Could not end the trip (${e instanceof Error ? e.message : 'error'}). Try again.`)
    } finally { setBusy(false) }
  }

  if (boot === null) return <div className="card muted">Loading…</div>
  if ('error' in boot) {
    return (
      <div className="card" style={{ display: 'grid', gap: 12 }}>
        <div className="alert error">Could not load: {boot.error}</div>
        <button className="btn" onClick={() => { setBoot(null); void load() }}>Try again</button>
      </div>
    )
  }

  const busName = (id: string) => boot.buses.find((b) => b.id === id)?.name ?? id
  const routeName = (id: string) => boot.routes.find((r) => r.id === id)?.name ?? id
  const fix = gps.fix
  const accTone = fix?.accuracy == null ? '' : fix.accuracy <= 20 ? 'ok' : fix.accuracy <= 50 ? 'warn' : 'bad'

  return (
    <>
      <div className="card">
        <div className="row">
          <h2>Driver Dashboard</h2>
          <Link to="/" className="muted">Map</Link>
        </div>
        <div className="row">
          <span className="muted">Logged in as <b>{user.name}</b></span>
          {!tracking && <button className="btn btn-small" onClick={() => void logout()}>Log out</button>}
        </div>
      </div>

      {message && <div className="alert error">{message}</div>}
      {boot.buses.length === 0 && trip === null && <div className="alert">No bus is assigned to your account. Ask an admin to assign one.</div>}

      {trip === null ? (
        <div className="card" style={{ display: 'grid', gap: 12 }}>
          <label>Bus
            <select value={busId} onChange={(e) => setBusId(e.target.value)}>
              <option value="" disabled>Select a bus</option>
              {boot.buses.map((b) => (
                <option key={b.id} value={b.id} disabled={b.tripId !== null || b.status === 'DISABLED'}>
                  {b.name}{b.tripId !== null ? ' (in use)' : b.status === 'DISABLED' ? ' (out of service)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>Route
            <select value={routeId} onChange={(e) => setRouteId(e.target.value)}>
              {boot.routes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <div className="muted">Start from DG Corner so the bus is tracked in the right direction.</div>
          <button className="btn btn-primary" disabled={busy || !busId || !routeId} onClick={start}>START TRIP</button>
        </div>
      ) : (
        <div className="card" style={{ display: 'grid', gap: 12 }}>
          <div>
            <h3>Trip in progress</h3>
            <div className="muted">{busName(trip.busId)} · {routeName(trip.routeId)} · started {new Date(trip.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
          </div>
          {!tracking && <button className="btn btn-primary" onClick={() => { setAttempt((a) => a + 1); setTracking(true) }}>Resume tracking</button>}
          <button className="btn btn-danger" disabled={busy} onClick={end}>END TRIP</button>
        </div>
      )}

      {tracking && (
        <div className="card" style={{ display: 'grid', gap: 8 }}>
          <div className="row">
            <h3>GPS Status</h3>
            {gps.gpsError && gps.gpsError !== 'timeout' ? <span className="badge bad">⚠ No GPS</span>
              : fix ? <span className="badge ok">🟢 GPS active</span> : <span className="badge warn">Waiting for GPS…</span>}
          </div>

          {gps.gpsError && <div className="alert error">{GPS_ERRORS[gps.gpsError]}</div>}
          {gps.gpsError && <button className="btn btn-small" onClick={() => setAttempt((a) => a + 1)}>Retry GPS</button>}

          {fix && (
            <div className="mono">
              <div>Accuracy: <span className={`badge ${accTone}`}>{fix.accuracy === null ? 'unknown' : `${Math.round(fix.accuracy)} m`}</span></div>
              <div className="muted">{fix.lat.toFixed(5)}, {fix.lng.toFixed(5)}{fix.speed !== null && ` · ${msToKmh(fix.speed)} km/h`}</div>
            </div>
          )}
          {gps.poorAccuracy && <div className="alert">GPS accuracy is poor, so this location isn’t being sent. Move to an open area.</div>}

          <div className="muted">
            {gps.sendState === 'idle' && 'Waiting to send the first location…'}
            {gps.sendState === 'sending' && gps.lastSentAt === null && 'Sending…'}
            {(gps.sendState === 'ok' || (gps.sendState === 'sending' && gps.lastSentAt !== null)) && gps.lastSentAt !== null && `✓ Sent ${formatAge((now - gps.lastSentAt) / 1000)}`}
            {gps.sendState === 'offline' && `No connection. Retrying (${gps.failedSends} failed).${gps.lastSentAt ? ` Last sent ${formatAge((now - gps.lastSentAt) / 1000)}.` : ''}`}
            {gps.sendState === 'rejected' && `Server rejected the location: ${gps.rejection}`}
            {gps.parked && gps.sendState !== 'offline' && ' Standing still: repeating your position every few seconds.'}
          </div>
          <div className="muted">
            {screenOn ? 'Screen will stay on.' : 'Keep this page open and the screen on: browsers pause GPS in the background.'}
          </div>
        </div>
      )}

      <div className="card" style={{ display: 'grid', gap: 12 }}>
        <label>Send location every
          <select value={intervalS} onChange={(e) => { const n = Number(e.target.value); setIntervalS(n); store.set('gpsIntervalS', String(n)) }}>
            {INTERVALS_S.map((s) => <option key={s} value={s}>{s} seconds</option>)}
          </select>
        </label>
        {DEV && (
          <>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={simulate} disabled={tracking} onChange={(e) => setSimulate(e.target.checked)} style={{ padding: 0 }} />
              Dev: simulate a drive around Route A instead of real GPS
            </label>
            {simulate && (
              <label>Simulated speed (m/s)
                <input type="number" min={1} max={30} value={simSpeed} disabled={tracking} onChange={(e) => setSimSpeed(Number(e.target.value) || 8)} />
              </label>
            )}
          </>
        )}
      </div>
    </>
  )
}
