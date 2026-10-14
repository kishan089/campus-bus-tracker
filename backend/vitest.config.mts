import "dotenv/config";
import { defineConfig } from "vitest/config";

process.env.TEST_DATABASE_URL ??= "postgres://bus:bus@localhost:5433/bustracker_test";

export default defineConfig({
  test: {
    globalSetup: ["./test/globalSetup.ts"],
    env: {
      NODE_ENV: "test", DATABASE_URL: process.env.TEST_DATABASE_URL, LOG_LEVEL: "silent",
      // the suite signs in and posts fixes far faster than any real client; tests of the limits build their own apps with small ones
      RATE_LIMIT_PER_MINUTE: "100000", RATE_LIMIT_LOGIN_PER_MINUTE: "100000", RATE_LIMIT_LOCATION_PER_MINUTE: "100000", RATE_LIMIT_ADMIN_PER_MINUTE: "100000",
    },
    fileParallelism: false, // tests share one database
  },
});
