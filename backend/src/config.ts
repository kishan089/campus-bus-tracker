import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(3001),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGINS: z.string().default("http://localhost:5174"),
  LOG_LEVEL: z.string().default("info"),
  STATUS_LIVE_SECONDS: z.coerce.number().positive().default(15),
  STATUS_DELAYED_SECONDS: z.coerce.number().positive().default(120),
  STATUS_OFFLINE_SECONDS: z.coerce.number().positive().default(600),
  MAX_ACCURACY_M: z.coerce.number().positive().default(100),
  MAX_FUTURE_SKEW_SECONDS: z.coerce.number().nonnegative().default(30),
  MAX_PAST_SKEW_SECONDS: z.coerce.number().nonnegative().default(300),
  ETA_DWELL_SECONDS: z.coerce.number().nonnegative().default(20),
  ETA_DEFAULT_SPEED_MPS: z.coerce.number().positive().default(5),
  ROUTE_OFF_ROUTE_M: z.coerce.number().positive().default(30),
  JWT_SECRET: z.string().optional(),
  ACCESS_TOKEN_MINUTES: z.coerce.number().positive().default(15),
  REFRESH_TOKEN_DAYS: z.coerce.number().positive().default(7),
  COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  LOGIN_WINDOW_MINUTES: z.coerce.number().positive().default(15),
  // Many students share one campus IP (NAT), so the per-IP API limit is deliberately generous; writes and logins are limited harder.
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(1200),
  RATE_LIMIT_LOGIN_PER_MINUTE: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_LOCATION_PER_MINUTE: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_ADMIN_PER_MINUTE: z.coerce.number().int().positive().default(120),
  STALE_TRIP_MINUTES: z.coerce.number().positive().default(30),
  JANITOR_INTERVAL_SECONDS: z.coerce.number().positive().default(60),
  GPS_RETENTION_DAYS: z.coerce.number().positive().default(90),
  MAX_JUMP_SPEED_MPS: z.coerce.number().positive().default(45),
  WS_MAX_CONNECTIONS: z.coerce.number().int().positive().default(5000),
  WS_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().positive().default(300),
  REDIS_URL: z.string().optional(),
  // How many proxies sit in front of this server. Render alone is 1; Vercel proxying to Render is 2.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  SENTRY_DSN: z.string().optional(),
  RELEASE: z.string().optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = schema.parse(env);
  if (e.NODE_ENV === "production" && (e.JWT_SECRET ?? "").length < 32)
    throw new Error("JWT_SECRET must be set to a random string of at least 32 characters in production");
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    corsOrigins: e.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    logLevel: e.LOG_LEVEL,
    status: { liveS: e.STATUS_LIVE_SECONDS, delayedS: e.STATUS_DELAYED_SECONDS, offlineS: e.STATUS_OFFLINE_SECONDS },
    eta: { dwellS: e.ETA_DWELL_SECONDS, defaultSpeedMps: e.ETA_DEFAULT_SPEED_MPS, offRouteM: e.ROUTE_OFF_ROUTE_M },
    auth: {
      // the fallback is for local development and tests only; production refuses to start without a real secret
      jwtSecret: e.JWT_SECRET ?? "dev-only-secret-not-for-production-0123456789abcdef",
      accessTtlS: Math.round(e.ACCESS_TOKEN_MINUTES * 60),
      refreshTtlMs: e.REFRESH_TOKEN_DAYS * 86_400_000,
      cookieSecure: e.COOKIE_SECURE ? e.COOKIE_SECURE === "true" : e.NODE_ENV === "production",
      loginMaxAttempts: e.LOGIN_MAX_ATTEMPTS,
      loginWindowMs: e.LOGIN_WINDOW_MINUTES * 60_000,
    },
    limits: {
      apiPerMin: e.RATE_LIMIT_PER_MINUTE, loginPerMin: e.RATE_LIMIT_LOGIN_PER_MINUTE,
      locationPerMin: e.RATE_LIMIT_LOCATION_PER_MINUTE, adminPerMin: e.RATE_LIMIT_ADMIN_PER_MINUTE,
    },
    ops: {
      staleTripMinutes: e.STALE_TRIP_MINUTES, janitorIntervalS: e.JANITOR_INTERVAL_SECONDS,
      gpsRetentionDays: e.GPS_RETENTION_DAYS, maxJumpSpeedMps: e.MAX_JUMP_SPEED_MPS,
    },
    ws: { maxConnections: e.WS_MAX_CONNECTIONS, maxPerIp: e.WS_MAX_CONNECTIONS_PER_IP },
    // Redis is optional: one server needs none of it. In development it defaults to the Docker one; in production it is off unless REDIS_URL is set.
    redisUrl: e.REDIS_URL || (e.NODE_ENV === "development" ? "redis://localhost:6379" : undefined),
    trustProxyHops: e.TRUST_PROXY_HOPS,
    sentryDsn: e.SENTRY_DSN || undefined,
    release: e.RELEASE || undefined,
    gps: { maxAccuracyM: e.MAX_ACCURACY_M, maxFutureSkewS: e.MAX_FUTURE_SKEW_SECONDS, maxPastSkewS: e.MAX_PAST_SKEW_SECONDS },
  };
}
export type Config = ReturnType<typeof loadConfig>;

/** For command-line tools (seed, create-user) that only need the database: they never sign a token, so they don't need JWT_SECRET. */
export const loadToolConfig = () => loadConfig({ ...process.env, JWT_SECRET: process.env.JWT_SECRET ?? "tool-only-secret-never-used-to-sign-0000000000" });
