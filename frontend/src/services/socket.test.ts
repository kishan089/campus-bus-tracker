import { describe, expect, it } from 'vitest'
import { socketTarget } from './socket'

describe('socketTarget', () => {
  it('dev: same origin, path under the /api proxy', () => {
    expect(socketTarget('/api', 'http://localhost:5174')).toEqual({ url: 'http://localhost:5174', path: '/api/socket.io/' })
  })
  it('with VITE_SOCKET_URL: straight to the backend, whatever the API base is', () => {
    expect(socketTarget('/api', 'https://bus.vercel.app', 'https://campus-bus-api.onrender.com/')).toEqual({ url: 'https://campus-bus-api.onrender.com', path: '/socket.io/' })
  })
  it('production: the backend origin, root path', () => {
    expect(socketTarget('https://api.example.com', 'https://bus.example.com')).toEqual({ url: 'https://api.example.com', path: '/socket.io/' })
  })
})
