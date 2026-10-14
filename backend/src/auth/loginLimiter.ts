import type { RateLimiter } from "../security/rateLimit";

/**
 * Counts failed sign-ins: per (IP, account) so one person's typos don't lock others out, and per account
 * (a looser cap) so guessing from many addresses is still stopped. Counters live in Redis when it is up.
 */
export class LoginGuard {
  private limiter: RateLimiter;
  private perAccountMax: number;
  private perEmailMax: number;
  private windowMs: number;
  constructor(limiter: RateLimiter, perAccountMax: number, perEmailMax: number, windowMs: number) {
    this.limiter = limiter; this.perAccountMax = perAccountMax; this.perEmailMax = perEmailMax; this.windowMs = windowMs;
  }
  private keys(ip: string, email: string) { return { account: `lf:${ip}|${email.toLowerCase()}`, email: `lf:${email.toLowerCase()}` }; }

  /** Seconds to wait if this sign-in attempt is blocked, otherwise null. */
  async blockedFor(ip: string, email: string): Promise<number | null> {
    const k = this.keys(ip, email);
    const [a, e] = await Promise.all([this.limiter.get(k.account), this.limiter.get(k.email)]);
    const waits: number[] = [];
    if (a && a.count >= this.perAccountMax) waits.push(a.resetMs);
    if (e && e.count >= this.perEmailMax) waits.push(e.resetMs);
    return waits.length ? Math.max(1, Math.ceil(Math.max(...waits) / 1000)) : null;
  }
  async fail(ip: string, email: string) {
    const k = this.keys(ip, email);
    await Promise.all([this.limiter.incr(k.account, this.windowMs), this.limiter.incr(k.email, this.windowMs)]);
  }
  async succeeded(ip: string, email: string) { await this.limiter.del(this.keys(ip, email).account); }
}
