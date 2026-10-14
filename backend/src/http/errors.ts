import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const DB_DOWN = new Set(["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "57P01", "57P03", "08006", "08001"]);

export const notFound: RequestHandler = (req, res) =>
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found", requestId: (req as any).id } });

/** Anything that wants to hear about unexpected server errors (Sentry in production; nothing in development and tests). */
export interface ErrorReporter { capture(err: unknown, context: { requestId?: string; url?: string; method?: string }): void }

export function makeErrorHandler(reporter?: ErrorReporter): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const requestId = (req as any).id as string | undefined;
    const send = (status: number, error: Record<string, unknown>) => res.status(status).json({ error: { ...error, requestId } });
    if (err instanceof AppError) {
      send(err.status, { code: err.code, message: err.message });
    } else if (err instanceof ZodError) {
      send(400, { code: "VALIDATION_ERROR", message: "Invalid request",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    } else if (err?.type === "entity.parse.failed" || err?.type === "entity.too.large") {
      send(400, { code: "MALFORMED_BODY", message: "Malformed or oversized JSON body" });
    } else if (DB_DOWN.has(err?.code) || /timeout exceeded when trying to connect/.test(err?.message ?? "")) {
      req.log.error({ err }, "database unavailable");
      reporter?.capture(err, { requestId, url: req.originalUrl, method: req.method });
      send(503, { code: "DB_UNAVAILABLE", message: "Service temporarily unavailable" });
    } else {
      req.log.error({ err }, "unhandled error");
      reporter?.capture(err, { requestId, url: req.originalUrl, method: req.method });
      send(500, { code: "INTERNAL", message: "Internal server error" });
    }
  };
}

export const errorHandler = makeErrorHandler();

/** Database constraint failures an admin can cause, turned into messages they can act on. */
export function dbConflict(e: any): AppError | null {
  if (e?.code === "23505") {
    const c: string = e.constraint ?? "";
    if (c.startsWith("users_email")) return new AppError(409, "ALREADY_EXISTS", "That email is already registered");
    if (c === "buses_registration_number_key") return new AppError(409, "ALREADY_EXISTS", "That registration number is already used by another bus");
    return new AppError(409, "ALREADY_EXISTS", "An item with that id already exists");
  }
  if (e?.code === "23503")
    return new AppError(409, "IN_USE", "This is still used elsewhere (for example by trip history). Disable it instead of deleting it.");
  return null;
}

/** Wraps an admin handler so database conflicts surface as 409s with a useful message. */
export const guarded = (fn: (req: any, res: any) => Promise<unknown>) => async (req: any, res: any) => {
  try { await fn(req, res); } catch (e) { throw dbConflict(e) ?? e; }
};
