import type { Db } from "../db";
import type { Role } from "../auth/tokens";

export interface UserRow { id: number; name: string; email: string; role: Role; active: boolean; passwordHash: string }

const USER_COLS = `id, name, email, role, active, password_hash AS "passwordHash"`;

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | null> {
  return (await db.query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE lower(email) = lower($1)`, [email])).rows[0] ?? null;
}

export async function findUserById(db: Db, id: number): Promise<UserRow | null> {
  return (await db.query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id])).rows[0] ?? null;
}

export async function assignedBuses(db: Db, userId: number) {
  return (await db.query<{ id: string; name: string }>(
    `SELECT b.id, b.name FROM driver_buses d JOIN buses b ON b.id = d.bus_id WHERE d.driver_id = $1 AND b.active ORDER BY b.id`,
    [userId])).rows;
}

export async function isAssigned(db: Db, driverId: number, busId: string): Promise<boolean> {
  return (await db.query("SELECT 1 FROM driver_buses WHERE driver_id = $1 AND bus_id = $2", [driverId, busId])).rows.length > 0;
}

export async function insertRefreshToken(db: Db, userId: number, hash: string, expiresAt: Date, userAgent: string | null) {
  await db.query("DELETE FROM refresh_tokens WHERE expires_at < now() - interval '1 day'"); // housekeeping
  await db.query(`INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent) VALUES ($1, $2, $3, $4)`,
    [userId, hash, expiresAt, userAgent?.slice(0, 200) ?? null]);
}

/** Atomically uses up a valid refresh token. Returns the user it belonged to, or null if it was unknown, used, revoked or expired. */
export async function consumeRefreshToken(db: Db, hash: string): Promise<number | null> {
  const r = await db.query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() RETURNING user_id`, [hash]);
  return r.rows[0]?.user_id ?? null;
}

/** The owner of a refresh token that has already been used or revoked, and how long ago that happened. */
export async function revokedTokenInfo(db: Db, hash: string): Promise<{ userId: number; revokedAgoMs: number } | null> {
  const r = await db.query(
    `SELECT user_id, extract(epoch FROM now() - revoked_at) * 1000 AS ago FROM refresh_tokens
      WHERE token_hash = $1 AND revoked_at IS NOT NULL`, [hash]);
  return r.rows[0] ? { userId: r.rows[0].user_id, revokedAgoMs: Number(r.rows[0].ago) } : null;
}

export async function revokeRefreshToken(db: Db, hash: string) {
  await db.query("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [hash]);
}

export async function revokeAllRefreshTokens(db: Db, userId: number) {
  await db.query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
}

export async function listUsers(db: Db) {
  return (await db.query(
    `SELECT u.id, u.name, u.email, u.role, u.active, u.created_at AS "createdAt",
            COALESCE(array_agg(d.bus_id ORDER BY d.bus_id) FILTER (WHERE d.bus_id IS NOT NULL), '{}') AS buses
       FROM users u LEFT JOIN driver_buses d ON d.driver_id = u.id
      GROUP BY u.id ORDER BY u.id`)).rows;
}
