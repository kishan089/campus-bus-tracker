import path from "node:path";
import { Pool } from "pg";
import { loadCampus, seed } from "../src/seed/seed";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL!;
  const { runner } = await import("node-pg-migrate"); // ESM-only package
  await runner({
    databaseUrl: url, dir: path.resolve(__dirname, "../migrations"), direction: "up",
    migrationsTable: "pgmigrations", count: Infinity, log: () => {},
  });
  const pool = new Pool({ connectionString: url });
  await seed(pool, loadCampus(), { devData: true });
  await pool.end();
}
