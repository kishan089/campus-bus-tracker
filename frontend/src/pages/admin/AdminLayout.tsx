import { NavLink, Outlet } from 'react-router-dom'
import RequireRole from '../../components/RequireRole'
import { logout } from '../../services/auth'

const LINKS: [string, string][] = [['/admin', 'Overview'], ['/admin/buses', 'Buses'], ['/admin/drivers', 'Accounts'], ['/admin/stops', 'Stops'], ['/admin/routes', 'Routes'], ['/admin/trips', 'Trips']]

export default function AdminLayout() {
  return (
    <div className="page" style={{ maxWidth: 'none', padding: 0 }}>
      <RequireRole role="ADMIN" title="Admin sign-in">
        {(user) => (
          <div className="admin">
            <div className="card row">
              <nav className="admin-nav">
                {LINKS.map(([to, label]) => <NavLink key={to} to={to} end={to === '/admin'} className={({ isActive }) => (isActive ? 'active' : '')}>{label}</NavLink>)}
              </nav>
              <div className="actions">
                <span className="muted">{user.name}</span>
                <NavLink to="/" className="btn btn-small" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none', color: 'inherit' }}>Map</NavLink>
                <button className="btn btn-small" onClick={() => void logout()}>Sign out</button>
              </div>
            </div>
            <Outlet context={user} />
          </div>
        )}
      </RequireRole>
    </div>
  )
}
