// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bus } from '../services/types'
import type { WsEvent } from '../services/socket'

const h = vi.hoisted(() => ({
  handlers: new Set<(e: any) => void>(),
  sockHandlers: new Map<string, () => void>(),
  sock: { connected: false, on: vi.fn(), off: vi.fn() } as any,
}))

vi.mock('../services/socket', () => {
  h.sock.on = (ev: string, fn: () => void) => { h.sockHandlers.set(ev, fn) }
  h.sock.off = (ev: string) => { h.sockHandlers.delete(ev) }
  return { getSocket: () => h.sock, subscribe: (fn: (e: any) => void) => { h.handlers.add(fn); return () => h.handlers.delete(fn) } }
})
vi.mock('../services/api', async (orig) => {
  const actual = await orig<typeof import('../services/api')>()
  return { ...actual, api: { buses: vi.fn(), routes: vi.fn(), config: vi.fn() } }
})

import { api } from '../services/api'
import { useBuses } from './useBuses'

const emit = (e: WsEvent) => act(() => { h.handlers.forEach((fn) => fn(e)) })
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

const idle: Bus = { id: 'bus-1', name: 'Bus 1', status: 'NOT_OPERATING', routeId: null, tripId: null, lastSeenAt: null, location: null }
const loc = (receivedAt: string, ageSeconds: number) => ({
  lat: 25.26, lng: 82.99, speed: 5, accuracy: 8, heading: null, recordedAt: receivedAt, receivedAt, ageSeconds,
})

beforeEach(() => {
  vi.useFakeTimers()
  h.handlers.clear(); h.sockHandlers.clear()
  vi.mocked(api.buses).mockReset().mockResolvedValue([idle])
  vi.mocked(api.config).mockReset().mockResolvedValue({ status: { liveS: 15, delayedS: 120, offlineS: 600 } })
})
afterEach(() => { cleanup(); vi.useRealTimers(); Object.defineProperty(document, 'hidden', { configurable: true, value: false }) }) // unmount every hook: their timers and document listeners must not leak into the next test

async function mount() {
  const hook = renderHook(() => useBuses())
  await tick(0)
  return hook
}

