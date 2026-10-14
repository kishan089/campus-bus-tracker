import { useState } from 'react'
import OverviewView from '../../components/admin/OverviewView'
import { confirmAction, ErrorNote, run } from '../../components/admin/ui'
import { useAsync } from '../../hooks/useAsync'
import { adminApi } from '../../services/api'

export default function OverviewPage() {
  const { data, error, reload } = useAsync(() => adminApi.overview(), [], 5000)
  const [actionError, setActionError] = useState<string | null>(null)

  return (
    <>
      <ErrorNote error={actionError ?? (data ? null : error)} />
      {data && error && <div className="alert">Can’t refresh right now ({error}). Showing the last data.</div>}
      {!data && !error && <div className="card muted">Loading…</div>}
      {data && (
        <OverviewView o={data} onEndTrip={(id, name) => {
          if (confirmAction(`End the trip on ${name}? Use this when the driver's phone has died or the page was closed.`))
            void run(() => adminApi.endTrip(id), setActionError, reload)
        }} />
      )}
    </>
  )
}
