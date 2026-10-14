/** Request statistics for this process: enough to see slowness and error spikes without a monitoring stack. */
export class Metrics {
  private samples: { at: number; ms: number; status: number }[] = [];
  private limited: number[] = [];
  readonly startedAt = Date.now();
  private cap: number;
  constructor(cap = 5000) { this.cap = cap; }

  record(status: number, ms: number, at = Date.now()) {
    this.samples.push({ at, ms, status });
    if (this.samples.length > this.cap) this.samples.splice(0, this.samples.length - this.cap);
  }
  rateLimited(at = Date.now()) { this.limited.push(at); if (this.limited.length > this.cap) this.limited.shift(); }

  snapshot(windowMs = 5 * 60_000, now = Date.now()) {
    const recent = this.samples.filter((s) => now - s.at <= windowMs);
    const sorted = recent.map((s) => s.ms).sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] * 10) / 10 : null);
    const minutes = Math.min(windowMs, Math.max(now - this.startedAt, 1000)) / 60_000;
    return {
      windowMinutes: windowMs / 60_000,
      requests: recent.length,
      perMinute: Math.round((recent.length / minutes) * 10) / 10,
      p50Ms: pct(50), p95Ms: pct(95), p99Ms: pct(99),
      serverErrors: recent.filter((s) => s.status >= 500).length,
      clientErrors: recent.filter((s) => s.status >= 400 && s.status < 500 && s.status !== 429).length,
      rateLimited: this.limited.filter((t) => now - t <= windowMs).length,
    };
  }
}

/** Pages the dashboard refreshes by itself every few seconds would drown out real traffic. */
const IGNORED = /^\/(health|ping|admin\/overview)(\?|$)/;
export const countsTowardMetrics = (url: string) => !IGNORED.test(url);
