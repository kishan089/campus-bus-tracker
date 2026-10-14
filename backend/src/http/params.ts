import type { Request } from "express";
import { AppError } from "./errors";

/** A positive integer path parameter. Without this, `/admin/trips/abc` reached the database as NaN and came back as a 500. */
export function intParam(req: Request, name = "id"): number {
  const n = Number(req.params[name]);
  if (!Number.isSafeInteger(n) || n <= 0) throw new AppError(400, "INVALID_ID", `"${name}" must be a positive whole number`);
  return n;
}
