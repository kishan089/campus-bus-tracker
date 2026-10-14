// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  routes: vi.fn(), stops: vi.fn(), route: vi.fn(), previewRoute: vi.fn(), createRoute: vi.fn(), updateRoute: vi.fn(), deleteRoute: vi.fn(),
}))
vi.mock('../../services/api', () => ({ adminApi: api }))
vi.mock('../../components/admin/RouteMap', () => ({ RouteMap: () => <div data-testid="map" /> })) // Leaflet needs a real browser
import RoutesPage from './RoutesPage'

const GEOJSON = JSON.stringify({ type: 'LineString', coordinates: [[82.9864, 25.2632], [82.9877, 25.2632], [82.9864, 25.2632]] })
const PREVIEW = { pointCount: 3, totalLengthM: 250, passes: [{ stopId: 'a', name: 'Stop A', s: 0, offsetM: 1 }], unmatchedStops: [{ id: 'b', name: 'Far Stop', nearestM: 900 }], warnings: ['Points 2 and 3 are 600 m apart. Is a point missing?'] }

beforeEach(() => {
  api.routes.mockResolvedValue([{ id: 'route-a', name: 'Route A', color: '#2563eb', active: true, totalLengthM: 3635, pointCount: 57, passCount: 8, hasActiveTrip: false }])
  api.stops.mockResolvedValue([])
  api.previewRoute.mockResolvedValue(PREVIEW)
  api.createRoute.mockResolvedValue({})
})
afterEach(() => { cleanup(); Object.values(api).forEach((m) => m.mockReset()) })

const open = async () => {
  render(<MemoryRouter><RoutesPage /></MemoryRouter>)
  fireEvent.click(await screen.findByText('New route'))
}
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const create = () => screen.getByText('Create route') as HTMLButtonElement

describe('route editor', () => {
  it('lists existing routes', async () => {
    render(<MemoryRouter><RoutesPage /></MemoryRouter>)
    expect(await screen.findByText('Route A')).toBeTruthy()
    expect(screen.getByText('3.6 km')).toBeTruthy()
  })

  it('reads pasted GeoJSON and says so; bad input shows a clear error and cannot be previewed', async () => {
    await open()
    type('Route points', GEOJSON)
    expect(screen.getByTestId('parse-note').textContent).toMatch(/3 points read · GeoJSON line/)
    type('Route points', '[[125, 82], [1, 2]]')
    expect((await screen.findByRole('alert')).textContent).toMatch(/swapped/)
    expect((screen.getByText('Preview') as HTMLButtonElement).disabled).toBe(true)
  })

  it('makes the admin preview the path before creating it, and shows warnings and stops left out', async () => {
    await open()
    type('Name', 'Night loop')
    type('Route points', GEOJSON)
    expect(create().disabled).toBe(true)
    fireEvent.click(screen.getByText('Preview'))
    expect((await screen.findByTestId('preview-summary')).textContent).toMatch(/0\.3 km long · 1 stop passes/)
    expect(screen.getByText(/600 m apart/)).toBeTruthy()
    expect(screen.getByText(/Far Stop \(900 m away\)/)).toBeTruthy()
    expect(create().disabled).toBe(false)
  })

  it('creates the route with points converted to [lat, lng]', async () => {
    await open()
    type('Name', 'Night loop')
    type('Route points', GEOJSON)
    fireEvent.click(screen.getByText('Preview'))
    await screen.findByTestId('preview-summary')
    fireEvent.click(create())
    await waitFor(() => expect(api.createRoute).toHaveBeenCalled())
    expect(api.createRoute).toHaveBeenCalledWith({ name: 'Night loop', color: '#2563eb', points: [[25.2632, 82.9864], [25.2632, 82.9877], [25.2632, 82.9864]] })
  })

  it('a preview goes stale as soon as the path is edited', async () => {
    await open()
    type('Name', 'Night loop')
    type('Route points', GEOJSON)
    fireEvent.click(screen.getByText('Preview'))
    await screen.findByTestId('preview-summary')
    type('Route points', GEOJSON.replace('82.9877', '82.9880'))
    expect(create().disabled).toBe(true)
  })

  it('shows the server error if saving fails', async () => {
    api.createRoute.mockRejectedValue(new Error('A route with that id already exists'))
    await open()
    type('Name', 'Night loop'); type('Route points', GEOJSON)
    fireEvent.click(screen.getByText('Preview')); await screen.findByTestId('preview-summary')
    fireEvent.click(create())
    expect((await screen.findByRole('alert')).textContent).toBe('A route with that id already exists')
  })

  it('editing an existing route: renaming needs no preview, changing the path does', async () => {
    api.route.mockResolvedValue({ id: 'route-a', name: 'Route A', color: '#2563eb', active: true, totalLengthM: 3635, pointCount: 2, passCount: 8, hasActiveTrip: false,
      points: [[25.2632, 82.9864], [25.2632, 82.9877]], passes: [] })
    api.updateRoute.mockResolvedValue({})
    render(<MemoryRouter><RoutesPage /></MemoryRouter>)
    fireEvent.click((await screen.findAllByText('Edit'))[0])
    const save = (await screen.findByText('Save changes')) as HTMLButtonElement
    type('Name', 'Route A (day)')
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(api.updateRoute).toHaveBeenCalledWith('route-a', { name: 'Route A (day)', color: '#2563eb', active: true }))
    expect(api.updateRoute.mock.calls[0][1]).not.toHaveProperty('points') // path untouched, so it is not resent
  })
})
