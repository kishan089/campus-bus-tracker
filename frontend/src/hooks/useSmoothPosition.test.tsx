// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LatLng } from '../utils/geo'
import { lerpLatLng, useSmoothPosition } from './useSmoothPosition'

beforeEach(() => { vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] }) })
afterEach(() => { vi.useRealTimers() })

const A: LatLng = [25.2632, 82.9876]
const B: LatLng = [25.2632, 82.9886] // ~100 m east

describe('useSmoothPosition', () => {
  it('lerps', () => expect(lerpLatLng([0, 0], [10, 20], 0.5)).toEqual([5, 10]))

  it('glides to a new target, passing through the midpoint', () => {
    const { result, rerender } = renderHook(({ t }) => useSmoothPosition(t, 1000), { initialProps: { t: A } })
    expect(result.current).toEqual(A)
    rerender({ t: B })
    act(() => { vi.advanceTimersByTime(500) })
    expect(result.current[1]).toBeGreaterThan(A[1])
    expect(result.current[1]).toBeLessThan(B[1])
    act(() => { vi.advanceTimersByTime(600) })
    expect(result.current).toEqual(B)
  })

  it('starts the next glide from where the marker currently is', () => {
    const C: LatLng = [25.2632, 82.9890] // 40 m beyond B, still under the snap distance
    const { result, rerender } = renderHook(({ t }) => useSmoothPosition(t, 1000), { initialProps: { t: A } })
    rerender({ t: B })
    act(() => { vi.advanceTimersByTime(500) })
    const mid = result.current[1]
    rerender({ t: C })
    act(() => { vi.advanceTimersByTime(16) })
    expect(result.current[1]).toBeGreaterThanOrEqual(mid) // no jump back to A or forward to B
    expect(result.current[1]).toBeLessThan(mid + 0.0001)
  })

  it('snaps on big jumps instead of sweeping across campus', () => {
    const far: LatLng = [25.2732, 82.9876] // ~1.1 km
    const { result, rerender } = renderHook(({ t }) => useSmoothPosition(t), { initialProps: { t: A } })
    rerender({ t: far })
    expect(result.current).toEqual(far)
  })
})
