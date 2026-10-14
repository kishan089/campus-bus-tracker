import { burnPasswordCheck, verifyPassword } from "../auth/password";
import { hashRefreshToken, newRefreshToken, signAccessToken } from "../auth/tokens";
import type { Deps } from "../deps";
import { AppError } from "../http/errors";
import {
  assignedBuses, consumeRefreshToken, findUserByEmail, findUserById, insertRefreshToken,
  revokeAllRefreshTokens, revokedTokenInfo, revokeRefreshToken, type UserRow,
} from "../repositories/auth";

const REUSE_GRACE_MS = 10_000;

export interface Session {
  accessToken: string;
  expiresIn: number;                 // seconds
  refreshToken: string;              // goes in an httpOnly cookie, never in the response body
  user: { id: number; name: string; email: string; role: UserRow["role"]; buses: { id: string; name: string }[] };
}

export async function profile(deps: Deps, user: UserRow): Promise<Session["user"]> {
  const buses = user.role === "DRIVER" ? await assignedBuses(deps.pool, user.id) : [];
  return { id: user.id, name: user.name, email: user.email, role: user.role, buses };
}

async function openSession(deps: Deps, user: UserRow, userAgent: string | null): Promise<Session> {
  const { auth } = deps.config;
  const refreshToken = newRefreshToken();
  await insertRefreshToken(deps.pool, user.id, hashRefreshToken(refreshToken), new Date(Date.now() + auth.refreshTtlMs), userAgent);
  return {
    accessToken: signAccessToken(auth, user), expiresIn: auth.accessTtlS, refreshToken,
    user: await profile(deps, user),
  };
}

const BAD_LOGIN = () => new AppError(401, "INVALID_CREDENTIALS", "Wrong email or password");

export async function login(deps: Deps, email: string, password: string, userAgent: string | null): Promise<Session> {
  const user = await findUserByEmail(deps.pool, email);
  // Unknown email, wrong password and disabled account all look the same, in text and in timing.
  if (!user) { await burnPasswordCheck(password); throw BAD_LOGIN(); }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok || !user.active) throw BAD_LOGIN();
  return openSession(deps, user, userAgent);
}

/** Trades a refresh token for a new access token and a new refresh token (rotation). */
export async function refresh(deps: Deps, token: string, userAgent: string | null): Promise<Session> {
  const hash = hashRefreshToken(token);
  const userId = await consumeRefreshToken(deps.pool, hash);
  if (userId === null) {
    // A token that was valid once but is already used: someone may have copied it, so end all of that user's sessions.
    // Except just after a rotation: two tabs of one browser refresh at the same moment, and the loser carries the old
    // cookie. That is a race, not theft, so within a few seconds it is only refused (the retry then uses the new cookie).
    const used = await revokedTokenInfo(deps.pool, hash);
    if (used && used.revokedAgoMs > REUSE_GRACE_MS) {
      await revokeAllRefreshTokens(deps.pool, used.userId);
      deps.log.warn({ userId: used.userId }, "refresh token reuse detected, all sessions revoked");
    }
    throw new AppError(401, "UNAUTHENTICATED", "Please sign in again");
  }
  const user = await findUserById(deps.pool, userId);
  if (!user || !user.active) throw new AppError(401, "UNAUTHENTICATED", "Please sign in again");
  return openSession(deps, user, userAgent);
}

export const logout = (deps: Deps, token: string) => revokeRefreshToken(deps.pool, hashRefreshToken(token));
