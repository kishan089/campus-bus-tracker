// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetSession, getAccessToken, getSession, login, logout, refreshSession, restoreSession } from './auth'
import { error, fakeServer, headersOf, json, session } from './testServer'

beforeEach(() => { __resetSession() })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('session store', () => {
  it('starts "loading" until the first restore attempt finishes', () => {
    expect(getSession().status).toBe('loading')
  })

  it('login keeps the token in memory and the user in the snapshot', async () => {
    const s = fakeServer({ 'POST /auth/login': () => session('tok-1') })
    const user = await login('driver@example.com', 'pw')
    expect(user).toMatchObject({ role: 'DRIVER', buses: [{ id: 'bus-1' }] })
    expect(getAccessToken()).toBe('tok-1')
    expect(JSON.parse(s.calls[0].init.body as string)).toEqual({ email: 'driver@example.com', password: 'pw' })
    expect(localStorage.length + sessionStorage.length).toBe(0) // nothing is written to browser storage
  })

  it('a failed login leaves the user signed out and reports why', async () => {
    fakeServer({ 'POST /auth/login': error(401, 'INVALID_CREDENTIALS', 'Wrong email or password') })
    const e = await login('a@b.co', 'bad').catch((x) => x)
    expect([e.status, e.code]).toEqual([401, 'INVALID_CREDENTIALS'])
    expect(getAccessToken()).toBeNull()
  })

  it('restoreSession signs back in from the cookie, with the header the server requires', async () => {
    const s = fakeServer({ 'POST /auth/refresh': () => session('tok-9') })
    await restoreSession()
    expect(getSession()).toMatchObject({ status: 'authed', user: { name: 'Dev Driver' } })
    expect(headersOf(s.calls[0].init)['x-requested-with']).toBe('fetch')
  })

  it('restoreSession ends as "anon" when there is no valid cookie, or the server is down', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    fakeServer({ 'POST /auth/refresh': error(401, 'UNAUTHENTICATED') })
    const p = restoreSession()
    await vi.advanceTimersByTimeAsync(500)
    await p
    expect(getSession().status).toBe('anon')

    __resetSession()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    await restoreSession()
    expect(getSession().status).toBe('anon')
  })

  it('refreshSession is single-flight', async () => {
    const s = fakeServer({ 'POST /auth/refresh': async () => { await new Promise((r) => setTimeout(r, 10)); return session('tok-2') } })
    await Promise.all([refreshSession(), refreshSession(), refreshSession()])
    expect(s.count('POST /auth/refresh')).toBe(1)
  })

  it('a refresh that loses a race with another tab succeeds on the retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const s = fakeServer({ 'POST /auth/refresh': [error(401, 'UNAUTHENTICATED'), session('tok-3')] })
    const p = refreshSession()
    await vi.advanceTimersByTimeAsync(500)
    await p
    expect(s.count('POST /auth/refresh')).toBe(2)
    expect(getAccessToken()).toBe('tok-3')
  })

  it('logout clears the session, even when the server cannot be reached', async () => {
    fakeServer({ 'POST /auth/login': () => session('tok-1') })
    await login('driver@example.com', 'pw')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    await logout()
    expect(getSession()).toMatchObject({ status: 'anon', user: null })
    expect(getAccessToken()).toBeNull()
  })

  it('logout tells the server so the refresh token is revoked', async () => {
    const s = fakeServer({ 'POST /auth/login': () => session('tok-1'), 'POST /auth/logout': () => new Response(null, { status: 204 }) })
    await login('driver@example.com', 'pw')
    await logout()
    expect(s.count('POST /auth/logout')).toBe(1)
  })
})
void json
