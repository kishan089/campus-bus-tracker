import { Component, type ErrorInfo, type ReactNode } from 'react'

/** A bug in one screen should show a way out, not a blank page. Runs in production too. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Screen crashed:', error, info.componentStack) }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="page">
        <div className="card" role="alert" style={{ display: 'grid', gap: 12 }}>
          <h2>Something went wrong</h2>
          <div className="muted">This screen hit an unexpected error. Reloading usually fixes it.</div>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
          <a href="/" className="muted">Back to the map</a>
        </div>
      </div>
    )
  }
}
