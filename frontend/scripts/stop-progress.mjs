import fs from "node:fs";

const file = process.argv[2] ?? "src/data/campus.json";
const campus = JSON.parse(fs.readFileSync(file, "utf8"));
const R = 6371000;
const rad = (x) => (x * Math.PI) / 180;

const hav = (a, b) => {
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const project = (p, a, b) => {
  const kx = 111320 * Math.cos(rad(a[0])), ky = 110540;
  const px = (p[1] - a[1]) * kx, py = (p[0] - a[0]) * ky;
  const bx = (b[1] - a[1]) * kx, by = (b[0] - a[0]) * ky;
  const len2 = bx * bx + by * by;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return { t, dist: Math.hypot(px - t * bx, py - t * by) };
};

const round1 = (x) => Math.round(x * 10) / 10;

for (const route of campus.routes) {
  const pts = route.points;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hav(pts[i - 1], pts[i]));
  route.total = round1(cum.at(-1));
  route.stopPasses = {};

  for (const stop of campus.stops) {
    const hits = [];
    for (let i = 1; i < pts.length; i++) {
      const { t, dist } = project(stop.pos, pts[i - 1], pts[i]);
      if (dist <= 15) hits.push({ s: cum[i - 1] + t * (cum[i] - cum[i - 1]), dist });
    }
    hits.sort((a, b) => a.s - b.s);
    const clusters = [];
    for (const h of hits) {
      const c = clusters.at(-1);
      if (c && h.s - c.at(-1).s < 25) c.push(h);
      else clusters.push([h]);
    }
    route.stopPasses[stop.id] = clusters
      .map((c) => c.reduce((a, b) => (b.dist < a.dist ? b : a)).s)
      .filter((s) => s < route.total - 10) // drop the wrap-around duplicate of the start
      .map(round1);
  }
}

fs.writeFileSync(file, JSON.stringify(campus, null, 2));
console.log(JSON.stringify(campus.routes[0].stopPasses), "total", campus.routes[0].total);
