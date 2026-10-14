import type { CookieOptions, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { LoginGuard } from "../auth/loginLimiter";
import { limiterOf, rateLimit } from "../security/rateLimit";
import type { Deps } from "../deps";
import { AppError } from "../http/errors";
import { requireRole } from "../http/auth";
import { findUserById } from "../repositories/auth";
import { login, logout, profile, refresh, type Session } from "../services/authService";

const COOKIE = "refresh_token";
const loginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(200) });

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function authRouter(deps: Deps) {
  const r = Router();
  const { auth } = deps.config;
  const guard = new LoginGuard(limiterOf(deps), auth.loginMaxAttempts, auth.loginMaxAttempts * 3, auth.loginWindowMs);
  // requests per minute from one address, whatever the outcome (the guard above counts only failures)
  r.use(["/auth/login", "/auth/refresh"], rateLimit(deps, { name: "auth", max: deps.config.limits.loginPerMin, key: (req) => req.ip }));

  // Path "/" because behind a proxy the browser's path (/api/auth/...) differs from the one this server sees (/auth/...)
  const cookieOpts = (): CookieOptions => ({ httpOnly: true, secure: auth.cookieSecure, sameSite: "lax", path: "/" });
  const setCookie = (res: Response, s: Session) => res.cookie(COOKIE, s.refreshToken, { ...cookieOpts(), maxAge: auth.refreshTtlMs });
  const body = (s: Session) => ({ accessToken: s.accessToken, expiresIn: s.expiresIn, user: s.user });

  // Endpoints that act on the cookie need a custom header: a form on another site cannot send one, and a script
  // on another site can't either without a CORS preflight that this server refuses.
  const csrf: RequestHandler = (req, _res, next) => {
    if (!req.header("x-requested-with")) throw new AppError(403, "CSRF", "Missing X-Requested-With header");
    next();
  };

  r.post("/auth/login", async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const ip = req.ip ?? "unknown";
    const wait = await guard.blockedFor(ip, email);
    if (wait !== null) {
      res.setHeader("Retry-After", String(wait));
      throw new AppError(429, "TOO_MANY_ATTEMPTS", `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.`);
    }
    try {
      const session = await login(deps, email, password, req.header("user-agent") ?? null);
      await guard.succeeded(ip, email);
      setCookie(res, session);
      res.json(body(session));
    } catch (e) {
      if (e instanceof AppError && e.code === "INVALID_CREDENTIALS") await guard.fail(ip, email);
      throw e;
    }
  });

  r.post("/auth/refresh", csrf, async (req, res) => {
    const token = readCookie(req, COOKIE);
    if (!token) throw new AppError(401, "UNAUTHENTICATED", "Not signed in");
    try {
      const session = await refresh(deps, token, req.header("user-agent") ?? null);
      setCookie(res, session);
      res.json(body(session));
    } catch (e) {
      if (e instanceof AppError) res.clearCookie(COOKIE, cookieOpts());
      throw e;
    }
  });

  r.post("/auth/logout", csrf, async (req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) await logout(deps, token);
    res.clearCookie(COOKIE, cookieOpts());
    res.status(204).end();
  });

  r.get("/auth/me", requireRole(deps, "DRIVER", "ADMIN"), async (req, res) => {
    res.json(await profile(deps, (await findUserById(deps.pool, req.userId!))!));
  });

  return r;
}
