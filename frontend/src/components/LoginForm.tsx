import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError } from '../services/api'
import { login } from '../services/auth'

const DEV = import.meta.env.DEV

/** What went wrong, in words the person at the keyboard can act on. Development builds also say how to fix it. */
export function loginErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'INVALID_CREDENTIALS') return 'Wrong email or password.'
    if (e.code === 'TOO_MANY_ATTEMPTS') return e.message
    if (e.status === 400) return 'Enter a valid email and your password.'
    if (e.status === 0) return 'Cannot reach the server. Check your connection.'
    if (e.code === 'INTERNAL')
      return DEV ? 'The server hit an error. If you just updated the app, run "npm run migrate" in the backend folder and restart it. The backend window shows the details.'
        : 'The server hit an error. Try again in a minute.'
    if (e.code === 'DB_UNAVAILABLE')
      return DEV ? 'The backend cannot reach the database. Is Docker running ("docker compose up -d")?' : 'The service is temporarily unavailable. Try again in a minute.'
    if (e.status >= 500) // e.g. the dev proxy answering 502 because nothing is listening behind it
      return DEV ? `Cannot reach the backend (error ${e.status}). Is it running? Start it with "npm run dev" in the backend folder.` : 'The server is not responding. Try again in a minute.'
  }
  return 'Could not sign in. Try again.'
}

export default function LoginForm({ title }: { title: string }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try { await login(email.trim(), password) }
    catch (err) { setError(loginErrorMessage(err)); setPassword('') }
    finally { setBusy(false) }
  }

  return (
    <form className="card" style={{ display: 'grid', gap: 12 }} onSubmit={submit}>
      <h2>{title}</h2>
      <label>Email
        <input type="email" autoComplete="username" autoCapitalize="none" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>Password
        <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <div className="alert error" role="alert">{error}</div>}
      <button className="btn btn-primary" type="submit" disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      <Link to="/" className="muted">← Back to the map</Link>
    </form>
  )
}
