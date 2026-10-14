import { Pool, types, type PoolClient } from "pg";
import type { Logger } from "pino";

types.setTypeParser(20, (v) => Number(v)); // bigint/bigserial -> number (safe at our scale)

export type Db = Pool | PoolClient;

export function createPool(connectionString: string, log: Logger): Pool {
  const pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    statement_timeout: 15_000 }); // a runaway query is cancelled rather than holding a connection (and the page) forever
  // An idle client erroring (DB restart, network blip) must not crash the process.
  pool.on("error", (err) => log.error({ err }, "idle postgres client error"));
  return pool;
}
