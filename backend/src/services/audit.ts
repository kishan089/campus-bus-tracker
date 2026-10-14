import type { Db } from "../db";

/** Records an admin action. The name is copied so the entry still reads well if the account is deleted later. */
export async function audit(db: Db, adminId: number, action: string, target: string | null, detail: unknown = null) {
  await db.query(
    `INSERT INTO audit_log (user_id, user_name, action, target, detail) SELECT id, name, $2, $3, $4::jsonb FROM users WHERE id = $1`,
    [adminId, action, target, detail === null ? null : JSON.stringify(detail)]);
}

export async function recentAudit(db: Db, limit = 30) {
  return (await db.query(
    `SELECT id, user_name AS "userName", action, target, detail, created_at AS "createdAt"
       FROM audit_log ORDER BY id DESC LIMIT $1`, [limit])).rows;
}
