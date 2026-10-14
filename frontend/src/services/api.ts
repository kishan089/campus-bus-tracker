import { freshAccessToken, getAccessToken, refreshSession } from './auth'
import type {
  ActiveTrip, AdminBus, AdminRoute, AdminRouteDetail, AdminStop, AdminTrip, AdminTripDetail, AdminUser, AuditEntry, Bus, Fix,
  Overview, RoutePreview, RouteSummary, Thresholds,
} from './types'

// "/api" is proxied to the backend in dev; set VITE_API_URL to the backend origin for production builds.
export const API_BASE: string = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/$/, '')

export class ApiError extends Error {
  status: number // 0 = the server could not be reached
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

interface Opts { body?: unknown; token?: string | null; signal?: AbortSignal }

async function request<T>(method: string, path: string, { body, token, signal }: Opts = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`

  let res: Response
  try {
    res = await fetch(API_BASE + path, { method, headers, signal, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server')
  }
  if (res.status === 204) return undefined as T

  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { /* non-JSON error page */ }
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? `HTTP_${res.status}`, data?.error?.message ?? res.statusText)
  return data as T
}

/** A request for a signed-in user: refreshes the token shortly before it expires, and once more if the server still says 401. */
async function authed<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await freshAccessToken()
  try {
    return await request<T>(method, path, { body, token })
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && token) {
      await refreshSession() // throws 401 if the session is really over, which signs the user out
      return request<T>(method, path, { body, token: getAccessToken() })
    }
    throw e
  }
}

export const api = {
  buses: (signal?: AbortSignal) => request<Bus[]>('GET', '/buses', { signal }),
  routes: (signal?: AbortSignal) => request<RouteSummary[]>('GET', '/routes', { signal }),
  config: (signal?: AbortSignal) => request<{ status: Thresholds }>('GET', '/config', { signal }),
}

export const driverApi = {
  activeTrip: () => authed<{ trip: ActiveTrip | null }>('GET', '/trips/active').then((r) => r.trip),
  startTrip: (busId: string, routeId: string) => authed<ActiveTrip>('POST', '/trips/start', { busId, routeId }),
  endTrip: () => authed<{ tripId: number }>('POST', '/trips/end'),
  sendLocation: (fix: Fix) => authed<void>('POST', '/location', fix),
}

type Pt = [number, number]
const qs = (o: Record<string, string | number | undefined>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
  return p.length ? `?${p.join('&')}` : ''
}

export const adminApi = {
  overview: () => authed<Overview>('GET', '/admin/overview'),
  audit: (limit = 50) => authed<AuditEntry[]>('GET', `/admin/audit${qs({ limit })}`),

  buses: () => authed<AdminBus[]>('GET', '/admin/buses'),
  createBus: (b: { name: string; registrationNumber?: string | null }) => authed<AdminBus>('POST', '/admin/buses', b),
  updateBus: (id: string, b: { name?: string; registrationNumber?: string | null; active?: boolean }) => authed<AdminBus>('PATCH', `/admin/buses/${id}`, b),
  deleteBus: (id: string) => authed<void>('DELETE', `/admin/buses/${id}`),

  users: () => authed<AdminUser[]>('GET', '/admin/users'),
  createUser: (u: { name: string; email: string; role: 'DRIVER' | 'ADMIN'; password?: string }) =>
    authed<{ user: AdminUser; temporaryPassword: string | null }>('POST', '/admin/users', u),
  updateUser: (id: number, u: { name?: string; active?: boolean; role?: 'DRIVER' | 'ADMIN'; password?: string }) => authed<AdminUser>('PATCH', `/admin/users/${id}`, u),
  setUserBuses: (id: number, busIds: string[]) => authed<AdminUser>('PUT', `/admin/users/${id}/buses`, { busIds }),
  deleteUser: (id: number) => authed<void>('DELETE', `/admin/users/${id}`),

  stops: () => authed<AdminStop[]>('GET', '/admin/stops'),
  createStop: (s: { name: string; lat: number; lng: number }) => authed<AdminStop>('POST', '/admin/stops', s),
  updateStop: (id: string, s: { name?: string; lat?: number; lng?: number }) => authed<AdminStop>('PATCH', `/admin/stops/${id}`, s),
  deleteStop: (id: string) => authed<void>('DELETE', `/admin/stops/${id}`),

  routes: () => authed<AdminRoute[]>('GET', '/admin/routes'),
  route: (id: string) => authed<AdminRouteDetail>('GET', `/admin/routes/${id}`),
  previewRoute: (points: Pt[]) => authed<RoutePreview>('POST', '/admin/routes/preview', { points }),
  createRoute: (r: { name: string; color?: string; points: Pt[] }) => authed<AdminRoute>('POST', '/admin/routes', r),
  updateRoute: (id: string, r: { name?: string; color?: string; active?: boolean; points?: Pt[] }) => authed<AdminRoute>('PUT', `/admin/routes/${id}`, r),
  deleteRoute: (id: string) => authed<void>('DELETE', `/admin/routes/${id}`),

  trips: (q: { status?: string; busId?: string; before?: number; limit?: number } = {}) =>
    authed<{ trips: AdminTrip[]; nextBefore: number | null }>('GET', `/admin/trips${qs(q)}`),
  trip: (id: number) => authed<AdminTripDetail>('GET', `/admin/trips/${id}`),
  endTrip: (id: number) => authed<{ tripId: number }>('POST', `/admin/trips/${id}/end`),
}
