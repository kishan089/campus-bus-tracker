import { describe, expect, it } from "vitest";
import { buildPath, haversine, pointAt, type LatLng } from "../src/geo/geo";
import { circDelta, metresToStop, snapToPath } from "../src/geo/snap";
import { loadCampus } from "../src/seed/seed";

const route = loadCampus().routes[0];
const path = buildPath(route.points);
const passes = route.stopPasses;

// deterministic ~4 m GPS noise
const noisy = ([lat, lng]: LatLng, k: number): LatLng => [
  lat + (4 / 110540) * Math.sin(k * 1.7),
  lng + (4 / 100680) * Math.cos(k * 2.3),
];

describe("metresToStop", () => {
  it("wraps around the loop", () => {
    expect(metresToStop(3600, 100, 3635)).toBeCloseTo(135);
    expect(metresToStop(100, 100, 3635)).toBe(0);
  });
});

describe("snapToPath on the real route (legs only a few metres apart)", () => {
  it("tracks two full loops at 15 m per fix, never jumping legs", () => {
    let lastS: number | undefined = 0; // trip starts at DG Corner
    let k = 0;
    for (let trueS = 15; trueS < path.total * 2; trueS += 15, k++) {
      const snap = snapToPath(path, noisy(pointAt(path, trueS), k), lastS);
      const mapErr = haversine(pointAt(path, snap.s), pointAt(path, trueS)); // what the student sees
      const sErr = Math.abs(circDelta(snap.s, trueS % path.total, path.total));
      expect(mapErr, `map trueS=${trueS}`).toBeLessThan(10);
      expect(sErr, `progress trueS=${trueS}`).toBeLessThan(25);
      lastS = snap.s;
    }
  });

  it("does not snap backwards at the LT4 turnaround", () => {
    const turn = passes["lt4"][0];
    let lastS = turn - 40;
    for (let d = -25; d <= 60; d += 5) {
      const snap = snapToPath(path, pointAt(path, turn + d), lastS);
      expect(snap.s - lastS).toBeGreaterThan(-6);
      lastS = snap.s;
    }
    expect(lastS).toBeGreaterThan(turn + 50);
  });

  it("first fix with no lastS resolves a shared-road tie to the outbound pass", () => {
    expect(snapToPath(path, pointAt(path, 2647.6)).s).toBeLessThan(1000);
  });

  it("after losing lock, a global re-snap finds the road but cannot tell the legs apart", () => {
    const snap = snapToPath(path, pointAt(path, 2700), 100);
    expect(snap.offRoute).toBeLessThan(5);
    expect(snap.s).toBeLessThan(path.total / 2);
  });
});
