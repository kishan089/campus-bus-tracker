import { pointAt } from "../geo/geo";
import { circDelta, metresToStop, snapToPath } from "../geo/snap";
import type { RouteModel } from "./routeModel";

export interface EtaConfig { dwellS: number; defaultSpeedMps: number; offRouteM: number }

const MIN_SPEED_MPS = 2;      // a campus bus is never planned slower than this
const MAX_SPEED_MPS = 12;
const ARRIVED_M = 15;         // closer than this to a stop pass = at the stop
const JUST_PASSED_M = 60;     // passed within this distance = "just passed"

export interface PrevFix { s: number; offRouteM: number; recordedAtMs: number; speedEstMps: number | null }
export interface FixIn { lat: number; lng: number; speed?: number | null; tsMs: number }
export interface ProgressState { s: number; offRouteM: number; speedEstMps: number }

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Where on the route is this fix, and how fast is the bus cruising?
 * Progress continuity (the previous fix) is what picks the outbound or return leg; see docs/decisions.md #6.
 */
export function advanceProgress(model: RouteModel, prev: PrevFix | null, fix: FixIn, cfg: EtaConfig): ProgressState {
  const base = prev?.speedEstMps ?? cfg.defaultSpeedMps;
  if (prev && fix.tsMs <= prev.recordedAtMs) // duplicate or out-of-order fix: keep what we knew
    return { s: prev.s, offRouteM: prev.offRouteM, speedEstMps: base };

  const dt = prev ? (fix.tsMs - prev.recordedAtMs) / 1000 : 0;
  const ahead = clamp(dt * 15 + 50, 100, 400); // the longer the gap, the further the bus may have travelled
  const snap = snapToPath(model.path, [fix.lat, fix.lng], prev?.s ?? 0, { ahead }); // a new trip starts at progress 0

  let observed: number | null = null;
  if (fix.speed != null && fix.speed >= 0) observed = fix.speed;
  else if (prev && dt >= 0.5 && dt <= 60) {
    const d = circDelta(snap.s, prev.s, model.path.total);
    if (d >= 0) observed = d / dt;
  }
  // Only moving samples update the cruise speed. Time spent stopped at a stop is handled as dwell, not as "slow".
  const est = observed !== null && observed >= 1 ? 0.7 * base + 0.3 * observed : base;
  return { s: snap.s, offRouteM: snap.offRoute, speedEstMps: clamp(est, MIN_SPEED_MPS, MAX_SPEED_MPS) };
}

export interface EtaEntry {
  stopId: string; name: string;
  metres: number;
  etaSeconds: number;
  justPassed: boolean;          // the bus passed this stop within the last 60 m
  behindM: number | null;       // ...how far back, if so
  headingTo: string | null;     // "LT4" on the outbound leg, "DG CORNER" on the way back
}

export interface BusProgressView {
  s: number;
  offRouteM: number;
  onRoute: boolean;
  position: { lat: number; lng: number } | null; // the fix snapped onto the route line
  speedEstMps: number;
  next: EtaEntry | null;                         // the stop the bus reaches next
  etas: Record<string, EtaEntry>;                // per stop: its next arrival
}

/** Which way is the bus travelling as it reaches this pass? Judged just before the pass, so that
 *  arriving at the terminal at the end of the loop reads "DG CORNER", not the outbound leg it will start next. */
function headingTo(model: RouteModel, passS: number): string | null {
  if (model.turnaroundS === null) return null;
  const total = model.path.total;
  const s = (((passS - 1) % total) + total) % total;
  if (s < model.turnaroundS - 5) return model.turnaroundName;
  if (s > model.turnaroundS + 5) return model.terminalName;
  return null;
}

/**
 * ETA = distance / cruise speed + a fixed dwell for every stop passed on the way.
 * Deterministic on purpose: the inputs are the route, the bus's progress and its smoothed speed.
 */
export function buildProgressView(model: RouteModel, st: ProgressState, cfg: EtaConfig): BusProgressView {
  const { total } = model.path;
  const onRoute = st.offRouteM <= cfg.offRouteM;
  const base = { s: Math.round(st.s * 10) / 10, offRouteM: Math.round(st.offRouteM * 10) / 10, onRoute, speedEstMps: Math.round(st.speedEstMps * 100) / 100 };
  if (!onRoute) return { ...base, position: null, next: null, etas: {} };

  const [lat, lng] = pointAt(model.path, st.s);
  const upcoming = model.passes.map((p) => ({ p, ahead: metresToStop(st.s, p.s, total) }));
  type U = (typeof upcoming)[number];

  const entry = (u: U, justPassed: boolean, behindM: number | null): EtaEntry => {
    const between = upcoming.filter((q) => q !== u && q.ahead >= ARRIVED_M && q.ahead < u.ahead).length;
    return {
      stopId: u.p.stopId, name: u.p.name,
      metres: Math.round(u.ahead),
      etaSeconds: Math.round(u.ahead / st.speedEstMps + cfg.dwellS * between),
      justPassed, behindM, headingTo: headingTo(model, u.p.s),
    };
  };

  const etas: Record<string, EtaEntry> = {};
  const byStop = new Map<string, U[]>();
  for (const u of upcoming) byStop.set(u.p.stopId, [...(byStop.get(u.p.stopId) ?? []), u]);
  for (const [stopId, list] of byStop) {
    const passed = list.find((u) => u.ahead > total - JUST_PASSED_M);
    const others = list.filter((u) => u !== passed);
    const pick = others.length ? others.reduce((a, b) => (b.ahead < a.ahead ? b : a)) : passed!;
    etas[stopId] = entry(pick, passed !== undefined, passed ? Math.round(total - passed.ahead) : null);
  }

  const notPassed = upcoming.filter((u) => u.ahead <= total - JUST_PASSED_M);
  const nextU = notPassed.length ? notPassed.reduce((a, b) => (b.ahead < a.ahead ? b : a)) : null;
  return { ...base, position: { lat, lng }, next: nextU ? entry(nextU, false, null) : null, etas };
}
