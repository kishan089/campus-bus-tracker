// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../services/api'
import type { Bus } from '../services/types'
import BusList, { type BusListProps } from './BusList'

afterEach(cleanup)

const bus = (o: Partial<Bus> = {}, age = 12): Bus => ({
  id: 'bus-1', name: 'Bus 1', status: 'LIVE', routeId: 'route-a', tripId: 1,
  lastSeenAt: '2026-10-01T09:11:00Z',
  location: { lat: 25.26, lng: 82.99, speed: 5, accuracy: 8, heading: null,
    recordedAt: '2026-10-01T09:11:00Z', receivedAt: '2026-10-01T09:11:00Z', ageSeconds: age },
  ...o,
})

function show(over: Partial<BusListProps> = {}) {
  const props: BusListProps = {
    buses: [bus()], error: null, connected: true, towards: {}, offRoute: {}, onLocate: vi.fn(), ...over,
  }
  render(<BusList {...props} />)
  return props
}

describe('BusList states', () => {
  it('loading', () => {
    show({ buses: null })
    expect(screen.getByText('Loading buses…')).toBeTruthy()
  })

  it('API failure before any data', () => {
    show({ buses: null, error: new ApiError(0, 'NETWORK', 'Cannot reach the server') })
    expect(screen.getByText(/Can’t load buses/)).toBeTruthy()
  })

  it('no buses', () => {
    show({ buses: [] })
    expect(screen.getByText('No buses are set up yet.')).toBeTruthy()
  })

  it('bus running: status, age, direction and ETA', () => {
    show({ towards: { 'bus-1': { name: 'LT1', metres: 228, seconds: 45 } } })
    expect(screen.getByText('🟢 Running')).toBeTruthy()
    expect(screen.getByText('Last updated: 12 s ago')).toBeTruthy()
    expect(screen.getByText('LT1')).toBeTruthy()
    expect(screen.getByText(/ETA: ~1 min/)).toBeTruthy()
    expect(screen.getByText(/228 m/)).toBeTruthy()
    expect(screen.queryByText(/Connection lost/)).toBeNull()
  })

  it('GPS stale: delayed', () => {
    show({ buses: [bus({ status: 'DELAYED' }, 40)] })
    expect(screen.getByText('🟡 GPS update delayed')).toBeTruthy()
    expect(screen.getByText('Last updated: 40 s ago')).toBeTruthy()
  })

  it('offline: marks the position as last known and gives no direction', () => {
    show({ buses: [bus({ status: 'OFFLINE' }, 700)], towards: { 'bus-1': { name: 'LT1', metres: 5, seconds: 1 } } })
    expect(screen.getByText('🔴 Offline')).toBeTruthy()
    expect(screen.getByText('Showing the last known position')).toBeTruthy()
    expect(screen.queryByText(/Towards/)).toBeNull()
  })

  it('not operating: shows last seen, no position', () => {
    show({ buses: [bus({ status: 'NOT_OPERATING', location: null, tripId: null })] })
    expect(screen.getByText('⚫ Not running')).toBeTruthy()
    expect(screen.getByText(/Last seen:/)).toBeTruthy()
    expect(screen.queryByText('View on map')).toBeNull()
  })

  it('trip started but no fix yet', () => {
    show({ buses: [bus({ status: 'LOCATION_UNAVAILABLE', location: null })] })
    expect(screen.getByText('⚪ Location unavailable')).toBeTruthy()
  })

  it('WebSocket disconnected: keeps data but warns', () => {
    show({ connected: false })
    expect(screen.getByText(/Connection lost/)).toBeTruthy()
    expect(screen.getByText('🟢 Running')).toBeTruthy()
  })

  it('REST failure after data was loaded also warns', () => {
    show({ error: new ApiError(0, 'NETWORK', 'down') })
    expect(screen.getByText(/Connection lost/)).toBeTruthy()
  })

  it('"View on map" calls back', () => {
    const p = show()
    fireEvent.click(screen.getByText('View on map'))
    expect(p.onLocate).toHaveBeenCalledWith(expect.objectContaining({ id: 'bus-1' }))
  })

  it('tells people the server is waking up if loading takes more than a few seconds', () => {
    vi.useFakeTimers()
    show({ buses: null })
    expect(screen.queryByText(/waking up/)).toBeNull()
    act(() => { vi.advanceTimersByTime(5100) })
    expect(screen.getByText(/waking up after being idle/)).toBeTruthy()
    vi.useRealTimers()
  })
})
