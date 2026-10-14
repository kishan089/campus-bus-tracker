// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '../services/types'
import RequireRole from './RequireRole'

const h = vi.hoisted(() => ({ snap: { status: 'loading', user: null } as { status: string; user: unknown } }))
vi.mock('../hooks/useSession', () => ({ useSession: () => h.snap }))
vi.mock('../services/auth', () => ({ login: vi.fn(), logout: vi.fn() }))
afterEach(cleanup)

const user = (role: SessionUser['role']): SessionUser => ({ id: 1, name: 'Ram', email: 'ram@example.com', role, buses: [] })
const show = (role: SessionUser['role'] = 'DRIVER') =>
  render(<MemoryRouter><RequireRole role={role} title="Driver sign-in">{(u) => <div>Welcome {u.name}</div>}</RequireRole></MemoryRouter>)

describe('RequireRole', () => {
  it('waits while the session is being restored', () => {
    h.snap = { status: 'loading', user: null }
    show()
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(screen.queryByText('Driver sign-in')).toBeNull() // no flash of the login form
  })
  it('shows the sign-in form to someone signed out', () => {
    h.snap = { status: 'anon', user: null }
    show()
    expect(screen.getByText('Driver sign-in')).toBeTruthy()
  })
  it('shows the page to the right role', () => {
    h.snap = { status: 'authed', user: user('DRIVER') }
    show()
    expect(screen.getByText('Welcome Ram')).toBeTruthy()
  })
  it('turns away the wrong role without rendering the page', () => {
    h.snap = { status: 'authed', user: user('DRIVER') }
    show('ADMIN')
    expect(screen.getByText(/can’t open this page/)).toBeTruthy()
    expect(screen.queryByText('Welcome Ram')).toBeNull()
  })
})
