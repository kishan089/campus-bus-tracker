// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bus, EtaEntry } from '../services/types'
import StopArrivals from './StopArrivals'

afterEach(cleanup)

const STOPS = [{ id: 'lt1', name: 'LT1' }, { id: 'lt4', name: 'LT4' }]
const eta = (o: Partial<EtaEntry> = {}): EtaEntry => ({
  stopId: 'lt1', name: 'LT1', metres: 728, etaSeconds: 186, justPassed: false, behindM: null, headingTo: 'LT4', ...o,
})
const bus = (id: string, e: EtaEntry | null, o: Partial<Bus> = {}, age = 0): Bus => ({
  id, name: `Bus ${id}`, status: 'LIVE', routeId: 'route-a', tripId: 1, lastSeenAt: '2026-10-01T09:11:00Z',
  location: { lat: 25.26, lng: 82.99, speed: 5, accuracy: 8, heading: null, recordedAt: '', receivedAt: '', ageSeconds: age },
  progress: e && { s: 500, offRouteM: 1, onRoute: true, position: { lat: 25.26, lng: 82.99 }, speedEstMps: 5, next: e, etas: { [e.stopId]: e } },
  ...o,
})
const show = (buses: Bus[] | null, stopId: string | null = 'lt1', onSelect = vi.fn()) =>
  render(<StopArrivals stops={STOPS} stopId={stopId} onSelect={onSelect} buses={buses} />)

describe('StopArrivals', () => {
  it('asks the student to pick a stop', () => {
    show([bus('1', eta())], null)
    expect(screen.getByText(/Pick your stop/)).toBeTruthy()
  })

  it('shows ETA and distance, heading, for a bus approaching the stop', () => {
    show([bus('1', eta())])
    expect(screen.getByText(/~3 min/)).toBeTruthy()
    expect(screen.getByText(/728 m/)).toBeTruthy()
    expect(screen.getByText('Towards LT4')).toBeTruthy()
  })

  it('counts the ETA down as the fix ages', () => {
    show([bus('1', eta({ etaSeconds: 186 }), {}, 126)]) // 186 - 126 = 60 s
    expect(screen.getByText(/~1 min/)).toBeTruthy()
  })

  it('says "Arriving now" when the bus is at the stop', () => {
    show([bus('1', eta({ metres: 12, etaSeconds: 3 }))])
    expect(screen.getByText('Arriving now')).toBeTruthy()
  })

  it('says the bus already passed, and when the next one comes', () => {
    show([bus('1', eta({ justPassed: true, behindM: 40, metres: 2053, etaSeconds: 511, headingTo: 'DG CORNER' }))])
    expect(screen.getByText('Just passed (40 m ago)')).toBeTruthy()
    expect(screen.getByText(/Next arrival ~9 min · towards DG CORNER/)).toBeTruthy()
  })

  it('lists the soonest bus first', () => {
    show([bus('A', eta({ etaSeconds: 600 })), bus('B', eta({ etaSeconds: 120 }))])
    const order = screen.getAllByText(/^Bus [AB]$/).map((n) => n.textContent)
    expect(order).toEqual(['Bus B', 'Bus A'])
  })

  it('flags a bus whose GPS is delayed', () => {
    show([bus('1', eta(), { status: 'DELAYED' })])
    expect(screen.getByText('GPS delayed')).toBeTruthy()
  })

  it('does not promise anything from a bus that is offline', () => {
    show([bus('1', eta(), { status: 'OFFLINE' })])
    expect(screen.getByText('No bus is running right now.')).toBeTruthy()
    expect(screen.queryByText(/min/)).toBeNull()
  })

  it('no bus running', () => {
    show([bus('1', null, { status: 'NOT_OPERATING', location: null, tripId: null })])
    expect(screen.getByText('No bus is running right now.')).toBeTruthy()
  })

  it('a running bus that is off its route has no ETA', () => {
    show([bus('1', null, { progress: { s: 0, offRouteM: 80, onRoute: false, position: null, speedEstMps: 5, next: null, etas: {} } })])
    expect(screen.getByText(/away from its route/)).toBeTruthy()
  })

  it('shows nothing while buses are still loading', () => {
    show(null)
    expect(screen.queryByText(/No bus is running/)).toBeNull()
  })

  it('reports the chosen stop', () => {
    const onSelect = vi.fn()
    show([], null, onSelect)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'lt4' } })
    expect(onSelect).toHaveBeenCalledWith('lt4')
  })
})
