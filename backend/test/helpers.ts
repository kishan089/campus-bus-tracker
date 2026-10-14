import type { Express } from "express";
import request from "supertest";

export const DEV_DRIVER = { email: "driver@example.com", password: "driver-dev-123" };
export const DEV_ADMIN = { email: "admin@example.com", password: "admin-dev-123" };

export async function loginToken(app: Express, who = DEV_DRIVER): Promise<string> {
  const r = await request(app).post("/auth/login").send(who);
  if (r.status !== 200) throw new Error(`test login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.accessToken as string;
}
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
