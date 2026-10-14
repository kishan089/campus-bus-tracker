// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ErrorBoundary from './ErrorBoundary'

afterEach(cleanup)
const Boom = () => { throw new Error('render failed') }

describe('ErrorBoundary', () => {
  it('shows a way out instead of a blank page when a screen crashes', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorBoundary><Boom /></ErrorBoundary>)
    expect(screen.getByRole('alert').textContent).toMatch(/Something went wrong/)
    expect(screen.getByText('Reload')).toBeTruthy()
    expect(screen.getByText('Back to the map')).toBeTruthy()
    spy.mockRestore()
  })
  it('is invisible when nothing fails', () => {
    render(<ErrorBoundary><div>fine</div></ErrorBoundary>)
    expect(screen.getByText('fine')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
