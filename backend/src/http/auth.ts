import type { RequestHandler } from "express";
import { verifyAccessToken, type Role } from "../auth/tokens";
import type { Deps } from "../deps";
import { findUserById } from "../repositories/auth";
import { AppError } from "./errors";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { userId?: number; driverId?: number } }
}

/**
 * Requires `Authorization: Bearer <access token>` from an active user holding one of `roles`.
 * The user's role and status are read from the database on every request, not trusted from the token:
 * a disabled driver is locked out at once instead of when their token expires.
 */
export function requireRole(deps: Deps, ...roles: Role[]): RequestHandler {
  return async (req, _res, next) => {
    const header = req.header("authorization") ?? "";
    if (!header.startsWith("Bearer ")) throw new AppError(401, "UNAUTHENTICATED", "Sign in required");
    const { userId } = verifyAccessToken(deps.config.auth, header.slice(7));
    const user = await findUserById(deps.pool, userId);
    if (!user || !user.active) throw new AppError(401, "UNAUTHENTICATED", "Sign in required");
    if (!roles.includes(user.role)) throw new AppError(403, "FORBIDDEN", "You do not have access to this");
    req.userId = user.id;
    if (user.role === "DRIVER") req.driverId = user.id;
    next();
  };
}

export const requireDriver = (deps: Deps) => requireRole(deps, "DRIVER");
export const requireAdmin = (deps: Deps) => requireRole(deps, "ADMIN");
