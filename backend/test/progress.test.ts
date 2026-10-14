import { describe, expect, it } from "vitest";
import { buildPath, haversine, pointAt, type LatLng } from "../src/geo/geo";
import { circDelta } from "../src/geo/snap";
import { advanceProgress, buildProgressView, type EtaConfig, type PrevFix, type ProgressState } from "../src/services/progress";
import { buildRouteModel } from "../src/services/routeModel";
import { loadCampus } from "../src/seed/seed";

const campus = loadCampus();
const r = campus.routes[0];
const names = Object.fromEntries(campus.stops.map((s) => [s.id, s.name]));
const model = buildRouteModel("route-a", r.points, Object.entries(r.stopPasses).flatMap(([stopId, l]) => l.map((s) => ({ stopId, name: names[stopId], s }))));
const cfg: EtaConfig = { dwellS: 20, defaultSpeedMps: 5, offRouteM: 30 };
const at = (s: number, speedEstMps = 5): ProgressState => ({ s, offRouteM: 1, speedEstMps });
const view = (s: number, v = 5) => buildProgressView(model, at(s, v), cfg);

describe("route model", () => {
  it("finds the out-and-back turnaround and the terminal", () => {
    expect(model.passes).toHaveLength(8);
    expect(model.turnaroundName).toBe("LT4");
    expect(model.terminalName).toBe("DG CORNER");
    expect(model.path.total).toBeCloseTo(3635.2, 0);
  });
});

describe("ETA", () => {
  it("is distance / speed when no stop lies in between", () => {
    const e = view(700).etas["cse-department"]; // CSE pass 1 at 783.2
    expect(e.metres).toBe(83);
    expect(e.etaSeconds).toBe(17);
    expect(e.justPassed).toBe(false);
    expect(e.headingTo).toBe("LT4");
  });

  it("adds a dwell for every stop passed on the way", () => {
    const e = view(500).etas["lt1"]; // LT1 at 1228; CSE (783) and Chemical (990) lie between
    expect(e.metres).toBe(728);
    expect(e.etaSeconds).toBe(Math.round(728.0 / 5 + 2 * 20));
  });

  it("scales with the bus's own cruising speed", () => {
    expect(view(500, 10).etas["lt1"].etaSeconds).toBeLessThan(view(500, 5).etas["lt1"].etaSeconds);
  });

  it("flags a stop that was just passed and gives the next arrival (the return pass)", () => {
    const e = view(800).etas["cse-department"];
    expect(e.justPassed).toBe(true);
    expect(e.behindM).toBe(17);
    expect(e.metres).toBe(2053);           // pass 2 at 2853.2
    expect(e.headingTo).toBe("DG CORNER"); // the return leg
    expect(view(800).next).toMatchObject({ stopId: "chemical-dept", metres: 190 });
  });

  it("the turnaround stop has a single pass: just passed means a full loop to the next one", () => {
    const e = view(1830).etas["lt4"];
    expect(e.justPassed).toBe(true);
    expect(e.metres).toBeGreaterThan(3500);
    expect(view(1830).next?.stopId).toBe("lt1"); // heading back
  });

  it("knows which way the bus is heading", () => {
    expect(view(1000).next?.headingTo).toBe("LT4");
    expect(view(2000).next?.headingTo).toBe("DG CORNER");
  });

  it("a bus on its way back to the terminal is heading to DG CORNER, including for DG CORNER's own arrival", () => {
    const v = view(3000);
    expect(v.next).toMatchObject({ stopId: "dg-corner", headingTo: "DG CORNER" });
    expect(v.etas["dg-corner"].headingTo).toBe("DG CORNER");
    expect(v.etas["lt4"].headingTo).toBeNull(); // the turnaround itself has no direction
  });

  it("at the terminal at the start of a trip, the bus is arriving at DG CORNER", () => {
    expect(view(0).next).toMatchObject({ stopId: "dg-corner", metres: 0 });
  });

  it("gives no ETA when the bus is off its route", () => {
    const v = buildProgressView(model, { s: 700, offRouteM: 45, speedEstMps: 5 }, cfg);
    expect(v).toMatchObject({ onRoute: false, position: null, next: null, etas: {} });
  });

  it("returns the snapped position on the route", () => {
    const p = view(700).position!;
    expect(haversine([p.lat, p.lng], pointAt(model.path, 700))).toBeLessThan(0.01);
  });
});

