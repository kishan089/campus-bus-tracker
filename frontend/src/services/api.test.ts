// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adminApi, api, ApiError, driverApi } from './api'
import { __resetSession, getAccessToken, getSession, login } from './auth'
import { error, fakeServer, headersOf, json, session } from './testServer'

beforeEach(() => { __resetSession() })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

const signIn = async (extra: Parameters<typeof fakeServer>[0] = {}, expiresIn = 900) => {
  const server = fakeServer({ 'POST /auth/login': () => session('tok-1', expiresIn), ...extra })
  await login('driver@example.com', 'pw')
  return server
}

describe('public calls', () => {
  it('go to /api and carry no credentials header', async () => {
    const s = fakeServer({ 'GET /buses': json([{ id: 'bus-1' }]) })
    expect(await api.buses()).toEqual([{ id: 'bus-1' }])
    expect(headersOf(s.calls[0].init).authorization).toBeUndefined()
  })
  it('report an unreachable server as status 0', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const e = await api.buses().catch((x) => x)
    expect([e.status, e.code]).toEqual([0, 'NETWORK'])
  })
  it('survive a non-JSON error page', async () => {
    fakeServer({ 'GET /buses': () => new Response('<html>Bad gateway</html>', { status: 502 }) })
    const e = await api.buses().catch((x) => x)
    expect([e.status, e.code]).toEqual([502, 'HTTP_502'])
  })
})

describe('signed-in calls', () => {
  it('send the bearer token and a JSON body, and return undefined for 204', async () => {
    const s = await signIn({ 'POST /location': () => new Response(null, { status: 204 }) })
    const fix = { lat: 25.2, lng: 82.9, speed: null, accuracy: 8, heading: null, ts: 1 }
    expect(await driverApi.sendLocation(fix)).toBeUndefined()
    const { init } = s.calls.find((c) => c.key === 'POST /location')!
    expect(headersOf(init).authorization).toBe('Bearer tok-1')
    expect(JSON.parse(init.body as string)).toEqual(fix)
  })

  it('map server errors to ApiError with the server code', async () => {
    await signIn({ 'POST /trips/end': error(409, 'NO_ACTIVE_TRIP', 'Start a trip') })
    const e = await driverApi.endTrip().catch((x) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect([e.status, e.code, e.message]).toEqual([409, 'NO_ACTIVE_TRIP', 'Start a trip'])
  })

  it('unwrap the active trip and the admin user list', async () => {
    await signIn({ 'GET /trips/active': json({ trip: null }), 'GET /admin/users': json([{ id: 1 }]) })
    expect(await driverApi.activeTrip()).toBeNull()
    expect(await adminApi.users()).toEqual([{ id: 1 }])
  })

  it('refresh once and retry when the server says the token has expired', async () => {
    const s = await signIn({
      'GET /trips/active': [error(401, 'TOKEN_EXPIRED'), json({ trip: null })],
      'POST /auth/refresh': () => session('tok-2'),
    })
    expect(await driverApi.activeTrip()).toBeNull()
    expect(s.count('POST /auth/refresh')).toBe(1)
    const retry = s.calls.filter((c) => c.key === 'GET /trips/active')[1]
    expect(headersOf(retry.init).authorization).toBe('Bearer tok-2')
  })

  it('refresh before sending when the token is about to expire', async () => {
    const s = await signIn({ 'GET /trips/active': json({ trip: null }), 'POST /auth/refresh': () => session('tok-2') }, 10)
    await driverApi.activeTrip()
    const order = s.calls.map((c) => c.key)
    expect(order.indexOf('POST /auth/refresh')).toBeLessThan(order.indexOf('GET /trips/active'))
    expect(headersOf(s.calls.at(-1)!.init).authorization).toBe('Bearer tok-2')
  })

  it('share one refresh between requests that need it at the same moment', async () => {
    const s = await signIn({
      'GET /trips/active': json({ trip: null }), 'POST /trips/end': json({ tripId: 1 }),
      'POST /auth/refresh': async () => { await new Promise((r) => setTimeout(r, 20)); return session('tok-2') },
    }, 10)
    await Promise.all([driverApi.activeTrip(), driverApi.endTrip()])
    expect(s.count('POST /auth/refresh')).toBe(1)
  })

  it('sign the user out when the session cannot be renewed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    await signIn({ 'GET /trips/active': error(401, 'TOKEN_EXPIRED'), 'POST /auth/refresh': error(401, 'UNAUTHENTICATED') })
    const pending = driverApi.activeTrip().catch((x) => x)
    await vi.advanceTimersByTimeAsync(500)
    expect((await pending).status).toBe(401)
    expect(getSession().status).toBe('anon')
    expect(getAccessToken()).toBeNull()
  })

  it('stay signed in when the refresh fails only because the network is down', async () => {
    const s = await signIn({ 'GET /trips/active': error(401, 'TOKEN_EXPIRED') })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { if (String(url).endsWith('/auth/refresh')) throw new TypeError('offline'); return error(401, 'TOKEN_EXPIRED') }))
    const e = await driverApi.activeTrip().catch((x) => x)
    expect(e.status).toBe(0)
    expect(getSession().status).toBe('authed')
    void s
  })
})

describe('admin calls', () => {
  it('use the right verbs, paths and bodies, and send the bearer token', async () => {
    const ok = () => json({})
    const s = await signIn({
      'GET /admin/overview': ok, 'POST /admin/buses': ok, 'PATCH /admin/buses/bus-9': ok, 'DELETE /admin/buses/bus-9': () => new Response(null, { status: 204 }),
      'PUT /admin/users/3/buses': ok, 'PATCH /admin/users/3': ok, 'POST /admin/routes/preview': ok, 'PUT /admin/routes/route-a': ok,
      'GET /admin/trips?status=ACTIVE&busId=bus-1&before=40': json({ trips: [], nextBefore: null }), 'POST /admin/trips/7/end': ok,
    })
    await adminApi.overview()
    await adminApi.createBus({ name: 'Bus 9', registrationNumber: null })
    await adminApi.updateBus('bus-9', { active: false })
    expect(await adminApi.deleteBus('bus-9')).toBeUndefined()
    await adminApi.setUserBuses(3, ['bus-1'])
    await adminApi.updateUser(3, { password: 'a-new-password-1' })
    await adminApi.previewRoute([[25.1, 82.9], [25.2, 83]])
    await adminApi.updateRoute('route-a', { active: false })
    await adminApi.trips({ status: 'ACTIVE', busId: 'bus-1', before: 40 })
    await adminApi.endTrip(7)

    const body = (key: string) => JSON.parse(s.calls.find((c) => c.key === key)!.init.body as string)
    expect(body('POST /admin/buses')).toEqual({ name: 'Bus 9', registrationNumber: null })
    expect(body('PUT /admin/users/3/buses')).toEqual({ busIds: ['bus-1'] })
    expect(body('POST /admin/routes/preview')).toEqual({ points: [[25.1, 82.9], [25.2, 83]] })
    expect(s.calls.filter((c) => c.key.includes('/admin/')).every((c) => headersOf(c.init).authorization === 'Bearer tok-1')).toBe(true)
  })

  it('leave empty filters out of the trips query', async () => {
    const s = await signIn({ 'GET /admin/trips': json({ trips: [], nextBefore: null }) })
    await adminApi.trips({ status: '', busId: '' })
    expect(s.calls.at(-1)!.key).toBe('GET /admin/trips')
  })
})