describe('useBuses', () => {
  it('loads buses, then patches them from WebSocket events', async () => {
    const { result } = await mount()
    expect(result.current.buses?.[0].status).toBe('NOT_OPERATING')

    emit({ type: 'BUS_TRIP_STARTED', busId: 'bus-1', routeId: 'route-a', tripId: 42 })
    expect(result.current.buses?.[0]).toMatchObject({ status: 'LOCATION_UNAVAILABLE', tripId: 42, routeId: 'route-a' })

    emit({ type: 'BUS_LOCATION_UPDATED', busId: 'bus-1', lat: 25.1, lng: 82.9, speed: 4, accuracy: 7, heading: null, ts: Date.now(), receivedAt: new Date().toISOString(), progress: null })
    expect(result.current.buses?.[0]).toMatchObject({ status: 'LIVE', location: { lat: 25.1, lng: 82.9 } })

    expect(result.current.buses?.[0].progress).toBeNull()

    const progress = { s: 700, offRouteM: 1, onRoute: true, position: { lat: 25.1, lng: 82.9 }, speedEstMps: 5, next: null, etas: {} }
    emit({ type: 'BUS_LOCATION_UPDATED', busId: 'bus-1', lat: 25.1, lng: 82.9, speed: 4, accuracy: 7, heading: null, ts: Date.now(), receivedAt: new Date().toISOString(), progress })
    expect(result.current.buses?.[0].progress).toEqual(progress) // server-computed, passed straight through

    emit({ type: 'BUS_TRIP_ENDED', busId: 'bus-1' })
    expect(result.current.buses?.[0]).toMatchObject({ status: 'NOT_OPERATING', tripId: null, location: null, progress: null })
  })

  it('a silent bus ages LIVE → DELAYED → POSSIBLY_OFFLINE → OFFLINE with no further events', async () => {
    const { result } = await mount()
    emit({ type: 'BUS_TRIP_STARTED', busId: 'bus-1', routeId: 'route-a', tripId: 1 })
    emit({ type: 'BUS_LOCATION_UPDATED', busId: 'bus-1', lat: 25.1, lng: 82.9, speed: 4, accuracy: 7, heading: null, ts: Date.now(), receivedAt: new Date().toISOString(), progress: null })
    expect(result.current.buses?.[0].status).toBe('LIVE')
    // from now on the "server" reports the same fix getting older, as the real one would at each 30 s safety-net refetch
    const fixAt = Date.now()
    vi.mocked(api.buses).mockImplementation(async () => [{ ...idle, status: 'LIVE', tripId: 1, location: loc(new Date(fixAt).toISOString(), (Date.now() - fixAt) / 1000) }])
    await tick(16_000); expect(result.current.buses?.[0].status).toBe('DELAYED')
    await tick(110_000); expect(result.current.buses?.[0].status).toBe('POSSIBLY_OFFLINE')
    await tick(500_000); expect(result.current.buses?.[0].status).toBe('OFFLINE')
    expect(result.current.buses?.[0].location?.ageSeconds).toBeGreaterThan(600)
  })

  it('ages from the server-reported age, not by comparing timestamps with this phone’s clock', async () => {
    // receivedAt says year 2000 (as if this phone's clock were 26 years off); the server says the fix is 5 s old
    vi.mocked(api.buses).mockResolvedValue([{ ...idle, status: 'LIVE', tripId: 1, location: loc('2000-01-01T00:00:00Z', 5) }])
    const { result } = await mount()
    expect(result.current.buses?.[0].status).toBe('LIVE')
    expect(result.current.buses?.[0].location?.ageSeconds).toBeGreaterThanOrEqual(5)
    expect(result.current.buses?.[0].location?.ageSeconds).toBeLessThan(7)
  })

  it('refetches when the socket (re)connects', async () => {
    await mount()
    expect(api.buses).toHaveBeenCalledTimes(1)
    await act(async () => { h.sockHandlers.get('connect')!() })
    expect(api.buses).toHaveBeenCalledTimes(2)
  })

  it('refetches when a location arrives for a bus it thinks is idle (missed the trip start)', async () => {
    await mount()
    emit({ type: 'BUS_LOCATION_UPDATED', busId: 'bus-1', lat: 25.1, lng: 82.9, speed: 4, accuracy: 7, heading: null, ts: Date.now(), receivedAt: new Date().toISOString(), progress: null })
    await tick(0)
    expect(api.buses).toHaveBeenCalledTimes(2)
  })

  it('falls back to default thresholds when /config fails', async () => {
    vi.mocked(api.config).mockRejectedValue(new Error('down'))
    vi.mocked(api.buses).mockResolvedValue([{ ...idle, status: 'LIVE', tripId: 1, location: loc('2026-01-01T00:00:00Z', 20) }])
    const { result } = await mount()
    expect(result.current.buses?.[0].status).toBe('DELAYED') // 20 s > default 15 s
  })

  it('keeps the last data and reports an error when a refresh fails', async () => {
    const { result } = await mount()
    vi.mocked(api.buses).mockRejectedValue(new Error('network'))
    await tick(30_000)
    expect(result.current.error).not.toBeNull()
    expect(result.current.buses).toHaveLength(1)
  })

  it('keeps trying every few seconds until the first answer (a sleeping free host takes a while to wake)', async () => {
    vi.mocked(api.buses).mockReset().mockRejectedValueOnce(new Error('502')).mockRejectedValueOnce(new Error('502')).mockResolvedValue([idle])
    const { result } = renderHook(() => useBuses())
    await tick(0)
    expect(result.current.buses).toBeNull()
    await tick(5_000); expect(result.current.buses).toBeNull()
    await tick(5_000)
    expect(result.current.buses).toHaveLength(1)
    const calls = vi.mocked(api.buses).mock.calls.length
    await tick(5_000)
    expect(vi.mocked(api.buses).mock.calls.length).toBe(calls) // answered: the 5 s retry stops
  })

  it('does no polling while the tab is hidden, and catches up when it is shown again', async () => {
    await mount()
    const hide = (hidden: boolean) => { Object.defineProperty(document, 'hidden', { configurable: true, value: hidden }); document.dispatchEvent(new Event('visibilitychange')) }
    const before = vi.mocked(api.buses).mock.calls.length
    hide(true)
    await tick(95_000)
    expect(vi.mocked(api.buses).mock.calls.length).toBe(before)
    hide(false)
    await tick(0)
    expect(vi.mocked(api.buses).mock.calls.length).toBe(before + 1)
  })
})
