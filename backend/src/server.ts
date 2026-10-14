import "dotenv/config";
import { createServer } from "http";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createPool } from "./db";
import type { Deps } from "./deps";
import { startJanitor } from "./jobs/janitor";
import { createShutdown, installProcessHandlers } from "./lifecycle";
import { createLogger } from "./logger";
import { createErrorReporter } from "./observability/reporter";
import { createRedisClient } from "./redis";
import { attachSocketServer } from "./websocket";

async function main() {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const pool = createPool(config.databaseUrl, log);
  const reporter = await createErrorReporter(config);
  if (reporter) log.info("error reporting to Sentry is on");

  // Without REDIS_URL (the production default) there is no Redis at all: events go straight to this server's clients,
  // rate limits live in memory and /buses reads Postgres. That is all one server needs.
  const redisPub = config.redisUrl ? createRedisClient(config.redisUrl, log) : undefined;
  const redisSub = config.redisUrl ? createRedisClient(config.redisUrl, log) : undefined;
  // lazyConnect: connect now (non-fatal), so redisReady() becomes true as soon as Redis is up
  redisPub?.connect().catch((e: Error) => log.warn({ err: e.message }, "redis unavailable at startup, will keep retrying"));
  if (!config.redisUrl) log.info("redis is not configured: running without it");

  const deps: Deps = { pool, config, log, redisPub, redisSub };
  const server = createServer(createApp(deps, reporter));
  deps.io = attachSocketServer(server, deps);
  const janitor = startJanitor(deps);

  const shutdown = createShutdown({ deps, server, stopJobs: janitor.stop, closeRedis: () => { redisPub?.quit(); redisSub?.quit(); }, reporter });
  installProcessHandlers(deps, shutdown, reporter);

  server.listen(config.port, () => log.info({ port: config.port, env: config.env }, "api listening"));
}

main().catch((e) => { console.error(e); process.exit(1); });
