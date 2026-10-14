// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserGpsSource } from './gpsSources'

function mockGeolocation() {
  let ok!: (p: any) => void
  let err!: (e: any) => void
  const clearWatch = vi.fn()
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { watchPosition: vi.fn((o, e) => { ok = o; err = e; return 7 }), clearWatch },
  })
  return { position: (p: any) => ok(p), fail: (code: number) => err({ code }), clearWatch }
}
afterEach(() => { Reflect.deleteProperty(navigator, 'geolocation') })

describe('browserGpsSource', () => {
  it('maps a position and sanitises odd browser values', () => {
    const g = mockGeolocation()
    const onFix = vi.fn()
    browserGpsSource(onFix, vi.fn())
    g.position({ timestamp: 1000, coords: { latitude: 25.26, longitude: 82.99, accuracy: 12, speed: -0.2, heading: NaN } })
    expect(onFix).toHaveBeenCalledWith({ lat: 25.26, lng: 82.99, accuracy: 12, speed: 0, heading: null, ts: 1000 })
    g.position({ timestamp: 2000, coords: { latitude: 1, longitude: 2, accuracy: 5, speed: null, heading: -90 } })
    expect(onFix).toHaveBeenLastCalledWith(expect.objectContaining({ speed: null, heading: 270 }))
  })

  it('maps error codes and stops watching on unsubscribe', () => {
    const g = mockGeolocation()
    const onError = vi.fn()
    const stop = browserGpsSource(vi.fn(), onError)
    g.fail(1); g.fail(2); g.fail(3)
    expect(onError.mock.calls.map((c) => c[0])).toEqual(['denied', 'unavailable', 'timeout'])
    stop()
    expect(g.clearWatch).toHaveBeenCalledWith(7)
  })

  it('reports browsers without geolocation', () => {
    const onError = vi.fn()
    browserGpsSource(vi.fn(), onError)
    expect(onError).toHaveBeenCalledWith('unsupported')
  })
})
