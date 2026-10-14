export type BusStatus =
  | 'DISABLED' | 'NOT_OPERATING' | 'LOCATION_UNAVAILABLE'
  | 'LIVE' | 'DELAYED' | 'POSSIBLY_OFFLINE' | 'OFFLINE'

export interface BusLocation {
  lat: number; lng: number
  speed: number | null; accuracy: number | null; heading: number | null
  recordedAt: string; receivedAt: string
  ageSeconds: number // server's view of the age at response time
}

/** When one bus is expected at one stop, as computed by the server. */
export interface EtaEntry {
  stopId: string; name: string
  metres: number
  etaSeconds: number            // measured from when the server received the bus's latest fix
  justPassed: boolean           // the bus passed this stop within the last 60 m (then metres/etaSeconds are for the next pass)
  behindM: number | null
  headingTo: string | null
}

/** The bus's place on its route, computed by the server (never by the browser). */
export interface BusProgress {
  s: number; offRouteM: number; onRoute: boolean
  position: { lat: number; lng: number } | null // the fix snapped onto the route line
  speedEstMps: number
  next: EtaEntry | null
  etas: Record<string, EtaEntry>
}

export interface Bus {
  id: string; name: string; status: BusStatus
  routeId: string | null; tripId: number | null
  lastSeenAt: string | null
  location: BusLocation | null
  progress?: BusProgress | null
}

/** Seconds since the last fix after which a bus counts as live / delayed / possibly offline (from the server's config). */
export interface Thresholds { liveS: number; delayedS: number; offlineS: number }

export interface RouteSummary { id: string; name: string; color: string; totalLengthM: number }
export interface ActiveTrip { tripId: number; busId: string; routeId: string; startedAt: string }
export interface SessionUser { id: number; name: string; email: string; role: 'DRIVER' | 'ADMIN'; buses: { id: string; name: string }[] }
export interface AdminUser { id: number; name: string; email: string; role: 'DRIVER' | 'ADMIN'; active: boolean; createdAt: string; buses: string[] }

/** One GPS reading as sent to POST /location. */
export interface Fix {
  lat: number; lng: number
  speed: number | null; accuracy: number | null; heading: number | null
  ts: number // epoch milliseconds
}

// ---- admin ----
export interface AdminBus { id: string; name: string; registrationNumber: string | null; active: boolean; drivers: { id: number; name: string }[]; hasActiveTrip: boolean; hasHistory: boolean }
export interface AdminStop { id: string; name: string; lat: number; lng: number; routes: string[] }
export interface AdminRoute { id: string; name: string; color: string; active: boolean; totalLengthM: number; pointCount: number; passCount: number; hasActiveTrip: boolean }
export interface AdminRouteDetail extends AdminRoute { points: [number, number][]; passes: { seq: number; stopId: string; name: string; s: number }[] }
export interface RoutePreview {
  pointCount: number; totalLengthM: number
  passes: { stopId: string; name: string; s: number; offsetM: number }[]
  unmatchedStops: { id: string; name: string; nearestM: number }[]
  warnings: string[]
}
export interface AdminTrip {
  id: number; busId: string; busName: string; driverId: number; driverName: string; routeId: string; routeName: string
  status: 'ACTIVE' | 'COMPLETED'; startedAt: string; endedAt: string | null; endReason: 'DRIVER' | 'ADMIN' | 'AUTO_TIMEOUT' | null; durationS: number; fixCount: number; lastFixAt: string | null
}
export interface AdminTripDetail extends AdminTrip {
  stats: { distanceM: number; avgSpeedKmh: number | null; maxSpeedKmh: number; avgAccuracyM: number | null; gaps: number; longestGapS: number }
  trail: [number, number][]
}
export interface AuditEntry { id: number; userName: string | null; action: string; target: string | null; detail: unknown; createdAt: string }
export interface Overview {
  serverTime: string
  yourAddress: string | null
  stats: { totalBuses: number; activeBuses: number; disabledBuses: number; activeTrips: number; onlineDrivers: number; connectedViewers: number; fixesLastHour: number }
  system: {
    db: string; redis: string; uptimeSeconds: number; wsConnections: number
    api: { windowMinutes: number; requests: number; perMinute: number; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; serverErrors: number; clientErrors: number; rateLimited: number } | null
  }
  buses: {
    id: string; name: string; status: BusStatus; routeId: string | null; tripId: number | null
    driver: { id: number; name: string } | null; speedKmh: number | null; ageSeconds: number | null; lastSeenAt: string | null
    position: { lat: number; lng: number } | null
    health: { fixes: number; avgIntervalS: number | null; avgAccuracyM: number | null; maxOffRouteM: number | null } | null
  }[]
  trips: { id: number; busId: string; busName: string; driverId: number; driverName: string; routeId: string; startedAt: string }[]
  audit: AuditEntry[]
}
