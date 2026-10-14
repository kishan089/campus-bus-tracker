// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Overview } from '../../services/types'
import OverviewView, { apiProblems, healthProblems } from './OverviewView'

afterEach(cleanup)

const overview = (o: Partial<Overview> = {}): Overview => ({
  serverTime: '2026-10-01T09:00:00Z',
  yourAddress: '203.0.113.7',
  stats: { totalBuses: 2, activeBuses: 1, disabledBuses: 0, activeTrips: 1, onlineDrivers: 1, connectedViewers: 37, fixesLastHour: 1200 },
  system: { db: 'up', redis: 'up', uptimeSeconds: 3900, wsConnections: 12,
    api: { windowMinutes: 5, requests: 420, perMinute: 84, p50Ms: 6, p95Ms: 38, p99Ms: 90, serverErrors: 0, clientErrors: 2, rateLimited: 0 } },
  buses: [
    { id: 'bus-1', name: 'Bus 1', status: 'LIVE', routeId: 'route-a', tripId: 5, driver: { id: 2, name: 'Ravi' }, speedKmh: 24, ageSeconds: 4,
      lastSeenAt: '2026-10-01T09:00:00Z', position: { lat: 25.26, lng: 82.99 }, health: { fixes: 98, avgIntervalS: 3.1, avgAccuracyM: 8, maxOffRouteM: 4 } },
    { id: 'bus-2', name: 'Bus 2', status: 'NOT_OPERATING', routeId: null, tripId: null, driver: null, speedKmh: null, ageSeconds: null,
      lastSeenAt: '2026-10-01T08:00:00Z', position: null, health: null },
  ],
  trips: [{ id: 5, busId: 'bus-1', busName: 'Bus 1', driverId: 2, driverName: 'Ravi', routeId: 'route-a', startedAt: '2026-10-01T08:30:00Z' }],
  audit: [{ id: 1, userName: 'Dev Admin', action: 'bus.disable', target: 'bus-3', detail: null, createdAt: '2026-10-01T08:59:00Z' }],
  ...o,
})
const show = (o = overview(), onEndTrip = vi.fn()) => { render(<OverviewView o={o} onEndTrip={onEndTrip} />); return onEndTrip }

describe('OverviewView', () => {
  it('shows the headline numbers and system health', () => {
    show()
    expect(screen.getByText('Buses reporting').previousSibling?.textContent).toBe('1 / 2')
    expect(screen.getByText('Students connected').previousSibling?.textContent).toBe('37')
    expect(screen.getByText('GPS fixes, last hour').previousSibling?.textContent).toBe('1200')
    expect(screen.getByTestId('system').textContent).toBe('Database: up · Redis: up · Server up 1 h 5 min · 12 live connections')
  })

  it('shows each bus: status, driver, speed, age and GPS health', () => {
    show()
    const live = within(screen.getByTestId('bus-row-bus-1'))
    expect(live.getByText('🟢 Running')).toBeTruthy()
    expect(live.getByText('Ravi')).toBeTruthy()
    expect(live.getByText('24 km/h')).toBeTruthy()
    expect(live.getByText('4 s ago')).toBeTruthy()
    expect(live.getByText(/98 fixes, every 3.1 s, ±8 m/)).toBeTruthy()
    const idle = within(screen.getByTestId('bus-row-bus-2'))
    expect(idle.getByText('⚫ Not running')).toBeTruthy()
    expect(idle.getByText('no fixes')).toBeTruthy()
    expect(idle.getByText(/last seen/)).toBeTruthy()
  })

  it('flags poor GPS: inaccurate, sparse, or off the route', () => {
    const bad = overview()
    bad.buses[0].health = { fixes: 10, avgIntervalS: 40, avgAccuracyM: 80, maxOffRouteM: 120 }
    show(bad)
    const row = within(screen.getByTestId('bus-row-bus-1'))
    expect(row.getByText('inaccurate (80 m) · sparse (every 40 s) · off route (120 m)')).toBeTruthy()
    expect(healthProblems({ fixes: 98, avgIntervalS: 3, avgAccuracyM: 8, maxOffRouteM: 4 })).toEqual([])
  })

  it('does not show a speed for a bus that is not reporting', () => {
    const o = overview()
    o.buses[0] = { ...o.buses[0], status: 'OFFLINE', speedKmh: 24 }
    show(o)
    expect(within(screen.getByTestId('bus-row-bus-1')).queryByText('24 km/h')).toBeNull()
  })

  it('lets an admin end a trip', () => {
    const onEnd = show()
    fireEvent.click(screen.getByText('End trip'))
    expect(onEnd).toHaveBeenCalledWith(5, 'Bus 1')
  })

  it('reads the recent changes as sentences', () => {
    show()
    expect(screen.getByText(/disabled bus bus-3/)).toBeTruthy()
    expect(screen.getByText('Dev Admin')).toBeTruthy()
  })

  it('has sensible empty states', () => {
    show(overview({ buses: [], trips: [], audit: [] }))
    expect(screen.getByText(/No buses yet/)).toBeTruthy()
    expect(screen.getByText('No trips right now.')).toBeTruthy()
    expect(screen.getByText('Nothing yet.')).toBeTruthy()
  })

  it('shows API health, and flags it when the server is slow, failing or limiting people', () => {
    show()
    expect(screen.getByTestId('api-health').textContent).toMatch(/420 requests \(84\/min\) · median 6 ms, 95% under 38 ms/)
    expect(within(screen.getByTestId('api-health')).getByText('healthy')).toBeTruthy()
    cleanup()
    const bad = overview(); bad.system.api = { ...bad.system.api!, p95Ms: 900, serverErrors: 3, rateLimited: 1 }
    show(bad)
    expect(within(screen.getByTestId('api-health')).getByText('slow (95% of requests under 900 ms) · 3 server errors · 1 request limited')).toBeTruthy()
    expect(apiProblems({ ...bad.system.api!, p95Ms: 40, serverErrors: 0, rateLimited: 0 })).toEqual([])
  })

  it('copes with a server that has no metrics yet', () => {
    const o = overview(); o.system.api = null
    show(o)
    expect(screen.queryByTestId('api-health')).toBeNull()
  })

  it('shows the address the server sees, with advice for when it is wrong', () => {
    show()
    expect(screen.getByTestId('your-address').textContent).toMatch(/203\.0\.113\.7.*TRUST_PROXY_HOPS/)
    cleanup()
    show(overview({ yourAddress: null }))
    expect(screen.queryByTestId('your-address')).toBeNull()
  })
})
