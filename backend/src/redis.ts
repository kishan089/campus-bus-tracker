import Redis from "ioredis";
import type { Logger } from "pino";

/**
 * Create a Redis client that reconnects automatically but degrades gracefully
 * when Redis is unavailable. Errors are logged as warnings, not crashes.
 */
export function createRedisClient(url: string, log: Logger) {
  const client = new Redis(url, {
    lazyConnect: true,           // don't connect until .connect() or first command
    maxRetriesPerRequest: 1,     // fail fast on commands so the caller can degrade
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 5000), // backoff up to 5 s
  });

  client.on("connect",   () => log.info("redis connected"));
  client.on("ready",     () => log.info("redis ready"));
  client.on("error",     (e: Error) => log.warn({ err: e.message }, "redis error"));
  client.on("close",     () => log.warn("redis connection closed"));
  client.on("reconnecting", () => log.info("redis reconnecting"));

  return client;
}

export type RedisClient = ReturnType<typeof createRedisClient>;

/** True only when commands will succeed right now. Callers skip Redis (instead of waiting ~0.7 s for a retry to fail) when it isn't. */
export const redisReady = (c?: RedisClient): c is RedisClient => c?.status === "ready";
