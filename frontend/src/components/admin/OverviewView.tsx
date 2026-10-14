import { formatAge, formatDuration } from '../../utils/format'
import type { Overview } from '../../services/types'
import { Card, StatusBadge } from './ui'

const ACTION_TEXT: Record<string, string> = {
  'bus.create': 'added bus', 'bus.update': 'edited bus', 'bus.enable': 'enabled bus', 'bus.disable': 'disabled bus', 'bus.delete': 'deleted bus',
  'user.create': 'created account', 'user.update': 'edited account', 'user.enable': 'enabled account', 'user.disable': 'disabled account',
  'user.reset-password': 'reset the password of', 'user.assign-buses': 'changed bus assignments for', 'user.delete': 'deleted account',
  'stop.create': 'added stop', 'stop.update': 'edited stop', 'stop.delete': 'deleted stop',
  'route.create': 'added route', 'route.update': 'edited route', 'route.update-path': 'changed the path of route', 'route.delete': 'deleted route',
  'trip.force-end': 'ended trip',
}

/** GPS health is flagged when the phone's fixes are inaccurate, sparse, or far from the route. */
export function healthProblems(h: NonNullable<Overview['buses'][number]['health']>): string[] {
  const out: string[] = []
  if (h.avgAccuracyM !== null && h.avgAccuracyM > 50) out.push(`inaccurate (${h.avgAccuracyM} m)`)
  if (h.avgIntervalS !== null && h.avgIntervalS > 15) out.push(`sparse (every ${h.avgIntervalS} s)`)
  if (h.maxOffRouteM !== null && h.maxOffRouteM > 30) out.push(`off route (${h.maxOffRouteM} m)`)
  return out
}

/** Latency and errors on this server over the last few minutes; flagged when slow or failing. */
export function apiProblems(a: NonNullable<Overview['system']['api']>): string[] {
  const out: string[] = []
  if (a.p95Ms !== null && a.p95Ms > 500) out.push(`slow (95% of requests under ${a.p95Ms} ms)`)
  if (a.serverErrors > 0) out.push(`${a.serverErrors} server error${a.serverErrors === 1 ? '' : 's'}`)
  if (a.rateLimited > 0) out.push(`${a.rateLimited} request${a.rateLimited === 1 ? '' : 's'} limited`)
  return out
}

function ApiHealth({ api }: { api: NonNullable<Overview['system']['api']> }) {
  const problems = apiProblems(api)
  return (
    <div className="card row" data-testid="api-health">
      <span>
        <b>API, last {api.windowMinutes} min:</b> {api.requests} requests ({api.perMinute}/min)
        {api.p50Ms !== null && ` · median ${api.p50Ms} ms, 95% under ${api.p95Ms} ms`}
      </span>
      {problems.length ? <span className="badge warn">{problems.join(' · ')}</span> : <span className="badge ok">healthy</span>}
    </div>
  )
}

export default function OverviewView({ o, onEndTrip }: { o: Overview; onEndTrip: (tripId: number, busName: string) => void }) {
  const s = o.stats
  return (
    <>
      <div className="grid stats">
        <Card><div className="stat"><b>{s.activeBuses}<span className="muted"> / {s.totalBuses}</span></b><span className="muted">Buses reporting</span></div></Card>
        <Card><div className="stat"><b>{s.activeTrips}</b><span className="muted">Trips in progress</span></div></Card>
        <Card><div className="stat"><b>{s.onlineDrivers}</b><span className="muted">Drivers online</span></div></Card>
        <Card><div className="stat"><b>{s.connectedViewers}</b><span className="muted">Students connected</span></div></Card>
        <Card><div className="stat"><b>{s.fixesLastHour}</b><span className="muted">GPS fixes, last hour</span></div></Card>
      </div>

      <div className="muted" data-testid="system">
        Database: {o.system.db} · Redis: {o.system.redis} · Server up {formatDuration(o.system.uptimeSeconds)} · {o.system.wsConnections} live connections
      </div>
      {o.yourAddress && (
        <div className="muted" data-testid="your-address">
          Your address as the server sees it: <b>{o.yourAddress}</b>. If this is not your real public IP, the server is seeing the host's proxy instead of people, and the
          hosting setting <code>TRUST_PROXY_HOPS</code> needs changing (one rate limit would be shared by everyone).
        </div>
      )}
      {o.system.api && <ApiHealth api={o.system.api} />}

      <Card title="Buses">
        {o.buses.length === 0 && <div className="muted">No buses yet. Add one under Buses.</div>}
        <div className="scroll-x">
          <table className="data">
            <thead><tr><th>Bus</th><th>Status</th><th>Driver</th><th>Speed</th><th>Updated</th><th>GPS health (last 5 min)</th></tr></thead>
            <tbody>
              {o.buses.map((b) => {
                const problems = b.health ? healthProblems(b.health) : []
                return (
                  <tr key={b.id} data-testid={`bus-row-${b.id}`}>
                    <td><b>{b.name}</b></td>
                    <td><StatusBadge status={b.status} /></td>
                    <td>{b.driver?.name ?? '–'}</td>
                    <td>{b.speedKmh !== null && ['LIVE', 'DELAYED'].includes(b.status) ? `${b.speedKmh} km/h` : '–'}</td>
                    <td>{b.ageSeconds !== null ? formatAge(b.ageSeconds) : b.lastSeenAt ? `last seen ${new Date(b.lastSeenAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '–'}</td>
                    <td>
                      {!b.health ? <span className="muted">no fixes</span> : (
                        <>
                          <span>{b.health.fixes} fixes{b.health.avgIntervalS !== null && `, every ${b.health.avgIntervalS} s`}{b.health.avgAccuracyM !== null && `, ±${b.health.avgAccuracyM} m`}</span>
                          {problems.length > 0 && <div><span className="badge warn">{problems.join(' · ')}</span></div>}
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid two">
        <Card title="Trips in progress">
          {o.trips.length === 0 && <div className="muted">No trips right now.</div>}
          {o.trips.map((t) => (
            <div className="row" key={t.id}>
              <div>
                <b>{t.busName}</b> · {t.driverName}
                <div className="muted">since {new Date(t.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
              </div>
              <button className="btn btn-small btn-danger" onClick={() => onEndTrip(t.id, t.busName)}>End trip</button>
            </div>
          ))}
        </Card>
        <Card title="Recent changes">
          {o.audit.length === 0 && <div className="muted">Nothing yet.</div>}
          {o.audit.map((a) => (
            <div key={a.id} className="muted">
              {new Date(a.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              {' · '}<b style={{ color: 'var(--text)' }}>{a.userName ?? 'Someone'}</b> {ACTION_TEXT[a.action] ?? a.action}{a.target && ` ${a.target}`}
            </div>
          ))}
        </Card>
      </div>
    </>
  )
}
