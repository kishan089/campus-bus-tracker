import { io, type Socket } from 'socket.io-client'
import { API_BASE } from './api'
import type { BusProgress } from './types'

export type WsEvent =
  | { type: 'BUS_LOCATION_UPDATED'; busId: string; lat: number; lng: number; speed: number | null; accuracy: number | null; heading: number | null; ts: number; receivedAt: string; progress: BusProgress | null }
  | { type: 'BUS_TRIP_STARTED'; busId: string; routeId: string; tripId: number }
  | { type: 'BUS_TRIP_ENDED'; busId: string }

let socket: Socket | null = null
const listeners = new Set<(ev: WsEvent) => void>()

/** The socket lives wherever the API lives: "/api" in dev (proxied), or the backend origin via VITE_API_URL in production. */
export function socketTarget(apiBase: string, origin: string, socketUrl?: string) {
  // Vercel can proxy ordinary requests (/api) but not WebSockets, so in production the socket goes straight to the backend.
  if (socketUrl) return { url: new URL(socketUrl).origin, path: '/socket.io/' }
  const u = new URL(apiBase, origin)
  return { url: u.origin, path: `${u.pathname.replace(/\/$/, '')}/socket.io/` }
}

/** Gets or creates the global Socket.IO connection */
export function getSocket() {
  if (!socket) {
    const { url, path } = socketTarget(API_BASE, window.location.origin, import.meta.env.VITE_SOCKET_URL)
    socket = io(url, { path, transports: ['polling', 'websocket'], reconnectionDelayMax: 10_000 })
    socket.on('event', (ev: WsEvent) => listeners.forEach((fn) => fn(ev)))
  }
  return socket
}

/** Subscribe to all incoming WebSocket events */
export function subscribe(fn: (ev: WsEvent) => void) {
  getSocket() // ensure initialized
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
