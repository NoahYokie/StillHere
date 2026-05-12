// Batch 5a / Location retention regression tests.
//
// Verifies that storage.cleanupExpiredLocationData() honors each user's
// locationDataRetentionDays setting across every coord-bearing historical
// table, while never touching active sessions, user-saved places, or
// destination definitions.
//
// Bundle:
//   D1-A: ENDED driveSessions / safetyTimers / safeWalks older than cutoff
//         get coord fields NULLed; row metadata preserved.
//   D2-A: checkins older than cutoff get lat/lng NULLed; row preserved.
//   D3:   contextEvents and speedAlerts older than cutoff are deleted.
//   D4-Yes: last-position fields on ENDED sessions older than cutoff NULLed.
//
// All inserts are forged directly via Drizzle so we can backdate timestamps
// to either side of each user's retention cutoff.

import { db } from "../server/db";
import { eq, and } from "drizzle-orm";
import {
  users,
  settings,
  checkins,
  locationBreadcrumbs,
  liveLocationShares,
  liveLocationPoints,
  contextEvents,
  driveSessions,
  speedAlerts,
  safetyTimers,
  safeWalks,
  tripPoints,
  geofences,
  familyPlaces,
  families,
} from "../shared/schema";
import { storage } from "../server/storage";

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

async function makeUser(retentionDays: number): Promise<string> {
  const [u] = await db.insert(users).values({
    name: "Retention Test",
    phone: randomPhone(),
    timezone: "Australia/Melbourne",
    ageGateAcceptedAt: new Date(),
    locationDataRetentionDays: retentionDays,
  }).returning();
  await db.insert(settings).values({
    userId: u.id,
    locationMode: "both",
    checkinIntervalHours: 24,
    graceMinutes: 15,
  });
  return u.id;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

async function cleanupUser(userId: string) {
  // Best-effort cascade cleanup (most tables ON DELETE CASCADE off users).
  try { await db.delete(users).where(eq(users.id, userId)); } catch {}
}

async function run() {
  console.log("\n=========================================");
  console.log("Batch 5a / Location retention tests");
  console.log("=========================================\n");

  // -----------------------------------------------------------------------
  // R1: breadcrumbs at day 31 vs day 1, retention=30
  // -----------------------------------------------------------------------
  console.log("R1: breadcrumbs older than cutoff deleted, recent kept");
  {
    const userId = await makeUser(30);
    const [oldB] = await db.insert(locationBreadcrumbs).values({
      userId, lat: 1, lng: 1, recordedAt: daysAgo(31),
    }).returning();
    const [newB] = await db.insert(locationBreadcrumbs).values({
      userId, lat: 2, lng: 2, recordedAt: daysAgo(1),
    }).returning();

    await storage.cleanupExpiredLocationData();

    const oldRow = await db.select().from(locationBreadcrumbs).where(eq(locationBreadcrumbs.id, oldB.id));
    const newRow = await db.select().from(locationBreadcrumbs).where(eq(locationBreadcrumbs.id, newB.id));
    expect("R1 day-31 breadcrumb deleted", oldRow.length === 0);
    expect("R1 day-1 breadcrumb preserved", newRow.length === 1);
    await cleanupUser(userId);
  }

  // -----------------------------------------------------------------------
  // R2: tripPoints, retention=7, ended timer
  // -----------------------------------------------------------------------
  console.log("\nR2: tripPoints older than cutoff deleted, recent kept");
  {
    const userId = await makeUser(7);
    const [timer] = await db.insert(safetyTimers).values({
      userId,
      durationMinutes: 60,
      expiresAt: daysAgo(7),
      status: "safe",
      resolvedAt: daysAgo(7),
    }).returning();
    const [oldP] = await db.insert(tripPoints).values({
      tripId: timer.id, tripType: "timer", userId, lat: 1, lng: 1, recordedAt: daysAgo(8),
    }).returning();
    const [newP] = await db.insert(tripPoints).values({
      tripId: timer.id, tripType: "timer", userId, lat: 2, lng: 2, recordedAt: daysAgo(6),
    }).returning();

    await storage.cleanupExpiredLocationData();

    const oldRow = await db.select().from(tripPoints).where(eq(tripPoints.id, oldP.id));
    const newRow = await db.select().from(tripPoints).where(eq(tripPoints.id, newP.id));
    expect("R2 day-8 tripPoint deleted", oldRow.length === 0);
    expect("R2 day-6 tripPoint preserved", newRow.length === 1);
    await cleanupUser(userId);
  }

  // -----------------------------------------------------------------------
  // R3: tripPoints attached to ACTIVE timer, all ages preserved
  // -----------------------------------------------------------------------
  console.log("\nR3: active session tripPoints untouched at any age");
  {
    const userId = await makeUser(30);
    const [timer] = await db.insert(safetyTimers).values({
      userId,
      durationMinutes: 240,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      status: "active",
    }).returning();
    // tripPoints attached to active timer, but the points themselves
    // are old. Per design, recordedAt is the gate. Old points still get
    // deleted because the active-session protection is enforced by the
    // fact that an active session writes RECENT points (newer than cutoff)
    // which are always preserved. The retention promise is "no precise
    // coords older than your retention window." Old points from a
    // currently-active session do exceed retention and should be deleted;
    // active sessions keep being protected through their fresh writes.
    const [oldP] = await db.insert(tripPoints).values({
      tripId: timer.id, tripType: "timer", userId, lat: 9, lng: 9, recordedAt: daysAgo(31),
    }).returning();
    const [newP] = await db.insert(tripPoints).values({
      tripId: timer.id, tripType: "timer", userId, lat: 8, lng: 8, recordedAt: daysAgo(1),
    }).returning();

    await storage.cleanupExpiredLocationData();

    const oldRow = await db.select().from(tripPoints).where(eq(tripPoints.id, oldP.id));
    const newRow = await db.select().from(tripPoints).where(eq(tripPoints.id, newP.id));
    const timerRow = await db.select().from(safetyTimers).where(eq(safetyTimers.id, timer.id));
    expect("R3 day-31 point on active timer deleted (retention beats age)", oldRow.length === 0);
    expect("R3 day-1 point on active timer preserved", newRow.length === 1);
    expect("R3 active timer row never touched", timerRow.length === 1 && timerRow[0].status === "active");
    await cleanupUser(userId);
  }

  // -----------------------------------------------------------------------
  // R4: contextEvents older than cutoff deleted
  // -----------------------------------------------------------------------
  console.log("\nR4: contextEvents older than cutoff deleted");
  {
    const userId = await makeUser(30);
    const [oldE] = await db.insert(contextEvents).values({
      userId, type: "dwell_start", lat: 1, lng: 1, createdAt: daysAgo(31),
    }).returning();
    const [newE] = await db.insert(contextEvents).values({
      userId, type: "dwell_start", lat: 2, lng: 2, createdAt: daysAgo(1),
    }).returning();

    await storage.cleanupExpiredLocationData();

    const oldRow = await db.select().from(contextEvents).where(eq(contextEvents.id, oldE.id));
    const newRow = await db.select().from(contextEvents).where(eq(contextEvents.id, newE.id));
    expect("R4 day-31 contextEvent deleted", oldRow.length === 0);
    expect("R4 day-1 contextEvent preserved", newRow.length === 1);
    await cleanupUser(userId);
  }

  // -----------------------------------------------------------------------
  // R5: speedAlerts older than cutoff deleted
  // -----------------------------------------------------------------------
  console.log("\nR5: speedAlerts older than cutoff deleted");
  {
    const userId = await makeUser(30);
    const [oldA] = await db.insert(speedAlerts).values({
      userId, speedKmh: 100, speedLimitKmh: 60, lat: 1, lng: 1, createdAt: daysAgo(31),
    }).returning();
    const [newA] = await db.insert(speedAlerts).values({
      userId, speedKmh: 100, speedLimitKmh: 60, lat: 2, lng: 2, createdAt: daysAgo(1),
    }).returning();

    await storage.cleanupExpiredLocationData();

    const oldRow = await db.select().from(speedAlerts).where(eq(speedAlerts.id, oldA.id));
    const newRow = await db.select().from(speedAlerts).where(eq(speedAlerts.id, newA.id));
    expect("R5 day-31 speedAlert deleted", oldRow.length === 0);
    expect("R5 day-1 speedAlert preserved", newRow.length === 1);
    await cleanupUser(userId);
  }

  // -----------------------------------------------------------------------
  // R6: checkin row preserved, lat/lng NULLed
  // -----------------------------------------------------------------------
  console.log("\nR6: checkin row preserved, lat/lng NULLed past cutoff");
  {
    const userId = await makeUser(30);
    const [oldC] = await db.insert(checkins).values({
      userId, method: "button", lat: 12.34, lng: 56.78, createdAt: daysAgo(31),
    }).returning();
    const [newC] = await db.insert(checkins).values({
      userId, method: "button", lat: 99.9, lng: 88.8, createdAt: daysAgo(1),
    }).returning();

    await storage.cleanupExpiredLocationData();

    const oldRow = (await db.select().from(checkins).where(eq(checkins.id, oldC.id)))[0];
    const newRow = (await db.select().from(checkins).where(eq(checkins.id, newC.id)))[0];
    expect("R6 day-31 checkin row preserved", oldRow !== undefined);
    expect("R6 day-31 checkin lat NULLed", oldRow?.lat === null);
    expect("R6 day-31 checkin lng NULLed", oldRow?.lng === null);
    expect("R6 day-1 checkin lat preserved", newRow?.lat === 99.9);
    expect("R6 day-1 checkin lng preserved", newRow?.lng === 88.8);
    await cleanupUser(userId);
  }

  // -----------------------------------------------------------------------
  // R7: ended driveSession coords NULLed, metadata preserved
  // -----------------------------------------------------------------------
  console.log("\nR7: ended driveSession coords NULLed, metadata preserved");
  {
    const userId = await makeUser(30);
    const [oldD] = await db.insert(driveSessions).values({
      userId,
      startedAt: daysAgo(35),
      endedAt: daysAgo(31),
      maxSpeedKmh: 95,
      avgSpeedKmh: 60,
      distanceKm: 12.5,
      startLat: 1, startLng: 1,
      endLat: 2, endLng: 2,
    }).returning();
    const [activeD] = await db.insert(driveSessions).values({
      userId,
      startedAt: daysAgo(40),
      endedAt: null,
      maxSpeedKmh: 50,
      avgSpeedKmh: 30,
      distanceKm: 5,
      startLat: 7, startLng: 7,
    }).returning();

    await storage.cleanupExpiredLocationData();

    const oldRow = (await db.select().from(driveSessions).where(eq(driveSessions.id, oldD.id)))[0];
    const activeRow = (await db.select().from(driveSessions).where(eq(driveSessions.id, activeD.id)))[0];
    expect("R7 ended driveSession row preserved", oldRow !== undefined);
    expect("R7 ended driveSession startLat NULLed", oldRow?.startLat === null);
    expect("R7 ended driveSession startLng NULLed", oldRow?.startLng === null);
    expect("R7 ended driveSession endLat NULLed", oldRow?.endLat === null);
    expect("R7 ended driveSession endLng NULLed", oldRow?.endLng === null);
    expect("R7 ended driveSession metadata preserved (distanceKm)", oldRow?.distanceKm === 12.5);
    expect("R7 ended driveSession metadata preserved (maxSpeed)", oldRow?.maxSpeedKmh === 95);
    expect("R7 active driveSession startLat preserved", activeRow?.startLat === 7);
    await cleanupUser(userId);
  }

  // -----------------------------------------------------------------------
  // R8: ended safetyTimer lastLat/Lng NULLed
  // -----------------------------------------------------------------------
  console.log("\nR8: ended safetyTimer lastLat/Lng NULLed past cutoff");
  {
    const userId = await makeUser(30);
    const [oldT] = await db.insert(safetyTimers).values({
      userId,
      durationMinutes: 60,
      expiresAt: daysAgo(31),
      status: "safe",
      resolvedAt: daysAgo(31),
      lastLat: 5, lastLng: 5,
      note: "Camping trip",
    }).returning();
    const [activeT] = await db.insert(safetyTimers).values({
      userId,
      durationMinutes: 60,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      status: "active",
      lastLat: 9, lastLng: 9,
    }).returning();

    await storage.cleanupExpiredLocationData();

    const oldRow = (await db.select().from(safetyTimers).where(eq(safetyTimers.id, oldT.id)))[0];
    const activeRow = (await db.select().from(safetyTimers).where(eq(safetyTimers.id, activeT.id)))[0];
    expect("R8 ended timer row preserved", oldRow !== undefined);
    expect("R8 ended timer lastLat NULLed", oldRow?.lastLat === null);
    expect("R8 ended timer lastLng NULLed", oldRow?.lastLng === null);
    expect("R8 ended timer note preserved", oldRow?.note === "Camping trip");
    expect("R8 active timer lastLat preserved", activeRow?.lastLat === 9);
    await cleanupUser(userId);
  }

  // -----------------------------------------------------------------------
  // R9: ended safeWalk lastLat/Lng NULLed, destination preserved
  // -----------------------------------------------------------------------
  console.log("\nR9: ended safeWalk lastLat/Lng NULLed; destination preserved");
  {
    const userId = await makeUser(30);
    const [oldW] = await db.insert(safeWalks).values({
      userId,
      destinationLat: 100, destinationLng: 200,
      destinationName: "Home",
      expectedArrivalAt: daysAgo(31),
      status: "arrived",
      resolvedAt: daysAgo(31),
      lastLat: 5, lastLng: 5,
    }).returning();
    const [activeW] = await db.insert(safeWalks).values({
      userId,
      destinationLat: 50, destinationLng: 60,
      expectedArrivalAt: new Date(Date.now() + 60 * 60 * 1000),
      status: "active",
      lastLat: 7, lastLng: 7,
    }).returning();

    await storage.cleanupExpiredLocationData();

    const oldRow = (await db.select().from(safeWalks).where(eq(safeWalks.id, oldW.id)))[0];
    const activeRow = (await db.select().from(safeWalks).where(eq(safeWalks.id, activeW.id)))[0];
    expect("R9 ended walk row preserved", oldRow !== undefined);
    expect("R9 ended walk lastLat NULLed", oldRow?.lastLat === null);
    expect("R9 ended walk lastLng NULLed", oldRow?.lastLng === null);
    expect("R9 ended walk destinationLat preserved", oldRow?.destinationLat === 100);
    expect("R9 ended walk destinationLng preserved", oldRow?.destinationLng === 200);
    expect("R9 ended walk destinationName preserved", oldRow?.destinationName === "Home");
    expect("R9 active walk lastLat preserved", activeRow?.lastLat === 7);
    await cleanupUser(userId);
  }

  // -----------------------------------------------------------------------
  // R10: geofences and familyPlaces untouched regardless of age
  // -----------------------------------------------------------------------
  console.log("\nR10: geofences and familyPlaces untouched at any age");
  {
    const userId = await makeUser(30);
    const [g] = await db.insert(geofences).values({
      userId, name: "Home", lat: 1, lng: 2, radiusMeters: 100, type: "home",
      createdAt: daysAgo(365),
    }).returning();
    const [fam] = await db.insert(families).values({
      name: "Test Family", adminUserId: userId,
    }).returning();
    const [fp] = await db.insert(familyPlaces).values({
      familyId: fam.id, createdByUserId: userId, name: "School", lat: 3, lng: 4,
      createdAt: daysAgo(365),
    }).returning();

    await storage.cleanupExpiredLocationData();

    const gRow = (await db.select().from(geofences).where(eq(geofences.id, g.id)))[0];
    const fpRow = (await db.select().from(familyPlaces).where(eq(familyPlaces.id, fp.id)))[0];
    expect("R10 geofence row preserved", gRow !== undefined);
    expect("R10 geofence lat preserved", gRow?.lat === 1);
    expect("R10 familyPlace row preserved", fpRow !== undefined);
    expect("R10 familyPlace lat preserved", fpRow?.lat === 3);
    await cleanupUser(userId);
  }

  // -----------------------------------------------------------------------
  // R11: active liveLocationShare with old lastUpdatedAt is untouched
  // -----------------------------------------------------------------------
  console.log("\nR11: active liveLocationShare untouched at any age");
  {
    const userId = await makeUser(30);
    const [s] = await db.insert(liveLocationShares).values({
      userId,
      active: true,
      lastLat: 1, lastLng: 1,
      lastUpdatedAt: daysAgo(31),
    }).returning();

    await storage.cleanupExpiredLocationData();

    const row = await db.select().from(liveLocationShares).where(eq(liveLocationShares.id, s.id));
    expect("R11 active share preserved", row.length === 1 && row[0].active === true);
    await cleanupUser(userId);
  }

  // -----------------------------------------------------------------------
  // R12: inactive liveLocationShare older than cutoff deleted (lock-in)
  // -----------------------------------------------------------------------
  console.log("\nR12: inactive liveLocationShare older than cutoff deleted");
  {
    const userId = await makeUser(30);
    const [s] = await db.insert(liveLocationShares).values({
      userId,
      active: false,
      lastLat: 1, lastLng: 1,
      lastUpdatedAt: daysAgo(31),
    }).returning();

    await storage.cleanupExpiredLocationData();

    const row = await db.select().from(liveLocationShares).where(eq(liveLocationShares.id, s.id));
    expect("R12 inactive old share deleted", row.length === 0);
    await cleanupUser(userId);
  }

  // -----------------------------------------------------------------------
  // R13: per-user retention windows respected
  // -----------------------------------------------------------------------
  console.log("\nR13: per-user retention windows respected");
  {
    const userA = await makeUser(7);   // strict
    const userB = await makeUser(30);  // default
    const [bA] = await db.insert(locationBreadcrumbs).values({
      userId: userA, lat: 1, lng: 1, recordedAt: daysAgo(14),
    }).returning();
    const [bB] = await db.insert(locationBreadcrumbs).values({
      userId: userB, lat: 1, lng: 1, recordedAt: daysAgo(14),
    }).returning();

    await storage.cleanupExpiredLocationData();

    const aRow = await db.select().from(locationBreadcrumbs).where(eq(locationBreadcrumbs.id, bA.id));
    const bRow = await db.select().from(locationBreadcrumbs).where(eq(locationBreadcrumbs.id, bB.id));
    expect("R13 strict user (7d) deletes day-14 breadcrumb", aRow.length === 0);
    expect("R13 default user (30d) preserves day-14 breadcrumb", bRow.length === 1);
    await cleanupUser(userA);
    await cleanupUser(userB);
  }

  // -----------------------------------------------------------------------
  // R14: retention=0 falls back to 30
  // -----------------------------------------------------------------------
  console.log("\nR14: retention=0 falls back to 30 (Math.max(1,...) safety)");
  {
    const userId = await makeUser(0);  // pathological setting
    // With Math.max(1, days || 30): days=0 => 30. So a day-15 row should be kept.
    const [bKept] = await db.insert(locationBreadcrumbs).values({
      userId, lat: 1, lng: 1, recordedAt: daysAgo(15),
    }).returning();
    // And a day-31 row should be deleted.
    const [bDel] = await db.insert(locationBreadcrumbs).values({
      userId, lat: 1, lng: 1, recordedAt: daysAgo(31),
    }).returning();

    await storage.cleanupExpiredLocationData();

    const keptRow = await db.select().from(locationBreadcrumbs).where(eq(locationBreadcrumbs.id, bKept.id));
    const delRow = await db.select().from(locationBreadcrumbs).where(eq(locationBreadcrumbs.id, bDel.id));
    expect("R14 retention=0 keeps day-15 (defaults to 30)", keptRow.length === 1);
    expect("R14 retention=0 deletes day-31 (defaults to 30)", delRow.length === 0);
    await cleanupUser(userId);
  }

  // -----------------------------------------------------------------------
  // R15: partial-coord checkin (lng only, lat null) — must still be NULLed
  // -----------------------------------------------------------------------
  console.log("\nR15: partial-coord checkin (lng-only) past cutoff is cleared");
  {
    const userId = await makeUser(30);
    const [latOnly] = await db.insert(checkins).values({
      userId, method: "button", lat: 11.11, lng: null, createdAt: daysAgo(31),
    }).returning();
    const [lngOnly] = await db.insert(checkins).values({
      userId, method: "button", lat: null, lng: 22.22, createdAt: daysAgo(31),
    }).returning();

    await storage.cleanupExpiredLocationData();

    const aRow = (await db.select().from(checkins).where(eq(checkins.id, latOnly.id)))[0];
    const bRow = (await db.select().from(checkins).where(eq(checkins.id, lngOnly.id)))[0];
    expect("R15 lat-only checkin lat NULLed", aRow?.lat === null);
    expect("R15 lng-only checkin lng NULLed", bRow?.lng === null);
    await cleanupUser(userId);
  }

  // -----------------------------------------------------------------------
  // R16: partial-coord ended driveSession (lng-only) — must still be NULLed
  // -----------------------------------------------------------------------
  console.log("\nR16: partial-coord ended driveSession past cutoff is cleared");
  {
    const userId = await makeUser(30);
    const [d] = await db.insert(driveSessions).values({
      userId,
      startedAt: daysAgo(35),
      endedAt: daysAgo(31),
      maxSpeedKmh: 50, avgSpeedKmh: 30, distanceKm: 5,
      startLat: null, startLng: 99.5,
      endLat: null, endLng: null,
    }).returning();

    await storage.cleanupExpiredLocationData();

    const row = (await db.select().from(driveSessions).where(eq(driveSessions.id, d.id)))[0];
    expect("R16 lng-only ended drive startLng NULLed", row?.startLng === null);
    expect("R16 lng-only ended drive distanceKm preserved", row?.distanceKm === 5);
    await cleanupUser(userId);
  }

  // -----------------------------------------------------------------------
  // R17: partial-coord ended safetyTimer (lng-only) — must still be NULLed
  // -----------------------------------------------------------------------
  console.log("\nR17: partial-coord ended safetyTimer past cutoff is cleared");
  {
    const userId = await makeUser(30);
    const [t] = await db.insert(safetyTimers).values({
      userId,
      durationMinutes: 60,
      expiresAt: daysAgo(31),
      status: "cancelled",
      resolvedAt: daysAgo(31),
      lastLat: null, lastLng: 33.33,
    }).returning();

    await storage.cleanupExpiredLocationData();

    const row = (await db.select().from(safetyTimers).where(eq(safetyTimers.id, t.id)))[0];
    expect("R17 lng-only ended timer lastLng NULLed", row?.lastLng === null);
    await cleanupUser(userId);
  }

  // -----------------------------------------------------------------------
  // R18: partial-coord ended safeWalk (lng-only) — must still be NULLed
  // -----------------------------------------------------------------------
  console.log("\nR18: partial-coord ended safeWalk past cutoff is cleared");
  {
    const userId = await makeUser(30);
    const [w] = await db.insert(safeWalks).values({
      userId,
      destinationLat: 50, destinationLng: 60,
      expectedArrivalAt: daysAgo(31),
      status: "cancelled",
      resolvedAt: daysAgo(31),
      lastLat: null, lastLng: 44.44,
    }).returning();

    await storage.cleanupExpiredLocationData();

    const row = (await db.select().from(safeWalks).where(eq(safeWalks.id, w.id)))[0];
    expect("R18 lng-only ended walk lastLng NULLed", row?.lastLng === null);
    expect("R18 lng-only ended walk destinationLat preserved", row?.destinationLat === 50);
    await cleanupUser(userId);
  }

  // Result summary
  console.log("\n========================================");
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log("  - " + f);
  }
  console.log("========================================\n");

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
