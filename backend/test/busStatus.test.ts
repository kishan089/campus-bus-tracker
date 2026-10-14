import { describe, expect, it } from "vitest";
import { computeBusStatus } from "../src/services/busStatus";

const T = { liveS: 15, delayedS: 120, offlineS: 600 };
const now = new Date("2026-10-01T10:00:00Z");
const ago = (s: number) => new Date(now.getTime() - s * 1000);
const st = (over: object) =>
  computeBusStatus({ active: true, hasActiveTrip: true, lastReceivedAt: ago(0), ...over }, now, T);

describe("computeBusStatus", () => {
  it("uses the configured thresholds", () => {
    expect(st({ lastReceivedAt: ago(14) })).toBe("LIVE");
    expect(st({ lastReceivedAt: ago(15) })).toBe("DELAYED");
    expect(st({ lastReceivedAt: ago(119) })).toBe("DELAYED");
    expect(st({ lastReceivedAt: ago(120) })).toBe("POSSIBLY_OFFLINE");
    expect(st({ lastReceivedAt: ago(599) })).toBe("POSSIBLY_OFFLINE");
    expect(st({ lastReceivedAt: ago(600) })).toBe("OFFLINE");
  });
  it("handles buses without a live trip or fix", () => {
    expect(st({ active: false })).toBe("DISABLED");
    expect(st({ hasActiveTrip: false })).toBe("NOT_OPERATING");
    expect(st({ lastReceivedAt: null })).toBe("LOCATION_UNAVAILABLE");
  });
});
