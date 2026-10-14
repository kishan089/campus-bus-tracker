import type { Server as HttpServer } from "http";
import { Server as SocketIO, type Socket } from "socket.io";
import type { Deps } from "../deps";
import { redisReady } from "../redis";

// ─── Shared event shape ───────────────────────────────────────────────────────
// All events use a discriminated-union `type` so the frontend can handle them
// with a single switch statement.

export interface BusLocationPayload {
  type: "BUS_LOCATION_UPDATED";
  busId: string;
  lat: number;
  lng: number;
  speed: number | null;
  accuracy: number | null;
  heading: number | null;
  /** epoch ms from the driver's phone (recorded_at) */
  ts: number;
  /** ISO string from when the server received the fix */
  receivedAt: string;
  progress: BusProgressView | null; // server-computed position on the route and per-stop ETAs
}

import type { BusProgressView } from "../services/progress";

export interface BusTripStartedPayload { type: "BUS_TRIP_STARTED"; busId: string; routeId: string; tripId: number }
export interface BusTripEndedPayload   { type: "BUS_TRIP_ENDED";   busId: string }

export type ServerToClient = BusLocationPayload | BusTripStartedPayload | BusTripEndedPayload;

// ─── Redis Pub/Sub channel ────────────────────────────────────────────────────
const CHANNEL = "bus:events";
// subscriber clients that currently hold a live subscription to CHANNEL
const subscribed = new WeakSet<object>();

// ─── Attach Socket.IO to the HTTP server ─────────────────────────────────────
export function attachSocketServer(httpServer: HttpServer, deps: Deps) {
  const io = new SocketIO(httpServer, {
    cors: {
      origin: deps.config.corsOrigins,
      methods: ["GET", "POST"], // long-polling sends POSTs
    },
    // keep the path explicit so the Vite proxy can forward it cleanly
    path: "/socket.io/",
    maxHttpBufferSize: 1024,   // browsers send nothing but heartbeats; a big payload is abuse
    connectTimeout: 10_000,
  });

  // Connection caps. Many students share one campus IP, so the per-address cap is generous.
  const perIp = new Map<string, number>();
  let total = 0;
  const addressOf = (socket: Socket) => {
    const fwd = socket.handshake.headers["x-forwarded-for"];
    return (deps.config.env === "production" && typeof fwd === "string" ? fwd.split(",")[0].trim() : socket.handshake.address) || "unknown";
  };
  io.use((socket, next) => {
    if (total >= deps.config.ws.maxConnections) return next(new Error("server_busy"));
    if ((perIp.get(addressOf(socket)) ?? 0) >= deps.config.ws.maxPerIp) return next(new Error("too_many_connections"));
    next();
  });

  io.on("connection", (socket) => {
    const ip = addressOf(socket);
    total++;
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    deps.log.debug({ socketId: socket.id }, "ws client connected");
    // The server only ever sends. A client that sends events is not one of ours.
    socket.onAny(() => socket.disconnect(true));
    socket.on("disconnect", (reason) => {
      total--;
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left <= 0) perIp.delete(ip); else perIp.set(ip, left);
      deps.log.debug({ socketId: socket.id, reason }, "ws client disconnected");
    });
  });

  // Phase 5: subscribe to Redis and fan out to all Socket.IO clients.
  // Phase 4 fallback: if redisSub is absent, broadcast() is called directly
  // from the trip routes (see deps.broadcast).
  if (deps.redisSub) {
    const sub = deps.redisSub;
    // Subscribe on every "ready", not once at startup: if Redis is down when the server boots, a one-off SUBSCRIBE
    // fails and is never retried, leaving a connected-but-deaf subscriber (publishes succeed, nobody hears them).
    const subscribeNow = () => sub.subscribe(CHANNEL, (err) => {
      if (err) deps.log.warn({ err: err.message }, "redis subscribe failed");
      else { subscribed.add(sub); deps.log.info({ channel: CHANNEL }, "redis subscribe ok"); }
    });
    sub.on("ready", subscribeNow);
    sub.on("close", () => subscribed.delete(sub));
    if (sub.status === "wait") sub.connect().catch((e: Error) => deps.log.warn({ err: e.message }, "redis unavailable, will keep retrying"));

    sub.on("message", (_ch: string, raw: string) => {
      try {
        const payload = JSON.parse(raw) as ServerToClient;
        io.emit("event", payload);
      } catch (e) {
        deps.log.warn({ err: (e as Error).message }, "bad message from redis");
      }
    });
  }

  return io;
}

// ─── Broadcast helpers called by trip routes ──────────────────────────────────
// Redis healthy:  publish → every instance's subscriber fans out to its own WS clients.
// Redis down/absent: emit straight to this instance's clients, so live updates keep working
// (other instances miss them until Redis returns; acceptable degradation).
function send(deps: Deps, payload: ServerToClient) {
  const local = () => deps.io?.emit("event", payload);
  if (redisReady(deps.redisPub) && deps.redisSub && subscribed.has(deps.redisSub)) {
    deps.redisPub.publish(CHANNEL, JSON.stringify(payload)).catch((e: Error) => {
      deps.log.warn({ err: e.message }, "redis publish failed, emitting locally");
      local();
    });
  } else {
    local();
  }
}

export const broadcast = {
  location: (deps: Deps, p: Omit<BusLocationPayload, "type">) =>
    send(deps, { type: "BUS_LOCATION_UPDATED", ...p }),

  tripStarted: (deps: Deps, busId: string, routeId: string, tripId: number) =>
    send(deps, { type: "BUS_TRIP_STARTED", busId, routeId, tripId }),

  tripEnded: (deps: Deps, busId: string) =>
    send(deps, { type: "BUS_TRIP_ENDED", busId }),
};
