import { Router } from "express";
import type { Deps } from "../deps";
import { AppError } from "../http/errors";
import { getRoute, listLandmarks, listRoutes, listStops } from "../repositories/catalog";

export function catalogRouter({ pool }: Deps) {
  const r = Router();
  r.get("/routes", async (_req, res) => { res.json(await listRoutes(pool)); });
  r.get("/routes/:id", async (req, res) => {
    const route = await getRoute(pool, req.params.id);
    if (!route) throw new AppError(404, "ROUTE_NOT_FOUND", "Unknown route");
    res.json(route);
  });
  r.get("/stops", async (_req, res) => { res.json(await listStops(pool)); });
  r.get("/landmarks", async (_req, res) => { res.json(await listLandmarks(pool)); });
  return r;
}
