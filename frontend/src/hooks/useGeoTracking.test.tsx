// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../services/api'
import type { Fix } from '../services/types'
import type { FixSource, GpsErrorKind } from './gpsSources'
import { useGeoTracking } from './useGeoTracking'

const fix = (o: Partial<Fix> = {}): Fix => ({ lat: 25.26, lng: 82.99, speed: 5, accuracy: 8, heading: null, ts: Date.now(), ...o })

function harness(send: (f: Fix) => Promise<void>, enabled = true) {
  let onFix!: (f: Fix) => void
  let onErr!: (k: GpsErrorKind) => void
  const unsubscribe = vi.fn()
  const subscribe = vi.fn()
  const source: FixSource = (f, e) => { onFix = f; onErr = e; subscribe(); return unsubscribe }
  const onFatal = vi.fn()
  const hook = renderHook((p: { enabled: boolean }) =>
    useGeoTracking({ enabled: p.enabled, intervalMs: 3000, maxAccuracyM: 100, source, send, onFatal }),
    { initialProps: { enabled } })
  return {
    hook, onFatal, unsubscribe, subscribe,
    emit: (f: Fix = fix()) => act(async () => { onFix(f) }),
    fail: (k: GpsErrorKind) => act(async () => { onErr(k) }),
  }
}
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }) })
afterEach(() => { vi.useRealTimers() })

describe('useGeoTracking', () => {
  it('sends the first fix immediately, then at most once per interval', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const h = harness(send)
    await h.emit(); expect(send).toHaveBeenCalledTimes(1)
    expect(h.hook.result.current.sendState).toBe('ok')
    advance(1000); await h.emit(); expect(send).toHaveBeenCalledTimes(1)   // inside the interval
    advance(2500); await h.emit(); expect(send).toHaveBeenCalledTimes(2)   // 3.5 s since the first send
  })

  it('shows a poor-accuracy fix but does not send it', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const h = harness(send)
    await h.emit(fix({ accuracy: 250 }))
    expect(send).not.toHaveBeenCalled()
    expect(h.hook.result.current.poorAccuracy).toBe(true)
    expect(h.hook.result.current.fix?.accuracy).toBe(250)
    await h.emit(fix({ accuracy: 10 }))
    expect(send).toHaveBeenCalledTimes(1)
    expect(h.hook.result.current.poorAccuracy).toBe(false)
  })

  it('goes offline on network failure and recovers on the next interval', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new ApiError(0, 'NETWORK', 'down'))
      .mockRejectedValueOnce(new ApiError(0, 'NETWORK', 'down'))
      .mockResolvedValue(undefined)
    const h = harness(send)
    await h.emit()
    expect(h.hook.result.current).toMatchObject({ sendState: 'offline', failedSends: 1 })
    advance(3100); await h.emit()
    expect(h.hook.result.current.failedSends).toBe(2)
    advance(3100); await h.emit()
    expect(h.hook.result.current).toMatchObject({ sendState: 'ok', failedSends: 0 })
    expect(h.hook.result.current.lastSentAt).not.toBeNull()
  })

  it('does not stack sends while one is in flight', async () => {
    let release!: () => void
    const send = vi.fn(() => new Promise<void>((r) => { release = r }))
    const h = harness(send)
    await h.emit()
    advance(5000); await h.emit()
    expect(send).toHaveBeenCalledTimes(1)
    await act(async () => release())
    advance(5000); await h.emit()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('reports server rejections without stopping', async () => {
    const send = vi.fn().mockRejectedValue(new ApiError(422, 'ACCURACY_TOO_LOW', 'GPS accuracy worse than 100 m'))
    const h = harness(send)
    await h.emit()
    expect(h.hook.result.current).toMatchObject({ sendState: 'rejected', rejection: 'GPS accuracy worse than 100 m' })
    expect(h.onFatal).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'UNAUTHENTICATED'],
    [409, 'NO_ACTIVE_TRIP'],
  ])('treats %i %s as fatal', async (status, code) => {
    const h = harness(vi.fn().mockRejectedValue(new ApiError(status, code, 'x')))
    await h.emit()
    expect(h.onFatal).toHaveBeenCalledTimes(1)
  })

  it('surfaces GPS errors and clears them when a fix arrives', async () => {
    const h = harness(vi.fn().mockResolvedValue(undefined))
    await h.fail('denied')
    expect(h.hook.result.current.gpsError).toBe('denied')
    await h.emit()
    expect(h.hook.result.current.gpsError).toBeNull()
  })

  it('only subscribes while enabled and unsubscribes when disabled', async () => {
    const h = harness(vi.fn().mockResolvedValue(undefined), false)
    expect(h.subscribe).not.toHaveBeenCalled()
    h.hook.rerender({ enabled: true })
    expect(h.subscribe).toHaveBeenCalledTimes(1)
    h.hook.rerender({ enabled: false })
    expect(h.unsubscribe).toHaveBeenCalledTimes(1)
    expect(h.hook.result.current.fix).toBeNull()
  })
})

