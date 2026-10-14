import { describe, expect, it } from "vitest";
import { analyzeRoute } from "../src/services/routeBuilder";
import { loadCampus } from "../src/seed/seed";
import type { LatLng } from "../src/geo/geo";

const campus = loadCampus();
const route = campus.routes[0];
const stops = campus.stops.map((s) => ({ id: s.id, name: s.name, lat: s.pos[0], lng: s.pos[1] }));

describe("analyzeRoute", () => {
  it("reproduces the stop passes that were computed by hand with stop-progress.mjs", () => {
    const a = analyzeRoute(route.points, stops);
    expect(a.totalLengthM).toBeCloseTo(route.total, 0);
    const byStop: Record<string, number[]> = {};
    for (const p of a.passes) (byStop[p.stopId] ??= []).push(p.s);
    expect(Object.keys(byStop).sort()).toEqual(Object.keys(route.stopPasses).sort());
    for (const [id, expected] of Object.entries(route.stopPasses)) {
      expect(byStop[id]).toHaveLength(expected.length);
      expected.forEach((s, i) => expect(Math.abs(byStop[id][i] - s)).toBeLessThan(0.2));
    }
    expect(a.unmatchedStops).toEqual([]);
    expect(a.warnings).toEqual([]); // closed loop, no gaps, stops matched
  });

  it("lists stops the route does not pass, with how far away the nearest point is", () => {
    const far = { id: "far", name: "Far Gate", lat: 25.2700, lng: 82.9864 };
    const a = analyzeRoute(route.points, [...stops, far]);
    expect(a.unmatchedStops).toHaveLength(1);
    expect(a.unmatchedStops[0]).toMatchObject({ id: "far" });
    expect(a.unmatchedStops[0].nearestM).toBeGreaterThan(300);
  });

  it("warns about an open route, a gap, and a route no stop is near", () => {
    const open: LatLng[] = [[25.2632, 82.9864], [25.2632, 82.9876], [25.2632, 82.9960]]; // last hop ~850 m
    const a = analyzeRoute(open, stops);
    expect(a.warnings.join(" ")).toMatch(/ends .* from where it starts/);
    expect(a.warnings.join(" ")).toMatch(/Points 2 and 3 are \d+ m apart/);
    const nowhere = analyzeRoute([[10, 10], [10.001, 10], [10, 10]], stops);
    expect(nowhere.warnings.join(" ")).toMatch(/No stop lies within 15 m/);
  });

  it("keeps a stop at the start of a closed loop once, not twice", () => {
    const loop: LatLng[] = [[25.26, 82.99], [25.26, 82.9915], [25.2612, 82.9915], [25.2612, 82.99], [25.26, 82.99]];
    const a = analyzeRoute(loop, [{ id: "home", name: "Home", lat: 25.26, lng: 82.99 }]);
    expect(a.passes.map((p) => p.stopId)).toEqual(["home"]);
  });

  it("an open route can end at a stop", () => {
    const line: LatLng[] = [[25.26, 82.99], [25.26, 82.9915]];
    const a = analyzeRoute(line, [{ id: "end", name: "End", lat: 25.26, lng: 82.9915 }]);
    expect(a.passes).toHaveLength(1);
    expect(a.passes[0].s).toBeGreaterThan(140);
  });
});
