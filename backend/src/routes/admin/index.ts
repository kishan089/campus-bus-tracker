import { Router } from "express";
import type { Deps } from "../../deps";
import { requireAdmin } from "../../http/auth";
import { rateLimit } from "../../security/rateLimit";
import { fleetRouter } from "./fleet";
import { networkRouter } from "./network";
import { overviewRouter } from "./overview";
import { tripsAdminRouter } from "./trips";

/** Every /admin endpoint requires a signed-in, active ADMIN. */
export function adminRouter(deps: Deps) {
  const r = Router();
  r.use("/admin", requireAdmin(deps));
  // reads are free (the dashboard polls); changes are capped per admin so a stuck script can't churn the database
  r.use("/admin", rateLimit(deps, { name: "admin", max: deps.config.limits.adminPerMin, key: (req) => (req.method === "GET" ? undefined : String(req.userId)) }));
  r.use("/admin", overviewRouter(deps), fleetRouter(deps), networkRouter(deps), tripsAdminRouter(deps));
  return r;
}
