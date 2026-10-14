import type { ReactNode } from 'react'
import type { BusStatus } from '../../services/types'

export const STATUS_BADGE: Record<BusStatus, { text: string; tone: '' | 'ok' | 'warn' | 'bad' }> = {
  LIVE: { text: '🟢 Running', tone: 'ok' },
  DELAYED: { text: '🟡 GPS delayed', tone: 'warn' },
  POSSIBLY_OFFLINE: { text: '🟠 Possibly offline', tone: 'warn' },
  OFFLINE: { text: '🔴 Offline', tone: 'bad' },
  LOCATION_UNAVAILABLE: { text: '⚪ Waiting for GPS', tone: '' },
  NOT_OPERATING: { text: '⚫ Not running', tone: '' },
  DISABLED: { text: '⛔ Out of service', tone: '' },
}

export function StatusBadge({ status }: { status: BusStatus }) {
  const s = STATUS_BADGE[status]
  return <span className={`badge ${s.tone}`}>{s.text}</span>
}

export function Card({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card" style={{ display: 'grid', gap: 10 }}>
      {(title || actions) && <div className="row">{title && <h2>{title}</h2>}{actions}</div>}
      {children}
    </section>
  )
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? <div className="alert error" role="alert">{error}</div> : null
}

/** Runs an admin action, shows its error, and refreshes the page data afterwards. */
export async function run(action: () => Promise<unknown>, onError: (m: string | null) => void, then?: () => void) {
  onError(null)
  try { await action(); then?.() }
  catch (e) { onError(e instanceof Error ? e.message : 'Something went wrong') }
}

export const confirmAction = (message: string) => window.confirm(message)