describe('parked heartbeat', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] }) })
  afterEach(() => { vi.useRealTimers() })
  const standing = (o: Partial<Fix> = {}) => fix({ speed: 0, accuracy: 8, ...o })
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

  it('repeats a standing bus’s position when the phone goes quiet, with a fresh timestamp and zero speed', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const h = harness(send)
    await h.emit(standing({ lat: 25.2632, lng: 82.9876, heading: 90 }))
    expect(send).toHaveBeenCalledTimes(1)
    await tick(10_500)
    expect(send).toHaveBeenCalledTimes(2)
    const beat = send.mock.calls[1][0] as Fix
    expect(beat).toMatchObject({ lat: 25.2632, lng: 82.9876, speed: 0, heading: null })
    expect(Math.abs(beat.ts - Date.now())).toBeLessThan(1500)
    expect(h.hook.result.current.parked).toBe(true)
    await tick(10_000)
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('does nothing while real fixes keep arriving', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const h = harness(send)
    for (let i = 0; i < 6; i++) { await h.emit(standing()); await tick(3500) } // a fix every 3.5 s, over 20 s
    expect(send.mock.calls.length).toBeLessThanOrEqual(7) // the normal 3 s throttle, no extra heartbeats
    expect(h.hook.result.current.parked).toBe(false)
  })

  it('never repeats a bus that was moving: silence there is a real GPS problem and must show', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const h = harness(send)
    await h.emit(fix({ speed: 8 }))
    await tick(60_000)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the phone gave no speed, or a poor-accuracy fix', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const a = harness(send)
    await a.emit(fix({ speed: null })); await tick(30_000)
    expect(send).toHaveBeenCalledTimes(1)
    const sendB = vi.fn().mockResolvedValue(undefined)
    const b = harness(sendB)
    await b.emit(standing({ accuracy: 250 })); await tick(30_000)
    expect(sendB).not.toHaveBeenCalled()
  })

  it('gives up after 15 minutes without a real fix, so a dead GPS shows up as stale', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const h = harness(send)
    await h.emit(standing())
    await tick(14 * 60_000)
    const beforeLimit = send.mock.calls.length
    expect(beforeLimit).toBeGreaterThan(50)
    await tick(2 * 60_000)
    const afterLimit = send.mock.calls.length
    await tick(60_000)
    expect(send.mock.calls.length).toBe(afterLimit) // stopped
  })

  it('treats a failed heartbeat like any failed send, and a lost trip as fatal', async () => {
    const send = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ApiError(0, 'NETWORK', 'down')).mockResolvedValue(undefined)
    const h = harness(send)
    await h.emit(standing()); await tick(10_500)
    expect(h.hook.result.current).toMatchObject({ sendState: 'offline', failedSends: 1 })
    h.hook.unmount()

    const gone = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ApiError(409, 'NO_ACTIVE_TRIP', 'x')).mockResolvedValue(undefined)
    const h2 = harness(gone)
    await h2.emit(standing()); await tick(10_500)
    expect(h2.onFatal).toHaveBeenCalledTimes(1)
    h2.hook.unmount()
  })

  it('stops the timer when tracking stops', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const h = harness(send)
    await h.emit(standing())
    h.hook.rerender({ enabled: false })
    await tick(60_000)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
