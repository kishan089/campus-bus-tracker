import type { RequestHandler } from "express";
import type { Logger } from "pino";
import type { Deps } from "../deps";
import { AppError } from "../http/errors";
import { redisReady, type RedisClient } from "../redis";

export interface Hit { count: number; resetMs: number }
export interface RateStore {
  incr(key: string, windowMs: number): Promise<Hit>;
  get(key: string): Promise<Hit | null>;
  del(key: string): Promise<void>;
}

/** Fixed-window counters in this process's memory. Also the fallback when Redis is down. */
export class MemoryStore implements RateStore {
  private map = new Map<string, { count: number; resetAt: number }>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  private live(key: string) {
    const e = this.map.get(key);
    if (e && e.resetAt <= this.now()) { this.map.delete(key); return undefined; }
    return e;
  }
  async incr(key: string, windowMs: number): Promise<Hit> {
    if (this.map.size > 20_000) for (const k of this.map.keys()) this.live(k); // bound memory under a key-spraying attack
    const e = this.live(key) ?? { count: 0, resetAt: this.now() + windowMs };
    e.count++;
    this.map.set(key, e);
    return { count: e.count, resetMs: e.resetAt - this.now() };
  }
  async get(key: string): Promise<Hit | null> {
    const e = this.live(key);
    return e ? { count: e.count, resetMs: e.resetAt - this.now() } : null;
  }
  async del(key: string) { this.map.delete(key); }
}

/** The same counters in Redis, shared by every server instance. */
export class RedisStore implements RateStore {
  private redis: RedisClient;
  private prefix: string;
  constructor(redis: RedisClient, prefix = "rl:") { this.redis = redis; this.prefix = prefix; }

  async incr(key: string, windowMs: number): Promise<Hit> {
    const k = this.prefix + key;
    const count = await this.redis.incr(k);
    let ttl = count === 1 ? -1 : await this.redis.pttl(k);
    // a key with no expiry would block someone forever (e.g. the process died between INCR and PEXPIRE), so always repair it
    if (count === 1 || ttl < 0) { await this.redis.pexpire(k, windowMs); ttl = windowMs; }
    return { count, resetMs: ttl };
  }
  async get(key: string): Promise<Hit | null> {
    const k = this.prefix + key;
    const [v, ttl] = await Promise.all([this.redis.get(k), this.redis.pttl(k)]);
    return v === null ? null : { count: Number(v), resetMs: Math.max(ttl, 0) };
  }
  async del(key: string) { await this.redis.del(this.prefix + key); }
}

/**
 * Uses Redis when it is healthy so limits hold across instances, and this process's memory otherwise.
 * A rate limiter must never be the reason the service is down, so a Redis failure falls back instead of failing the request.
 */
export class RateLimiter implements RateStore {
  private memory = new MemoryStore();
  private redis?: RedisClient;
  private store?: RedisStore;
  private log?: Logger;
  private warnedAt = 0;
  constructor(redis?: RedisClient, log?: Logger) {
    this.redis = redis; this.log = log;
    if (redis) this.store = new RedisStore(redis);
  }

  private async use<T>(op: (s: RateStore) => Promise<T>): Promise<T> {
    if (this.store && redisReady(this.redis)) {
      try { return await op(this.store); }
      catch (e) {
        if (Date.now() - this.warnedAt > 60_000) { this.warnedAt = Date.now(); this.log?.warn({ err: (e as Error).message }, "rate limiter: redis failed, using memory"); }
      }
    }
    return op(this.memory);
  }
  incr(key: string, windowMs: number) { return this.use((s) => s.incr(key, windowMs)); }
  get(key: string) { return this.use((s) => s.get(key)); }
  del(key: string) { return this.use((s) => s.del(key)); }
}

export const limiterOf = (deps: Deps): RateLimiter => (deps.limiter ??= new RateLimiter(deps.redisPub, deps.log));

export interface LimitOptions {
  name: string;
  max: number;
  windowMs?: number;
  /** Who is being counted. Return undefined to skip limiting this request. */
  key: (req: Parameters<RequestHandler>[0]) => string | undefined;
}

export function rateLimit(deps: Deps, o: LimitOptions): RequestHandler {
  const windowMs = o.windowMs ?? 60_000;
  return async (req, res, next) => {
    const who = o.key(req);
    if (!who) return next();
    const { count, resetMs } = await limiterOf(deps).incr(`${o.name}:${who}`, windowMs);
    const resetS = Math.max(1, Math.ceil(resetMs / 1000));
    res.setHeader("RateLimit-Limit", String(o.max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, o.max - count)));
    res.setHeader("RateLimit-Reset", String(resetS));
    if (count > o.max) {
      res.setHeader("Retry-After", String(resetS));
      deps.metrics?.rateLimited();
      throw new AppError(429, "RATE_LIMITED", "Too many requests. Wait a moment and try again.");
    }
    next();
  };
}