describe("advanceProgress", () => {
  const noisy = ([lat, lng]: LatLng, k: number): LatLng => [lat + (4 / 110540) * Math.sin(k * 1.7), lng + (4 / 100680) * Math.cos(k * 2.3)];

  function drive(speedMps: number, opts: { reportSpeed: boolean; loops: number; stepS?: number }) {
    let prev: PrevFix | null = null;
    let worstMap = 0, last!: ProgressState;
    const step = opts.stepS ?? 3;
    const t0 = 1_700_000_000_000;
    for (let i = 1; i * step * speedMps < model.path.total * opts.loops; i++) {
      const trueS = i * step * speedMps;
      const [lat, lng] = noisy(pointAt(model.path, trueS), i);
      const tsMs = t0 + i * step * 1000;
      last = advanceProgress(model, prev, { lat, lng, speed: opts.reportSpeed ? speedMps : null, tsMs }, cfg);
      worstMap = Math.max(worstMap, haversine(pointAt(model.path, last.s), pointAt(model.path, trueS)));
      prev = { s: last.s, offRouteM: last.offRouteM, recordedAtMs: tsMs, speedEstMps: last.speedEstMps };
    }
    return { last, worstMap };
  }

  it("tracks two loops at 8 m/s with a fix every 3 s, and learns the speed from the phone's reading", () => {
    const { last, worstMap } = drive(8, { reportSpeed: true, loops: 2 });
    expect(worstMap).toBeLessThan(10);
    expect(last.speedEstMps).toBeGreaterThan(7.5);
    expect(last.speedEstMps).toBeLessThan(8.5);
  });

  it("learns the speed from progress when the phone reports none", () => {
    const { last, worstMap } = drive(6, { reportSpeed: false, loops: 1 });
    expect(worstMap).toBeLessThan(10);
    expect(last.speedEstMps).toBeGreaterThan(5);
    expect(last.speedEstMps).toBeLessThan(7);
  });

  it("a bus waiting at a stop does not drag the cruise speed down", () => {
    const prev: PrevFix = { s: 783, offRouteM: 1, recordedAtMs: 1000, speedEstMps: 7 };
    const [lat, lng] = pointAt(model.path, 783);
    const st = advanceProgress(model, prev, { lat, lng, speed: 0, tsMs: 4000 }, cfg);
    expect(st.speedEstMps).toBe(7);
  });

  it("clamps absurd speed readings", () => {
    const prev: PrevFix = { s: 100, offRouteM: 1, recordedAtMs: 1000, speedEstMps: 5 };
    const [lat, lng] = pointAt(model.path, 110);
    expect(advanceProgress(model, prev, { lat, lng, speed: 90, tsMs: 4000 }, cfg).speedEstMps).toBeLessThanOrEqual(12);
  });

  it("ignores a duplicate or out-of-order fix", () => {
    const prev: PrevFix = { s: 500, offRouteM: 2, recordedAtMs: 10_000, speedEstMps: 6 };
    const [lat, lng] = pointAt(model.path, 400);
    expect(advanceProgress(model, prev, { lat, lng, tsMs: 9_000 }, cfg)).toEqual({ s: 500, offRouteM: 2, speedEstMps: 6 });
  });

  it("a new trip starts at DG Corner, whatever the previous trip did", () => {
    // 5 m past the start is also 5 m before the loop's end, so the snap may report either; both are DG Corner
    const [lat, lng] = pointAt(model.path, 5);
    const st = advanceProgress(model, null, { lat, lng, tsMs: 1000 }, cfg);
    expect(haversine(pointAt(model.path, st.s), [lat, lng])).toBeLessThan(10);
    expect(Math.min(st.s, model.path.total - st.s)).toBeLessThan(15);
  });

  it("a long gap in fixes widens the search window instead of losing the bus", () => {
    const prev: PrevFix = { s: 1000, offRouteM: 1, recordedAtMs: 0, speedEstMps: 5 };
    const [lat, lng] = pointAt(model.path, 1300); // 300 m in 40 s
    const st = advanceProgress(model, prev, { lat, lng, tsMs: 40_000 }, cfg);
    expect(Math.abs(st.s - 1300)).toBeLessThan(10);
  });
});
