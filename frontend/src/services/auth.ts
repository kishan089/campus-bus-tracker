import { API_BASE, ApiError } from './api'
import type { SessionUser } from './types'

/**
 * The session lives in memory only:
 *  - the short-lived access token (15 min) is a JavaScript variable, so a script that reads storage finds nothing;
 *  - the long-lived refresh token is an httpOnly cookie that JavaScript cannot read at all.
 * A page reload therefore starts with no token and quietly trades the cookie for a new one (restoreSession).
 */
let accessToken: string | null = null
let expiresAt = 0
let user: SessionUser | null = null
let restored = false
const listeners = new Set<() => void>()

export interface SessionSnapshot { status: 'loading' | 'anon' | 'authed'; user: SessionUser | null }
let snapshot: SessionSnapshot = { status: 'loading', user: null }

function publish() {
  snapshot = { status: !restored ? 'loading' : user ? 'authed' : 'anon', user }
  listeners.forEach((fn) => fn())
}
function setSession(r: { accessToken: string; expiresIn: number; user: SessionUser } | null) {
  restored = true // any definite answer (signed in, or told to sign in again) ends the "loading" state
  accessToken = r?.accessToken ?? null
  expiresAt = r ? Date.now() + r.expiresIn * 1000 : 0
  user = r?.user ?? null
  publish()
}

export const getSession = () => snapshot
export const getAccessToken = () => accessToken
export function subscribeSession(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } }

async function post(path: string, body?: unknown): Promise<Response> {
  try {
    return await fetch(API_BASE + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'fetch', ...(body ? { 'content-type': 'application/json' } : {}) }, // the header the server requires for cookie endpoints
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server')
  }
}

async function readError(res: Response): Promise<ApiError> {
  let data: any = null
  try { data = await res.json() } catch { /* not JSON */ }
  return new ApiError(res.status, data?.error?.code ?? `HTTP_${res.status}`, data?.error?.message ?? res.statusText)
}

export async function login(email: string, password: string): Promise<SessionUser> {
  const res = await post('/auth/login', { email, password })
  if (!res.ok) throw await readError(res)
  setSession(await res.json())
  return user!
}

let inflight: Promise<void> | null = null
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Gets a new access token with the cookie. One refresh at a time, however many requests ask for it.
 * Throws ApiError(0) if the server can't be reached (stay signed in, try later) or 401 if the session is really gone.
 */
export function refreshSession(): Promise<void> {
  inflight ??= (async () => {
    try {
      let res = await post('/auth/refresh')
      // Another tab may have refreshed a moment ago, which makes our cookie one step old. The browser now holds the
      // newer one, so a single retry after a short pause succeeds.
      if (res.status === 401) { await sleep(400); res = await post('/auth/refresh') }
      if (!res.ok) {
        const err = await readError(res)
        if (err.status === 401) setSession(null)
        throw err
      }
      setSession(await res.json())
    } finally {
      inflight = null
    }
  })()
  return inflight
}

let restoring: Promise<void> | null = null
/** On page load: if the cookie is still good, sign back in without asking for the password. */
export function restoreSession(): Promise<void> {
  restoring ??= refreshSession()
    .catch(() => { /* not signed in, or offline: either way the login form is the right screen */ })
    .finally(() => { restored = true; publish() })
  return restoring
}

/** A token that is valid for at least the next half minute, or null if not signed in. */
export async function freshAccessToken(): Promise<string | null> {
  if (accessToken && expiresAt - Date.now() < 30_000) await refreshSession()
  return accessToken
}

export async function logout(): Promise<void> {
  try { await post('/auth/logout') } catch { /* offline: still sign out locally */ }
  setSession(null)
}

/** Test helper */
export function __resetSession() { accessToken = null; expiresAt = 0; user = null; restored = false; inflight = null; restoring = null; publish() }
