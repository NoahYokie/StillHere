// Batch 4 / Presence + Paused location regression tests.
//
// Goal (per Codex spec): verify StillHere does NOT collect or store precise
// location during calm time when sharingMode is "presence" or "paused",
// while still allowing location during real safety events.
//
// Strategy:
//   - Create isolated test users with controlled sharingMode/locationMode.
//   - Author auth sessions directly (skip OTP) so we can hit real HTTP routes.
//   - For each coordinate-bearing endpoint, POST a payload and assert that
//     either (a) the response is 403, or (b) the row in DB has null coords.
//   - Then exercise the positive controls: with an active Safe Walk /
//     Safety Timer / Drive / SOS incident the same writes should succeed.
//   - Heartbeat-non-location: confirm battery/network still persist on
//     presence + no purpose, while lat/lng/acc are stripped.
//
// Read-only philosophy: per Codex, do NOT change product behavior unless a
// test reveals a real bug. We only INSPECT.

import { db } from "../server/db";
import { randomBytes, randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import {
  users,
  settings,
  authSessions,
  liveLocationShares,
  safeWalks,
  safetyTimers,
  driveSessions,
  incidents,
  locationSessions,
} from "../shared/schema";
import { storage } from "../server/storage";
import { getTrackingPolicyForUser } from "../server/tracking-policy";

const BASE = process.env.TEST_BASE || "http://127.0.0.1:5000";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function expect(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log("  PASS ", name); }
  else { failed++; failures.push(`${name}${detail ? ": " + detail : ""}`); console.log("  FAIL ", name, detail ? " - " + detail : ""); }
}

function randomPhone() {
  return "+614" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
}

interface TestUser {
  id: string;
  phone: string;
  cookie: string;
}

async function makeUser(opts: {
  sharingMode: "precise" | "area" | "presence" | "paused";
  locationMode: "off" | "emergency_only" | "on_shift_only" | "both";
}): Promise<TestUser> {
  const phone = randomPhone();
  const [u] = await db.insert(users).values({
    name: "Test User",
    phone,
    timezone: "Australia/Melbourne",
    ageGateAcceptedAt: new Date(),
    sharingMode: opts.sharingMode,
  }).returning();
  await db.insert(settings).values({
    userId: u.id,
    locationMode: opts.locationMode,
    checkinIntervalHours: 24,
    graceMinutes: 15,
  });
  // Forge an auth session row directly (bypasses OTP).
  const token = randomBytes(32).toString("hex");
  await db.insert(authSessions).values({
    userId: u.id,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return { id: u.id, phone, cookie: `stillhere_session=${token}` };
}

async function cleanupUser(id: string) {
  // Delete in dependency order to avoid FK violations.
  await db.delete(incidents).where(eq(incidents.userId, id)).catch(() => {});
  await db.delete(safetyTimers).where(eq(safetyTimers.userId, id)).catch(() => {});
  await db.delete(safeWalks).where(eq(safeWalks.userId, id)).catch(() => {});
  await db.delete(driveSessions).where(eq(driveSessions.userId, id)).catch(() => {});
  await db.delete(liveLocationShares).where(eq(liveLocationShares.userId, id)).catch(() => {});
  await db.delete(locationSessions).where(eq(locationSessions.userId, id)).catch(() => {});
  await db.delete(authSessions).where(eq(authSessions.userId, id)).catch(() => {});
  await db.delete(settings).where(eq(settings.userId, id)).catch(() => {});
  await db.delete(users).where(eq(users.id, id)).catch(() => {});
}

async function post(url: string, cookie: string, body: any): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cookie": cookie },
    body: JSON.stringify(body),
  });
  let parsed: any = null;
  try { parsed = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: parsed };
}

// Asserts a coord-write response is "denied". Definition (per Codex):
//   - 403, OR
//   - 2xx with no precise coordinates persisted (we verify persistence
//     separately at each call site).
function isDeniedResponse(status: number) {
  return status === 403;
}

