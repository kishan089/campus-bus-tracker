import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Deps } from "../src/deps";
import { createPool } from "../src/db";
import { createLogger } from "../src/logger";
import { createRedisClient, type RedisClient } from "../src/redis";
import { attachSocketServer } from "../src/websocket";
import { DEV_DRIVER } from "./helpers";

const config = loadConfig();
const log = createLogger("silent");
const pool = createPool(config.databaseUrl, log);
const REDIS_URL = process.env.TEST_REDIS_URL; // optional: enables the live-Redis test

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const t = Date.now();
  while (!cond()) { if (Date.now() - t > ms) throw new Error("timed out waiting for events"); await sleep(20); }
}

async function startStack(redis?: { pub: RedisClient; sub: RedisClient }) {
  const deps: Deps = { pool, config, log, redisPub: redis?.pub, redisSub: redis?.sub };
  const server: Server = createServer(createApp(deps));
  deps.io = attachSocketServer(server, deps);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const client: Socket = connect(base, { path: "/socket.io/", transports: ["websocket"] });
  const events: any[] = [];
  client.on("event", (e) => events.push(e));
  await new Promise<void>((r) => client.on("connect", () => r()));
  const login = await fetch(base + "/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(DEV_DRIVER),
  });
  const token = (await login.json()).accessToken as string;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: res.status === 204 ? null : await res.json() };
  };
  const stop = async () => {
    client.close(); deps.io!.close();
    await new Promise((r) => server.close(r));
  };
  return { events, call, stop, base };
}

afterAll(async () => { await pool.end(); });

async function driveOnce(s: Awaited<ReturnType<typeof startStack>>) {
  await pool.query("TRUNCATE gps_locations, trips RESTART IDENTITY CASCADE");
  const start = await s.call("POST", "/trips/start", { busId: "bus-1", routeId: "route-a" });
  const fix = { lat: 25.2632, lng: 82.9876, speed: 5, accuracy: 8, ts: Date.now() };
  const t0 = Date.now();
  const post = await s.call("POST", "/location", fix);
  await until(() => s.events.length >= 2);
  return { start, post, fix, postMs: Date.now() - t0 };
}

describe("live updates over WebSocket", () => {
  it("without Redis: trip start and location reach a connected client", async () => {
    const s = await startStack();
    try {
      const { start, post, fix } = await driveOnce(s);
      expect(post.status).toBe(204);
      expect(s.events[0]).toMatchObject({ type: "BUS_TRIP_STARTED", busId: "bus-1", routeId: "route-a", tripId: start.json.tripId });
      expect(s.events[1]).toMatchObject({ type: "BUS_LOCATION_UPDATED", busId: "bus-1", lat: fix.lat, lng: fix.lng, ts: fix.ts });
      expect(typeof s.events[1].receivedAt).toBe("string");
      expect(s.events[1].progress).toMatchObject({ onRoute: true, next: { stopId: "cse-department" } }); // server-computed
      await s.call("POST", "/trips/end");
      await until(() => s.events.length >= 3);
      expect(s.events[2]).toMatchObject({ type: "BUS_TRIP_ENDED", busId: "bus-1" });
    } finally { await s.stop(); }
  });

  it("with Redis unreachable: still delivers, and does not slow the driver down", async () => {
    const pub = createRedisClient("redis://localhost:6399", log); // nothing listens here
    const sub = createRedisClient("redis://localhost:6399", log);
    pub.connect().catch(() => {});
    sub.connect().catch(() => {});
    const s = await startStack({ pub, sub });
    try {
      const { post, postMs } = await driveOnce(s);
      expect(post.status).toBe(204);
      expect(postMs).toBeLessThan(500);
      expect(s.events.map((e) => e.type)).toEqual(["BUS_TRIP_STARTED", "BUS_LOCATION_UPDATED"]);
      const buses = await s.call("GET", "/buses"); // overlay is skipped, DB answers
      expect(buses.json[0].status).toBe("LIVE");
    } finally { await s.stop(); pub.disconnect(); sub.disconnect(); }
  });

  it.skipIf(!REDIS_URL)("with Redis: events go through Pub/Sub and /buses reads the cached fix", async () => {
    const pub = createRedisClient(REDIS_URL!, log);
    const sub = createRedisClient(REDIS_URL!, log);
    await pub.connect();
    const s = await startStack({ pub, sub });
    try {
      await until(() => sub.status === "ready");
      await sleep(100); // let SUBSCRIBE finish
      const { post, fix } = await driveOnce(s);
      expect(post.status).toBe(204);
      expect(s.events.map((e) => e.type)).toEqual(["BUS_TRIP_STARTED", "BUS_LOCATION_UPDATED"]);
      expect(JSON.parse((await pub.get("bus:bus-1:location"))!)).toMatchObject({ lat: fix.lat, lng: fix.lng });
      const bus = (await s.call("GET", "/buses")).json[0];
      expect(bus).toMatchObject({ status: "LIVE", location: { lat: fix.lat } });
      expect(bus.progress).toMatchObject({ onRoute: true, next: { stopId: "cse-department" } }); // progress survives the Redis cache path
    } finally {
      await pub.del("bus:bus-1:location");
      await s.stop(); pub.disconnect(); sub.disconnect();
    }
  });
});
