import type { Bus } from '../services/types'
import type { ApiError } from '../services/api'
import { useEffect, useState } from 'react'
import BusCard from './BusCard'

export interface BusListProps {
  buses: Bus[] | null
  error: ApiError | null
  connected: boolean
  towards: Record<string, { name: string; metres: number; seconds: number } | null>
  offRoute: Record<string, boolean>
  onLocate: (bus: Bus) => void
}

/** Free hosting sleeps when idle and takes up to a minute to wake, so after a few seconds say what is going on. */
export function Loading() {
  const [slow, setSlow] = useState(false)
  useEffect(() => { const t = setTimeout(() => setSlow(true), 5000); return () => clearTimeout(t) }, [])
  return (
    <div className="card muted">
      Loading buses…
      {slow && <div style={{ marginTop: 6 }}>The server is waking up after being idle. This can take up to a minute; it will load by itself.</div>}
    </div>
  )
}

export default function BusList({ buses, error, connected, towards, offRoute, onLocate }: BusListProps) {
  if (buses === null) {
    return error
      ? <div className="alert error">Can’t load buses ({error.message}). Retrying…</div>
      : <Loading />
  }
  const showDisconnected = error !== null || !connected

  return (
    <>
      {showDisconnected && <div className="alert">Connection lost. Waiting to reconnect...</div>}
      {buses.length === 0 && <div className="card muted">No buses are set up yet.</div>}
      {buses.map((b) => (
        <BusCard
          key={b.id} bus={b}
          ageSeconds={b.location ? b.location.ageSeconds : null}
          towards={towards[b.id]} offRoute={offRoute[b.id]}
          onLocate={() => onLocate(b)}
        />
      ))}
    </>
  )
}