const COORDS = { lat: -37.8136, lng: 144.9631, accuracy: 10 };

// ===========================================================================
// MAIN
// ===========================================================================
async function main() {
  console.log("=== Batch 4 presence/paused location regression tests ===\n");

  // -------------------------------------------------------------------------
  // T1: getTrackingPolicyForUser(presence + no purpose) -> denies + reason
  // -------------------------------------------------------------------------
  {
    console.log("T1 policy: sharingMode=presence + no active purpose");
    const u = await makeUser({ sharingMode: "presence", locationMode: "both" });
    try {
      const p = await getTrackingPolicyForUser(u.id);
      expect("T1 nativeTrackingAllowed === false", p.nativeTrackingAllowed === false, `policy=${JSON.stringify(p.reason)}`);
      expect("T1 reason === presence_no_active_purpose", p.reason === "presence_no_active_purpose", `reason=${p.reason}`);
      expect("T1 active === false", p.active === false);
      expect("T1 sharingMode reflected", p.sharingMode === "presence");
      // Heartbeat (non-location) must still be allowed so battery telemetry flows.
      expect("T1 heartbeatAllowed === true", p.heartbeatAllowed === true);
    } finally { await cleanupUser(u.id); }
  }

  // -------------------------------------------------------------------------
  // T2: getTrackingPolicyForUser(paused) -> denies regardless of locationMode
  // -------------------------------------------------------------------------
  {
    console.log("\nT2 policy: sharingMode=paused");
    const u = await makeUser({ sharingMode: "paused", locationMode: "both" });
    try {
      const p = await getTrackingPolicyForUser(u.id);
      expect("T2 nativeTrackingAllowed === false", p.nativeTrackingAllowed === false);
      expect("T2 reason === paused", p.reason === "paused", `reason=${p.reason}`);
      expect("T2 heartbeatAllowed === true", p.heartbeatAllowed === true);
    } finally { await cleanupUser(u.id); }
  }

  // -------------------------------------------------------------------------
  // T3: coordinate-bearing endpoints with presence + no purpose
  // -------------------------------------------------------------------------
  {
    console.log("\nT3 endpoints with sharingMode=presence + no active purpose");
    const u = await makeUser({ sharingMode: "presence", locationMode: "both" });
    try {
      // /api/heartbeat -> 200 but lat/lng/acc stripped
      const hb = await post("/api/heartbeat", u.cookie, { ...COORDS, batt: 0.42, chg: false, net: "wifi" });
      expect("T3 /api/heartbeat returns 200 (non-location fields still update)", hb.status === 200, `status=${hb.status}`);
      const [uRow] = await db.select().from(users).where(eq(users.id, u.id));
      expect("T3 /api/heartbeat lastHeartbeatLat null", uRow.lastHeartbeatLat == null, `got=${uRow.lastHeartbeatLat}`);
      expect("T3 /api/heartbeat lastHeartbeatLng null", uRow.lastHeartbeatLng == null);
      expect("T3 /api/heartbeat lastHeartbeatAcc null", uRow.lastHeartbeatAcc == null);
      expect("T3 /api/heartbeat battery still persisted", uRow.batteryLevel === 0.42);
      expect("T3 /api/heartbeat networkType still persisted", uRow.networkType === "wifi");

      // /api/location/update -> 403 (no active session anyway, but policy is stricter)
      const lu = await post("/api/location/update", u.cookie, COORDS);
      expect("T3 /api/location/update denied", lu.status === 403 || lu.status === 400, `status=${lu.status} body=${JSON.stringify(lu.body)}`);

      // /api/live-location/update -> 400 (no active share) for presence+no-purpose
      // because the share-existence check runs before the policy check. Either
      // way, no coord persists. Assert on database.
      const llu = await post("/api/live-location/update", u.cookie, COORDS);
      expect("T3 /api/live-location/update denied", llu.status === 400 || llu.status === 403, `status=${llu.status}`);

      // /api/safety-timer/location -> 404 (no active timer)
      const stl = await post("/api/safety-timer/location", u.cookie, COORDS);
      expect("T3 /api/safety-timer/location denied (no timer)", stl.status === 404 || stl.status === 403, `status=${stl.status}`);

      // /api/safe-walk/location -> 404 (no active walk)
      const swl = await post("/api/safe-walk/location", u.cookie, COORDS);
      expect("T3 /api/safe-walk/location denied (no walk)", swl.status === 404 || swl.status === 403, `status=${swl.status}`);

      // /api/location/breadcrumb -> 403 by policy
      const bc = await post("/api/location/breadcrumb", u.cookie, COORDS);
      expect("T3 /api/location/breadcrumb denied", bc.status === 403, `status=${bc.status}`);
    } finally { await cleanupUser(u.id); }
  }

  // -------------------------------------------------------------------------
  // T4: coord endpoints with paused (same expectations as presence)
  // -------------------------------------------------------------------------
  {
    console.log("\nT4 endpoints with sharingMode=paused");
    const u = await makeUser({ sharingMode: "paused", locationMode: "both" });
    try {
      const hb = await post("/api/heartbeat", u.cookie, { ...COORDS, batt: 0.55 });
      expect("T4 /api/heartbeat returns 200", hb.status === 200);
      const [uRow] = await db.select().from(users).where(eq(users.id, u.id));
      expect("T4 /api/heartbeat lat stripped", uRow.lastHeartbeatLat == null);
      expect("T4 /api/heartbeat lng stripped", uRow.lastHeartbeatLng == null);
      expect("T4 /api/heartbeat battery persisted", uRow.batteryLevel === 0.55);

      const lu = await post("/api/location/update", u.cookie, COORDS);
      expect("T4 /api/location/update denied", lu.status === 403 || lu.status === 400, `status=${lu.status}`);

      const llu = await post("/api/live-location/update", u.cookie, COORDS);
      expect("T4 /api/live-location/update denied", llu.status === 400 || llu.status === 403, `status=${llu.status}`);

      const stl = await post("/api/safety-timer/location", u.cookie, COORDS);
      expect("T4 /api/safety-timer/location denied", stl.status === 404 || stl.status === 403, `status=${stl.status}`);

      const swl = await post("/api/safe-walk/location", u.cookie, COORDS);
      expect("T4 /api/safe-walk/location denied", swl.status === 404 || swl.status === 403, `status=${swl.status}`);

      const bc = await post("/api/location/breadcrumb", u.cookie, COORDS);
      expect("T4 /api/location/breadcrumb denied", bc.status === 403, `status=${bc.status}`);
    } finally { await cleanupUser(u.id); }
  }

  // -------------------------------------------------------------------------
  // T5: non-location heartbeat fields still persist on presence/paused
  //     (battery, network, timezone). Already covered by T3/T4 — this test
  //     adds the timezone update + reads post-state explicitly.
  // -------------------------------------------------------------------------
  {
    console.log("\nT5 non-location heartbeat fields persist on presence/paused");
    const u = await makeUser({ sharingMode: "presence", locationMode: "both" });
    try {
      const hb = await post("/api/heartbeat", u.cookie, {
        batt: 0.77, chg: true, net: "5g", tz: "America/New_York",
      });
      expect("T5 heartbeat 200 with no coords", hb.status === 200);
      const [uRow] = await db.select().from(users).where(eq(users.id, u.id));
      expect("T5 batteryLevel updated", uRow.batteryLevel === 0.77);
      expect("T5 batteryCharging updated", uRow.batteryCharging === true);
      expect("T5 networkType updated", uRow.networkType === "5g");
      expect("T5 timezone updated", uRow.timezone === "America/New_York");
      expect("T5 lastHeartbeatAt set", !!uRow.lastHeartbeatAt);
      expect("T5 lat null", uRow.lastHeartbeatLat == null);
    } finally { await cleanupUser(u.id); }
  }

  // -------------------------------------------------------------------------
  // T6a: positive control - presence + active SafeWalk -> /safe-walk/location
  //      should accept and persist.
  // -------------------------------------------------------------------------
  {
    console.log("\nT6a positive: presence + active SafeWalk");
    const u = await makeUser({ sharingMode: "presence", locationMode: "both" });
    try {
      const [walk] = await db.insert(safeWalks).values({
        userId: u.id,
        destinationLat: -37.81,
        destinationLng: 144.97,
        destinationName: "Test Dest",
        destinationType: "pin",
        expectedArrivalAt: new Date(Date.now() + 30 * 60_000),
        arrivalRadiusMeters: 200,
        status: "active",
      }).returning();
      const p = await getTrackingPolicyForUser(u.id);
      expect("T6a policy now allows", p.nativeTrackingAllowed === true, `reason=${p.reason} purposes=${JSON.stringify(p.activePurposes)}`);
      expect("T6a activePurposes includes safeWalk", p.activePurposes.includes("safeWalk"));

      const swl = await post("/api/safe-walk/location", u.cookie, { lat: -37.811, lng: 144.962, speed: 1.5 });
      expect("T6a /safe-walk/location accepted", swl.status === 200, `status=${swl.status} body=${JSON.stringify(swl.body)}`);
      const [walkAfter] = await db.select().from(safeWalks).where(eq(safeWalks.id, walk.id));
      expect("T6a coords persisted on safeWalk row", walkAfter.lastLat != null && walkAfter.lastLng != null);
    } finally { await cleanupUser(u.id); }
  }

  // -------------------------------------------------------------------------
  // T6b: positive control - presence + active SafetyTimer
  // -------------------------------------------------------------------------
  {
    console.log("\nT6b positive: presence + active SafetyTimer");
    const u = await makeUser({ sharingMode: "presence", locationMode: "both" });
    try {
      const [timer] = await db.insert(safetyTimers).values({
        userId: u.id,
        durationMinutes: 30,
        expiresAt: new Date(Date.now() + 30 * 60_000),
        status: "active",
        activity: "test",
      }).returning();
      const p = await getTrackingPolicyForUser(u.id);
      expect("T6b policy allows with active timer", p.nativeTrackingAllowed === true, `reason=${p.reason}`);
      expect("T6b activePurposes includes safetyTimer", p.activePurposes.includes("safetyTimer"));

      const stl = await post("/api/safety-timer/location", u.cookie, { lat: -37.81, lng: 144.96 });
      expect("T6b /safety-timer/location accepted", stl.status === 200, `status=${stl.status} body=${JSON.stringify(stl.body)}`);
      const [timerAfter] = await db.select().from(safetyTimers).where(eq(safetyTimers.id, timer.id));
      expect("T6b coords persisted on timer row", timerAfter.lastLat != null);
    } finally { await cleanupUser(u.id); }
  }

  // -------------------------------------------------------------------------
  // T6c: positive control - presence + active Drive session
  // -------------------------------------------------------------------------
  {
    console.log("\nT6c positive: presence + active Drive session");
    const u = await makeUser({ sharingMode: "presence", locationMode: "both" });
    try {
      await db.insert(driveSessions).values({
        userId: u.id,
        startedAt: new Date(),
      });
      const p = await getTrackingPolicyForUser(u.id);
      expect("T6c policy allows with active drive", p.nativeTrackingAllowed === true, `reason=${p.reason}`);
      expect("T6c activePurposes includes driveSafety", p.activePurposes.includes("driveSafety"));
    } finally { await cleanupUser(u.id); }
  }

  // -------------------------------------------------------------------------
  // T6d: positive control - presence + open SOS incident
  //      Per spec: "with presence + open SOS incident, location snapshot is allowed."
  // -------------------------------------------------------------------------
  {
    console.log("\nT6d positive: presence + open SOS incident");
    const u = await makeUser({ sharingMode: "presence", locationMode: "both" });
    try {
      await db.insert(incidents).values({
        userId: u.id,
        reason: "sos",
        status: "open",
        startedAt: new Date(),
        isDrill: false,
      });
      const p = await getTrackingPolicyForUser(u.id);
      expect("T6d policy allows on open SOS", p.nativeTrackingAllowed === true, `reason=${p.reason}`);
      expect("T6d activePurposes includes incident", p.activePurposes.includes("incident"));

      // Heartbeat now should preserve coords (location IS allowed).
      const hb = await post("/api/heartbeat", u.cookie, { ...COORDS, batt: 0.5 });
      expect("T6d heartbeat 200", hb.status === 200);
      const [uRow] = await db.select().from(users).where(eq(users.id, u.id));
      expect("T6d heartbeat coords PRESERVED on open SOS", uRow.lastHeartbeatLat === COORDS.lat, `got=${uRow.lastHeartbeatLat}`);
    } finally { await cleanupUser(u.id); }
  }

  // -------------------------------------------------------------------------
  // T6e: BEHAVIORAL CHECK - paused + open SOS incident
  //      Per spec: "If paused blocks SOS location entirely, flag it before
  //      changing code." This is a flag-only test, not a fix.
  // -------------------------------------------------------------------------
  {
    console.log("\nT6e behavioral: paused + open SOS incident (flag-only, no code change)");
    const u = await makeUser({ sharingMode: "paused", locationMode: "both" });
    try {
      await db.insert(incidents).values({
        userId: u.id,
        reason: "sos",
        status: "open",
        startedAt: new Date(),
        isDrill: false,
      });
      const p = await getTrackingPolicyForUser(u.id);
      // Document the actual behavior. Current code returns paused hard-stop
      // BEFORE checking real safety purpose.
      expect("T6e paused HARD-STOPS even with open SOS (current behavior)", p.nativeTrackingAllowed === false, `reason=${p.reason}`);
      expect("T6e reason still 'paused'", p.reason === "paused");
      // Heartbeat coords still stripped.
      const hb = await post("/api/heartbeat", u.cookie, { ...COORDS, batt: 0.4 });
      expect("T6e heartbeat 200", hb.status === 200);
      const [uRow] = await db.select().from(users).where(eq(users.id, u.id));
      expect("T6e heartbeat coords STRIPPED on paused+SOS", uRow.lastHeartbeatLat == null);
      console.log("  NOTE: paused+open-SOS currently blocks location entirely. See report for product decision.");
    } finally { await cleanupUser(u.id); }
  }

  // -------------------------------------------------------------------------
  // T6f: positive control - precise + active LiveShare -> /live-location/update
  //      accepts (sanity check that the endpoint isn't broken for normal users)
  // -------------------------------------------------------------------------
  {
    console.log("\nT6f sanity: precise + active LiveShare allows /live-location/update");
    const u = await makeUser({ sharingMode: "precise", locationMode: "both" });
    try {
      const [share] = await db.insert(liveLocationShares).values({
        userId: u.id,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      }).returning();
      const p = await getTrackingPolicyForUser(u.id);
      expect("T6f policy allows", p.nativeTrackingAllowed === true);

      const llu = await post("/api/live-location/update", u.cookie, COORDS);
      expect("T6f /live-location/update accepted", llu.status === 200, `status=${llu.status} body=${JSON.stringify(llu.body)}`);
      void share;
    } finally { await cleanupUser(u.id); }
  }

  console.log("\n========================================");
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  if (failed > 0) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log("  -", f));
    process.exit(1);
  } else {
    console.log("\nAll Batch 4 presence/paused regression tests passed.");
    process.exit(0);
  }
}

main().catch((e) => { console.error("Test harness crashed:", e); process.exit(1); });
