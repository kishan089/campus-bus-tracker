// Test helper: a fake fetch that answers by "METHOD /path" and records what it was asked.
import { vi } from 'vitest'

type Fn = (init: RequestInit, url: string) => Response | Promise<Response>
export type Handler = Fn | Response // a plain Response is replayed (cloned) for every matching request
export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
export const error = (status: number, code: string, message = code) => json({ error: { code, message } }, status)
export const session = (token: string, expiresIn = 900) => json({
  accessToken: token, expiresIn,
  user: { id: 1, name: 'Dev Driver', email: 'driver@example.com', role: 'DRIVER', buses: [{ id: 'bus-1', name: 'Bus 1' }] },
})

export function fakeServer(routes: Record<string, Handler | Handler[]>) {
  const calls: { key: string; init: RequestInit }[] = []
  const queues = new Map<string, Handler[]>(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]))
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace(/^\/api/, '')}`
    calls.push({ key, init })
    const q = queues.get(key)
    if (!q?.length) throw new Error(`unexpected request: ${key}`)
    const h = q.length > 1 ? q.shift()! : q[0] // the last handler repeats
    return typeof h === 'function' ? h(init, url) : h.clone()
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, count: (key: string) => calls.filter((c) => c.key === key).length }
}
export const headersOf = (init: RequestInit) => init.headers as Record<string, string>
