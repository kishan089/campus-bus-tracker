import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import type { Config } from "../config";
import { AppError } from "../http/errors";

export type Role = "DRIVER" | "ADMIN";
const ISSUER = "campus-bus-tracker";

export function signAccessToken(cfg: Config["auth"], user: { id: number; role: Role }): string {
  return jwt.sign({ role: user.role }, cfg.jwtSecret, { algorithm: "HS256", issuer: ISSUER, subject: String(user.id), expiresIn: cfg.accessTtlS });
}

/** Only proves who the token was issued to. The caller still checks the database for the user's current role and status. */
export function verifyAccessToken(cfg: Config["auth"], token: string): { userId: number } {
  try {
    const p = jwt.verify(token, cfg.jwtSecret, { algorithms: ["HS256"], issuer: ISSUER }) as jwt.JwtPayload;
    const userId = Number(p.sub);
    if (!Number.isInteger(userId)) throw new Error("bad subject");
    return { userId };
  } catch (e) {
    if (e instanceof jwt.TokenExpiredError) throw new AppError(401, "TOKEN_EXPIRED", "Session expired");
    throw new AppError(401, "UNAUTHENTICATED", "Invalid credentials");
  }
}

export const newRefreshToken = () => randomBytes(32).toString("base64url");
export const hashRefreshToken = (t: string) => createHash("sha256").update(t).digest("hex");
