import type { Pool } from "pg";
import type { Logger } from "pino";
import type { Config } from "./config";
import type { RedisClient } from "./redis";
import type { Server as SocketIO } from "socket.io";
import type { Metrics } from "./observability/metrics";
import type { RateLimiter } from "./security/rateLimit";
import { RouteModelCache } from "./services/routeModel";

export interface Deps {
  pool: Pool;
  config: Config;
  log: Logger;
  redisPub?: RedisClient;
  redisSub?: RedisClient;
  io?: SocketIO;
  routes?: RouteModelCache;
  limiter?: RateLimiter;
  metrics?: Metrics;
  draining?: boolean;
  activityAt?: number;
}

/** The process-wide route cache, created on first use so tests and scripts can keep building Deps by hand. */
export const routeCache = (deps: Deps): RouteModelCache => (deps.routes ??= new RouteModelCache(deps.pool));
