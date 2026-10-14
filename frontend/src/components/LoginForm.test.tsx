// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../services/api'
import LoginForm, { loginErrorMessage } from './LoginForm'

const h = vi.hoisted(() => ({ login: vi.fn() }))
vi.mock('../services/auth', () => ({ login: h.login }))
afterEach(() => { cleanup(); h.login.mockReset() })

const fill = (email: string, password: string) => {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
}
const show = () => render(<MemoryRouter><LoginForm title="Driver sign-in" /></MemoryRouter>)

describe('LoginForm', () => {
  it('signs in with what was typed, trimming the email', async () => {
    h.login.mockResolvedValue({})
    show(); fill(' ram@example.com ', 'secret-pw')
    fireEvent.click(screen.getByText('Sign in'))
    await waitFor(() => expect(h.login).toHaveBeenCalledWith('ram@example.com', 'secret-pw'))
  })

  it('shows a clear message and clears the password after a wrong login', async () => {
    h.login.mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS', 'Wrong email or password'))
    show(); fill('ram@example.com', 'nope')
    fireEvent.click(screen.getByText('Sign in'))
    expect((await screen.findByRole('alert')).textContent).toBe('Wrong email or password.')
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('')
  })

  it('cannot be submitted empty', () => {
    show()
    expect((screen.getByText('Sign in') as HTMLButtonElement).disabled).toBe(true)
  })

  it('maps every failure to a sentence a driver can act on', () => {
    expect(loginErrorMessage(new ApiError(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts. Try again in 15 min.'))).toBe('Too many attempts. Try again in 15 min.')
    expect(loginErrorMessage(new ApiError(0, 'NETWORK', 'x'))).toMatch(/Cannot reach the server/)
    expect(loginErrorMessage(new ApiError(400, 'VALIDATION_ERROR', 'x'))).toMatch(/valid email/)
    expect(loginErrorMessage(new Error('boom'))).toMatch(/Could not sign in/)
  })

  it('says what is wrong when the backend is down, broken, or cannot reach its database', () => {
    expect(loginErrorMessage(new ApiError(502, 'HTTP_502', 'Bad Gateway'))).toMatch(/Cannot reach the backend \(error 502\).*npm run dev/)
    expect(loginErrorMessage(new ApiError(500, 'INTERNAL', 'Internal server error'))).toMatch(/npm run migrate/)
    expect(loginErrorMessage(new ApiError(503, 'DB_UNAVAILABLE', 'x'))).toMatch(/Docker/)
  })
})
