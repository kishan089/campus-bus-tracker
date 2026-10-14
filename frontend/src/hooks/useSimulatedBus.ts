import { useEffect, useState } from "react";
import { pointAt, type LatLng, type Path } from "../utils/geo";

export interface BusState { pos: LatLng; s: number }

/** Phase 1 stand-in for live data. Phase 4 replaces the internals with a socket subscription. */
export function useSimulatedBus(path: Path, speedMps = 8): BusState {
  const [state, setState] = useState<BusState>({ pos: path.points[0], s: 0 });

  useEffect(() => {
    let dist = 0, last = performance.now(), lastEmit = 0, raf = 0;
    const tick = (now: number) => {
      dist += ((now - last) / 1000) * speedMps;
      last = now;
      if (now - lastEmit >= 100) {
        lastEmit = now;
        setState({ pos: pointAt(path, dist), s: ((dist % path.total) + path.total) % path.total });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [path, speedMps]);

  return state;
}
