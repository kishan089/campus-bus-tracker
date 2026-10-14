import type { Bus, EtaEntry } from '../services/types'
import { formatDistance, formatEta } from '../utils/format'
import { isMoving } from '../utils/status'

export interface StopArrivalsProps {
  stops: { id: string; name: string }[]
  stopId: string | null
  onSelect: (id: string | null) => void
  buses: Bus[] | null
}

interface Row { bus: Bus; e: EtaEntry; etaSeconds: number }

const ARRIVING_M = 30
const ARRIVING_S = 20

export default function StopArrivals({ stops, stopId, onSelect, buses }: StopArrivalsProps) {
  const rows: Row[] = []
  for (const bus of stopId && buses ? buses : []) {
    const e = isMoving(bus.status) && bus.location ? bus.progress?.etas[stopId!] : undefined
    // the ETA was computed when the fix arrived; the fix has aged since, so the bus is that much closer
    if (e) rows.push({ bus, e, etaSeconds: Math.max(0, e.etaSeconds - bus.location!.ageSeconds) })
  }
  rows.sort((a, b) => a.etaSeconds - b.etaSeconds)
  const anyRunning = (buses ?? []).some((b) => isMoving(b.status))

  return (
    <div className="card" data-testid="stop-arrivals">
      <label>Your stop
        <select value={stopId ?? ''} onChange={(e) => onSelect(e.target.value || null)}>
          <option value="">Choose your stop…</option>
          {stops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>

      {!stopId && <div className="muted" style={{ marginTop: 6 }}>Pick your stop to see when the next bus arrives.</div>}
      {stopId && buses !== null && rows.length === 0 && (
        <div className="muted" style={{ marginTop: 6 }}>
          {anyRunning
            ? 'A bus is running but is away from its route, so there is no arrival time yet.'
            : 'No bus is running right now.'}
        </div>
      )}

      {rows.map(({ bus, e, etaSeconds }) => (
        <div key={bus.id} style={{ marginTop: 8 }} data-testid={`arrival-${bus.id}`}>
          <div className="row">
            <b>{bus.name}</b>
            {bus.status === 'DELAYED' && <span className="badge warn">GPS delayed</span>}
          </div>
          {e.justPassed ? (
            <>
              <div>Just passed{e.behindM !== null && ` (${e.behindM} m ago)`}</div>
              <div className="muted">Next arrival {formatEta(etaSeconds)}{e.headingTo && ` · towards ${e.headingTo}`}</div>
            </>
          ) : e.metres <= ARRIVING_M || etaSeconds < ARRIVING_S ? (
            <div>Arriving now</div>
          ) : (
            <>
              <div>{formatEta(etaSeconds)} <span className="muted">({formatDistance(e.metres)})</span></div>
              {e.headingTo && <div className="muted">Towards {e.headingTo}</div>}
            </>
          )}
        </div>
      ))}
    </div>
  )
}
