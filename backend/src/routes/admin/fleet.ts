import { Router } from "express";
import { z } from "zod";
import { hashPassword } from "../../auth/password";
import type { Deps } from "../../deps";
import { AppError, guarded } from "../../http/errors";
import { intParam } from "../../http/params";
import { listUsers } from "../../repositories/auth";
import { audit } from "../../services/audit";
import { createUser, endSessions, ID_PATTERN, uniqueId, withTx } from "../../services/adminService";

const name = z.string().trim().min(1).max(80);
const idParam = z.string().regex(ID_PATTERN);
const registration = z.string().trim().min(1).max(30).nullable();
const password = z.string().min(10, "Password must be at least 10 characters").max(200);

const BUS_SQL = `
  SELECT b.id, b.name, b.registration_number AS "registrationNumber", b.active,
         COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY u.name)
                     FROM driver_buses d JOIN users u ON u.id = d.driver_id WHERE d.bus_id = b.id), '[]') AS drivers,
         EXISTS (SELECT 1 FROM trips t WHERE t.bus_id = b.id AND t.status = 'ACTIVE') AS "hasActiveTrip",
         EXISTS (SELECT 1 FROM trips t WHERE t.bus_id = b.id) AS "hasHistory"
    FROM buses b`;

export function fleetRouter(deps: Deps) {
  const r = Router();
  const { pool } = deps;
  const adminId = (req: any) => req.userId as number;

  // ---------------- buses ----------------
  r.get("/buses", async (_req, res) => { res.json((await pool.query(`${BUS_SQL} ORDER BY b.id`)).rows); });

  r.post("/buses", guarded(async (req, res) => {
    const b = z.object({ name, id: idParam.optional(), registrationNumber: registration.optional() }).parse(req.body);
    const id = b.id ?? (await uniqueId(pool, "buses", b.name));
    await pool.query("INSERT INTO buses (id, name, registration_number) VALUES ($1, $2, $3)", [id, b.name, b.registrationNumber ?? null]);
    await audit(pool, adminId(req), "bus.create", id, { name: b.name });
    res.status(201).json((await pool.query(`${BUS_SQL} WHERE b.id = $1`, [id])).rows[0]);
  }));

  r.patch("/buses/:id", guarded(async (req, res) => {
    const b = z.object({ name: name.optional(), registrationNumber: registration.optional(), active: z.boolean().optional() }).parse(req.body);
    const cur = (await pool.query(`${BUS_SQL} WHERE b.id = $1`, [req.params.id])).rows[0];
    if (!cur) throw new AppError(404, "BUS_NOT_FOUND", "Unknown bus");
    if (b.active === false && cur.hasActiveTrip) throw new AppError(409, "BUS_IN_USE", "This bus has a trip in progress. End the trip first.");
    await pool.query(
      `UPDATE buses SET name = COALESCE($2, name),
              registration_number = CASE WHEN $3::boolean THEN $4 ELSE registration_number END,
              active = COALESCE($5, active), updated_at = now() WHERE id = $1`,
      [req.params.id, b.name ?? null, b.registrationNumber !== undefined, b.registrationNumber ?? null, b.active ?? null]);
    await audit(pool, adminId(req), b.active === undefined ? "bus.update" : b.active ? "bus.enable" : "bus.disable", req.params.id, b);
    res.json((await pool.query(`${BUS_SQL} WHERE b.id = $1`, [req.params.id])).rows[0]);
  }));

  r.delete("/buses/:id", guarded(async (req, res) => {
    const gone = await pool.query("DELETE FROM buses WHERE id = $1 RETURNING id", [req.params.id]); // trips reference it: 23503 -> 409
    if (!gone.rows[0]) throw new AppError(404, "BUS_NOT_FOUND", "Unknown bus");
    await audit(pool, adminId(req), "bus.delete", req.params.id);
    res.status(204).end();
  }));

  // ---------------- accounts ----------------
  r.get("/users", async (_req, res) => { res.json(await listUsers(pool)); });

  r.post("/users", guarded(async (req, res) => {
    const u = z.object({ name, email: z.string().trim().email().max(254), role: z.enum(["DRIVER", "ADMIN"]), password: password.optional() }).parse(req.body);
    const out = await createUser(pool, u);
    await audit(pool, adminId(req), "user.create", String(out.user.id), { email: out.user.email, role: u.role });
    // the generated password is shown once, here, and never stored in readable form
    res.status(201).json(out);
  }));

  r.patch("/users/:id", guarded(async (req, res) => {
    const id = intParam(req);
    const b = z.object({ name: name.optional(), active: z.boolean().optional(), role: z.enum(["DRIVER", "ADMIN"]).optional(), password: password.optional() }).parse(req.body);
    const cur = (await pool.query("SELECT id, role, active FROM users WHERE id = $1", [id])).rows[0];
    if (!cur) throw new AppError(404, "USER_NOT_FOUND", "Unknown user");
    if (id === adminId(req) && (b.active === false || (b.role && b.role !== cur.role)))
      throw new AppError(409, "CANNOT_MODIFY_SELF", "You can't disable or demote your own account. Ask another admin.");
    await withTx(pool, async (c) => {
      await c.query(
        `UPDATE users SET name = COALESCE($2, name), active = COALESCE($3, active), role = COALESCE($4::user_role, role),
                password_hash = COALESCE($5, password_hash) WHERE id = $1`,
        [id, b.name ?? null, b.active ?? null, b.role ?? null, b.password ? await hashPassword(b.password) : null]);
      if (b.active === false || b.password || (b.role && b.role !== cur.role)) await endSessions(c, id);
    });
    await audit(pool, adminId(req), b.active === false ? "user.disable" : b.active ? "user.enable" : b.password ? "user.reset-password" : "user.update",
      String(id), { ...b, password: b.password ? "(changed)" : undefined });
    res.json((await listUsers(pool)).find((u) => u.id === id));
  }));

  r.put("/users/:id/buses", guarded(async (req, res) => {
    const id = intParam(req);
    const { busIds } = z.object({ busIds: z.array(idParam).max(100) }).parse(req.body);
    const user = (await pool.query("SELECT role FROM users WHERE id = $1", [id])).rows[0];
    if (!user) throw new AppError(404, "USER_NOT_FOUND", "Unknown user");
    if (user.role !== "DRIVER") throw new AppError(409, "NOT_A_DRIVER", "Only drivers are assigned to buses");
    const found = (await pool.query("SELECT id FROM buses WHERE id = ANY($1::text[])", [busIds])).rows.map((x) => x.id);
    const missing = busIds.filter((b) => !found.includes(b));
    if (missing.length) throw new AppError(404, "BUS_NOT_FOUND", `Unknown bus: ${missing.join(", ")}`);
    await withTx(pool, async (c) => {
      await c.query("DELETE FROM driver_buses WHERE driver_id = $1", [id]);
      if (busIds.length) await c.query("INSERT INTO driver_buses (driver_id, bus_id) SELECT $1, unnest($2::text[])", [id, busIds]);
    });
    await audit(pool, adminId(req), "user.assign-buses", String(id), { busIds });
    res.json((await listUsers(pool)).find((u) => u.id === id));
  }));

  r.delete("/users/:id", guarded(async (req, res) => {
    const id = intParam(req);
    if (id === adminId(req)) throw new AppError(409, "CANNOT_MODIFY_SELF", "You can't delete your own account.");
    const gone = await pool.query("DELETE FROM users WHERE id = $1 RETURNING email", [id]); // trips reference it: 23503 -> 409
    if (!gone.rows[0]) throw new AppError(404, "USER_NOT_FOUND", "Unknown user");
    await audit(pool, adminId(req), "user.delete", String(id), { email: gone.rows[0].email });
    res.status(204).end();
  }));

  return r;
}
