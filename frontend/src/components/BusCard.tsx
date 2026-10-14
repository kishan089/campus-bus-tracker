import type { Bus, BusStatus } from '../services/types'
import { formatAge, formatDistance, formatEta } from '../utils/format'

const LABEL: Record<BusStatus, { icon: string; text: string; tone: 'ok' | 'warn' | 'bad' | 'idle' }> = {
  LIVE: { icon: '🟢', text: 'Running', tone: 'ok' },
  DELAYED: { icon: '🟡', text: 'GPS update delayed', tone: 'warn' },
  POSSIBLY_OFFLINE: { icon: '🟠', text: 'Possibly offline', tone: 'warn' },
  OFFLINE: { icon: '🔴', text: 'Offline', tone: 'bad' },
  LOCATION_UNAVAILABLE: { icon: '⚪', text: 'Location unavailable', tone: 'idle' },
  NOT_OPERATING: { icon: '⚫', text: 'Not running', tone: 'idle' },
  DISABLED: { icon: '⛔', text: 'Out of service', tone: 'idle' },
}

export interface BusCardProps {
  bus: Bus
  /** seconds since the server last received a fix, already advanced to "now"; null when unknown */
  ageSeconds: number | null
  towards?: { name: string; metres: number; seconds: number } | null
  offRoute?: boolean
  onLocate?: () => void
}

export default function BusCard({ bus, ageSeconds, towards, offRoute, onLocate }: BusCardProps) {
  const l = LABEL[bus.status]
  const hasPosition = bus.location !== null
  const moving = bus.status === 'LIVE' || bus.status === 'DELAYED'

  return (
    <div className="card" data-testid={`bus-${bus.id}`}>
      <div className="row">
        <h3>{bus.name}</h3>
        <span className={`badge ${l.tone === 'idle' ? '' : l.tone}`}>{l.icon} {l.text}</span>
      </div>

      {hasPosition && ageSeconds !== null && <div className="muted">Last updated: {formatAge(ageSeconds)}</div>}
      {!hasPosition && bus.status === 'NOT_OPERATING' && bus.lastSeenAt && (
        <div className="muted">Last seen: {new Date(bus.lastSeenAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
      )}
      {bus.status === 'LOCATION_UNAVAILABLE' && <div className="muted">Trip started, waiting for the first GPS fix</div>}
      {hasPosition && !moving && <div className="muted">Showing the last known position</div>}

      {moving && towards && <div>Towards <b>{towards.name}</b> · ETA: {formatEta(towards.seconds)} <span className="muted">({formatDistance(towards.metres)})</span></div>}
      {moving && offRoute && <div className="muted">Bus is away from its route</div>}

      {hasPosition && onLocate && (
        <button className="btn btn-small" style={{ marginTop: 8 }} onClick={onLocate}>View on map</button>
      )}
    </div>
  )
}
