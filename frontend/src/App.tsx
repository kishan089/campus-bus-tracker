import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import ErrorBoundary from './components/ErrorBoundary'
import StudentPage from './pages/StudentPage'

// Students only ever need the map. The driver and admin screens (and their forms) load when someone opens them.
const DriverPage = lazy(() => import('./pages/DriverPage'))
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'))
const OverviewPage = lazy(() => import('./pages/admin/OverviewPage'))
const BusesPage = lazy(() => import('./pages/admin/BusesPage'))
const DriversPage = lazy(() => import('./pages/admin/DriversPage'))
const StopsPage = lazy(() => import('./pages/admin/StopsPage'))
const RoutesPage = lazy(() => import('./pages/admin/RoutesPage'))
const TripsPage = lazy(() => import('./pages/admin/TripsPage').then((m) => ({ default: m.TripsPage })))
const TripDetailPage = lazy(() => import('./pages/admin/TripsPage').then((m) => ({ default: m.TripDetailPage })))

export default function App() {
  return (
    <BrowserRouter>
    <ErrorBoundary>
      <Suspense fallback={<div className="page"><div className="card muted">Loading…</div></div>}>
      <Routes>
        <Route path="/" element={<StudentPage />} />
        <Route path="/driver" element={<DriverPage />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<OverviewPage />} />
          <Route path="buses" element={<BusesPage />} />
          <Route path="drivers" element={<DriversPage />} />
          <Route path="stops" element={<StopsPage />} />
          <Route path="routes" element={<RoutesPage />} />
          <Route path="trips" element={<TripsPage />} />
          <Route path="trips/:id" element={<TripDetailPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </ErrorBoundary>
    </BrowserRouter>
  )
}
