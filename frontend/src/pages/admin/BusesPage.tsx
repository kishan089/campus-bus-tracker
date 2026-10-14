import { useState } from 'react'
import { Card, confirmAction, ErrorNote, run } from '../../components/admin/ui'
import { useAsync } from '../../hooks/useAsync'
import { adminApi } from '../../services/api'
import type { AdminBus } from '../../services/types'

function Row({ bus, onChange, onError }: { bus: AdminBus; onChange: () => void; onError: (m: string | null) => void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(bus.name)
  const [reg, setReg] = useState(bus.registrationNumber ?? '')

  return (
    <tr>
      <td>
        {editing ? <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Bus name" /> : <b>{bus.name}</b>}
        <div className="muted">{bus.id}</div>
      </td>
      <td>{editing ? <input value={reg} onChange={(e) => setReg(e.target.value)} aria-label="Registration number" /> : bus.registrationNumber ?? '–'}</td>
      <td>{bus.drivers.length ? bus.drivers.map((d) => d.name).join(', ') : <span className="muted">no driver assigned</span>}</td>
      <td>{bus.active ? <span className="badge ok">In service</span> : <span className="badge bad">Disabled</span>}{bus.hasActiveTrip && <span className="badge warn" style={{ marginLeft: 4 }}>Trip running</span>}</td>
      <td className="actions">
        {editing ? (
          <>
            <button className="btn btn-small btn-primary" onClick={() => void run(() => adminApi.updateBus(bus.id, { name, registrationNumber: reg.trim() || null }), onError, () => { setEditing(false); onChange() })}>Save</button>
            <button className="btn btn-small" onClick={() => { setEditing(false); setName(bus.name); setReg(bus.registrationNumber ?? '') }}>Cancel</button>
          </>
        ) : (
          <>
            <button className="btn btn-small" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn btn-small" onClick={() => {
              if (bus.active && !confirmAction(`Take ${bus.name} out of service? Drivers won't be able to start trips on it.`)) return
              void run(() => adminApi.updateBus(bus.id, { active: !bus.active }), onError, onChange)
            }}>{bus.active ? 'Disable' : 'Enable'}</button>
            <button className="btn btn-small" onClick={() => {
              if (confirmAction(bus.hasHistory ? `${bus.name} has trip history, so it can't be deleted. Disable it instead.` : `Delete ${bus.name}? This can't be undone.`) && !bus.hasHistory)
                void run(() => adminApi.deleteBus(bus.id), onError, onChange)
            }}>Delete</button>
          </>
        )}
      </td>
    </tr>
  )
}

export default function BusesPage() {
  const { data, error, reload } = useAsync(() => adminApi.buses(), [])
  const [actionError, setActionError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [reg, setReg] = useState('')

  return (
    <>
      <ErrorNote error={actionError ?? error} />
      <Card title="Add a bus">
        <div className="form-row">
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Bus 2" /></label>
          <label>Registration number (optional)<input value={reg} onChange={(e) => setReg(e.target.value)} placeholder="UP65 AB 1234" /></label>
          <button className="btn btn-primary" disabled={!name.trim()} onClick={() => void run(() => adminApi.createBus({ name: name.trim(), registrationNumber: reg.trim() || null }), setActionError, () => { setName(''); setReg(''); reload() })}>Add bus</button>
        </div>
      </Card>
      <Card title="Buses">
        {!data && !error && <div className="muted">Loading…</div>}
        <div className="scroll-x">
          <table className="data">
            <thead><tr><th>Bus</th><th>Registration</th><th>Drivers</th><th>Status</th><th /></tr></thead>
            <tbody>{data?.map((b) => <Row key={`${b.id}-${b.name}-${b.registrationNumber}`} bus={b} onChange={reload} onError={setActionError} />)}</tbody>
          </table>
        </div>
        <div className="muted">Assign a bus to a driver under Accounts.</div>
      </Card>
    </>
  )
}
