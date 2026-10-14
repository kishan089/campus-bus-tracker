// End-to-end check of the Phase 2/3 API. Works on any OS (Node 18+).
// Usage: npm run smoke            (or: node scripts/smoke.mjs http://localhost:3001)
// Signs in as the seeded dev driver; override with SMOKE_EMAIL / SMOKE_PASSWORD.
// Note: this project runs on port 3001 (port 3000 is reserved for the keera project).
const base = process.argv[2] ?? "http://localhost:3001";
let failed = 0;
let token = "";

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  console.log(`${method} ${path} -> ${res.status}`, json ? JSON.stringify(json).slice(0, 140) : "");
  return { status: res.status, json };
}
function expect(cond, msg) {
  if (!cond) { failed++; console.log(`   FAIL: ${msg}`); }
}

let r = await call("POST", "/auth/login", {
  email: process.env.SMOKE_EMAIL ?? "driver@example.com", password: process.env.SMOKE_PASSWORD ?? "driver-dev-123",
});
expect(r.status === 200 && r.json?.accessToken, "driver should sign in (did you run npm run seed?)");
token = r.json?.accessToken ?? "";
r = await call("GET", "/trips/active");
expect(r.status === 200, "signed-in call should work");
r = await call("GET", "/admin/users");
expect(r.status === 403, "a driver must not reach admin endpoints");
await call("POST", "/trips/end");                                   // clean slate (404 is fine)
r = await call("GET", "/health");
expect(r.status === 200, "health should be 200");

r = await call("GET", "/routes/route-a");
expect(r.json?.points?.length > 50 && r.json?.stops?.length === 8, "route-a has points and 8 stop passes");

r = await call("GET", "/auth/me");
expect(r.json?.name === "Dev Driver" && r.json?.buses?.length > 0, "profile should list assigned buses");

r = await call("POST", "/trips/start", { busId: "bus-1", routeId: "route-a" });
expect(r.status === 201, "trip should start");

r = await call("GET", "/trips/active");
expect(r.json?.trip?.busId === "bus-1", "active trip should be recoverable");

r = await call("POST", "/location", { lat: 25.2632, lng: 82.9876, speed: 5, accuracy: 9, ts: Date.now() });
expect(r.status === 204, "location should be accepted");

r = await call("GET", "/buses/bus-1/location");
expect(r.json?.status === "LIVE" && r.json?.location?.lat === 25.2632, "bus should be LIVE at the posted position");

r = await call("POST", "/trips/end");
expect(r.status === 200, "trip should end");

r = await call("GET", "/buses");
expect(r.json?.[0]?.status === "NOT_OPERATING" && r.json?.[0]?.location === null, "bus should be NOT_OPERATING with no location");

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
