import cors from "cors";
import express from "express";
import helmet from "helmet";
import type { Deps } from "./deps";
import { makeErrorHandler, notFound, type ErrorReporter } from "./http/errors";
import { httpLogger } from "./http/requestLogger";
import { countsTowardMetrics, Metrics } from "./observability/metrics";
import { rateLimit } from "./security/rateLimit";
import { adminRouter } from "./routes/admin";
import { arrivalsRouter } from "./routes/arrivals";
import { authRouter } from "./routes/auth";
import { busesRouter } from "./routes/buses";
import { catalogRouter } from "./routes/catalog";
import { tripsRouter } from "./routes/trips";

export function createApp(deps: Deps, reporter?: ErrorReporter) {
  const app = express();
  deps.metrics ??= new Metrics();
  app.disable("x-powered-by");
  if (deps.config.env === "production" && deps.config.trustProxyHops > 0) app.set("trust proxy", deps.config.trustProxyHops); // real client IPs for rate limiting
  app.use(httpLogger(deps.log));
  app.use(helmet());
  app.use(cors({ origin: deps.config.corsOrigins, credentials: true }));
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => { if (countsTowardMetrics(req.originalUrl)) deps.metrics!.record(res.statusCode, Number(process.hrtime.bigint() - start) / 1e6); });
    next();
  });
  app.use("/admin", express.json({ limit: "1mb" })); // a 5000-point route is ~125 kB
  app.use(express.json({ limit: "10kb" }));

  // Keep-alive target for an uptime pinger. It never touches the database, so pinging it all day doesn't keep a
  // scale-to-zero database awake (and burn its free compute hours).
  app.get("/ping", (_req, res) => { res.type("text/plain").send("ok"); });

  app.get("/health", async (_req, res) => {
    if (deps.draining) return void res.status(503).json({ status: "draining" }); // shutting down: load balancers should stop sending traffic
    try {
      await deps.pool.query("SELECT 1");
      res.json({ status: "ok", db: "up" });
    } catch {
      res.status(503).json({ status: "degraded", db: "down" });
    }
  });

  // Everything below is limited per client address. Many students share one campus IP, so this cap is generous;
  // the strict limits are on sign-in, location posts and admin changes.
  app.use(rateLimit(deps, { name: "ip", max: deps.config.limits.apiPerMin, key: (req) => req.ip }));

  // thresholds the student UI uses to age a bus from LIVE to OFFLINE between server updates
  app.get("/config", (_req, res) => { res.json({ status: deps.config.status }); });

  app.use(catalogRouter(deps));
  app.use("/buses", busesRouter(deps));
  app.use(arrivalsRouter(deps));
  app.use(authRouter(deps));
  app.use(adminRouter(deps));
  app.use(tripsRouter(deps));
  app.use(notFound);
  app.use(makeErrorHandler(reporter));
  return app;
}
