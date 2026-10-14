import type { ReactNode } from 'react'
import { useSession } from '../hooks/useSession'
import { logout } from '../services/auth'
import type { SessionUser } from '../services/types'
import LoginForm from './LoginForm'

/** Shows the sign-in form until someone with the right role is signed in. The server enforces the role again on every request. */
export default function RequireRole({ role, title, children }: { role: SessionUser['role']; title: string; children: (user: SessionUser) => ReactNode }) {
  const { status, user } = useSession()
  if (status === 'loading') return <div className="card muted">Loading…</div>
  if (!user) return <LoginForm title={title} />
  if (user.role !== role) {
    return (
      <div className="card" style={{ display: 'grid', gap: 12 }}>
        <div className="alert error">This account ({user.email}) can’t open this page.</div>
        <button className="btn" onClick={() => void logout()}>Sign out</button>
      </div>
    )
  }
  return <>{children(user)}</>
}
