import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Card, confirmAction, ErrorNote, run } from '../../components/admin/ui'
import { useAsync } from '../../hooks/useAsync'
import { adminApi } from '../../services/api'
import type { AdminBus, AdminUser, SessionUser } from '../../services/types'
import { generatePassword } from '../../utils/routeInput'

/** Shown once: the only time anyone can read a generated password. */
function Secret({ who, password, onDone }: { who: string; password: string; onDone: () => void }) {
  return (
    <div className="card" style={{ display: 'grid', gap: 8, borderColor: 'var(--warn)' }} role="status">
      <b>Password for {who}</b>
      <div className="secret">{password}</div>
      <div className="muted">Copy it now and give it to them. It is not stored in a readable form and can't be shown again; to get a new one, reset it.</div>
      <div className="actions">
        <button className="btn btn-small" onClick={() => void navigator.clipboard?.writeText(password)}>Copy</button>
        <button className="btn btn-small btn-primary" onClick={onDone}>Done</button>
      </div>
    </div>
  )
}

function UserRow({ user, me, buses, onChange, onError, onSecret }: {
  user: AdminUser; me: SessionUser; buses: AdminBus[]
  onChange: () => void; onError: (m: string | null) => void; onSecret: (who: string, pw: string) => void
}) {
  const [open, setOpen] = useState(false)
  const self = user.id === me.id
  return (
    <>
      <tr>
        <td><b>{user.name}</b>{self && <span className="muted"> (you)</span>}<div className="muted">{user.email}</div></td>
        <td><span className="badge">{user.role}</span></td>
        <td>{user.active ? <span className="badge ok">Active</span> : <span className="badge bad">Disabled</span>}</td>
        <td>{user.role === 'DRIVER' ? (user.buses.length ? user.buses.join(', ') : <span className="muted">none</span>) : '–'}</td>
        <td className="actions">
          {user.role === 'DRIVER' && <button className="btn btn-small" onClick={() => setOpen(!open)}>{open ? 'Close' : 'Buses'}</button>}
          <button className="btn btn-small" onClick={() => {
            if (!confirmAction(`Reset the password for ${user.name}? They will be signed out everywhere.`)) return
            const pw = generatePassword()
            void run(() => adminApi.updateUser(user.id, { password: pw }), onError, () => { onSecret(user.name, pw); onChange() })
          }}>Reset password</button>
          {!self && (
            <button className="btn btn-small" onClick={() => {
              if (user.active && !confirmAction(`Disable ${user.name}? They will be signed out right away.`)) return
              void run(() => adminApi.updateUser(user.id, { active: !user.active }), onError, onChange)
            }}>{user.active ? 'Disable' : 'Enable'}</button>
          )}
          {!self && (
            <button className="btn btn-small" onClick={() => {
              if (confirmAction(`Delete ${user.name}? If they have trip history this is refused; disable them instead.`))
                void run(() => adminApi.deleteUser(user.id), onError, onChange)
            }}>Delete</button>
          )}
        </td>
      </tr>
      {open && (
        <tr><td colSpan={5}>
          <div className="actions" role="group" aria-label={`Buses for ${user.name}`}>
            {buses.map((b) => (
              <label key={b.id} style={{ flexDirection: 'row', display: 'flex', gap: 6, alignItems: 'center', color: 'var(--text)' }}>
                <input type="checkbox" style={{ padding: 0 }} checked={user.buses.includes(b.id)} onChange={(e) => {
                  const next = e.target.checked ? [...user.buses, b.id] : user.buses.filter((x) => x !== b.id)
                  void run(() => adminApi.setUserBuses(user.id, next), onError, onChange)
                }} />
                {b.name}{!b.active && ' (disabled)'}
              </label>
            ))}
            {buses.length === 0 && <span className="muted">No buses yet.</span>}
          </div>
        </td></tr>
      )}
    </>
  )
}

export default function DriversPage() {
  const me = useOutletContext<SessionUser>()
  const users = useAsync(() => adminApi.users(), [])
  const buses = useAsync(() => adminApi.buses(), [])
  const [actionError, setActionError] = useState<string | null>(null)
  const [secret, setSecret] = useState<{ who: string; password: string } | null>(null)
  const [form, setForm] = useState({ name: '', email: '', role: 'DRIVER' as 'DRIVER' | 'ADMIN' })

  return (
    <>
      <ErrorNote error={actionError ?? users.error} />
      {secret && <Secret who={secret.who} password={secret.password} onDone={() => setSecret(null)} />}
      <Card title="Add an account">
        <div className="form-row">
          <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label>Role
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'DRIVER' | 'ADMIN' })}>
              <option value="DRIVER">Driver</option><option value="ADMIN">Admin</option>
            </select>
          </label>
          <button className="btn btn-primary" disabled={!form.name.trim() || !form.email.trim()} onClick={() => void run(async () => {
            const r = await adminApi.createUser({ name: form.name.trim(), email: form.email.trim(), role: form.role })
            if (r.temporaryPassword) setSecret({ who: r.user.name, password: r.temporaryPassword })
            setForm({ name: '', email: '', role: 'DRIVER' })
          }, setActionError, users.reload)}>Create</button>
        </div>
        <div className="muted">A password is generated for you and shown once.</div>
      </Card>
      <Card title="Accounts">
        {!users.data && !users.error && <div className="muted">Loading…</div>}
        <div className="scroll-x">
          <table className="data">
            <thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Buses</th><th /></tr></thead>
            <tbody>
              {users.data?.map((u) => (
                <UserRow key={u.id} user={u} me={me} buses={buses.data ?? []} onChange={users.reload} onError={setActionError}
                  onSecret={(who, password) => setSecret({ who, password })} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  )
}
