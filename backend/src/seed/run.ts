import "dotenv/config";
import { loadToolConfig } from "../config";
import { createPool } from "../db";
import { createLogger } from "../logger";
import { loadCampus, seed } from "./seed";

async function main() {
  const config = loadToolConfig();
  const pool = createPool(config.databaseUrl, createLogger("warn"));
  try {
    await seed(pool, loadCampus(), { devData: config.env !== "production" });
    const { rows } = await pool.query(
      `SELECT (SELECT count(*) FROM routes) routes, (SELECT count(*) FROM route_points) points,
              (SELECT count(*) FROM stops) stops, (SELECT count(*) FROM route_stops) route_stops,
              (SELECT count(*) FROM landmarks) landmarks, (SELECT count(*) FROM buses) buses`);
    console.log("seeded:", rows[0]);
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
