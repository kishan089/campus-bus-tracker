import type { Server } from "http";
import type { Deps } from "./deps";
import type { Reporter } from "./observability/reporter";

interface ShutdownParts {
  deps: Deps;
  server: Server;
  stopJobs?: () => void;
  closeRedis?: () => void;
  reporter?: Reporter;
  exit?: (code: number) => void;
  timeoutMs?: number;
}

/**
 * Orderly stop: tell load balancers to stop sending traffic (/health turns 503), stop accepting connections,
 * disconnect WebSocket clients (their browsers reconnect to another instance), then close Redis and the database.
 * A hard timeout guarantees the process ends even if something hangs.
 */
export function createShutdown(p: ShutdownParts) {
  const { deps, server } = p;
  const exit = p.exit ?? ((c: number) => process.exit(c));
  let started = false;
  return async function shutdown(signal: string) {
    if (started) return;
    started = true;
    deps.log.info({ signal }, "shutting down");
    deps.draining = true;
    const hard = setTimeout(() => { deps.log.error("shutdown timed out, forcing exit"); exit(1); }, p.timeoutMs ?? 10_000);
    hard.unref();
    try {
      p.stopJobs?.();
      deps.io?.close();                       // also closes the underlying HTTP server's WebSocket upgrades
      await new Promise<void>((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeIdleConnections?.();      // keep-alive connections would otherwise hold the server open
      });
      p.closeRedis?.();
      await deps.pool.end();
      await p.reporter?.flush();
      clearTimeout(hard);
      exit(0);
    } catch (e) {
      deps.log.error({ err: (e as Error).message }, "error during shutdown");
      exit(1);
    }
  };
}

/** A crash we did not expect leaves the process in an unknown state: record it, flush, and let the host restart us. */
export function installProcessHandlers(deps: Deps, shutdown: (signal: string) => void, reporter?: Reporter) {
  const die = async (kind: string, err: unknown) => {
    deps.log.fatal({ err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err) }, kind);
    reporter?.capture(err, {});
    await reporter?.flush(2000).catch(() => {});
    process.exit(1);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (e) => void die("unhandledRejection", e));
  process.on("uncaughtException", (e) => void die("uncaughtException", e));
}
