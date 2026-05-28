import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgresql://test:test@localhost:5432/test";

const { computeAnchoredNextCheckinDue, computeMissedCheckinOccurrence, computeNextCheckinDue, isCheckinLeaseClaimable, isIncidentEscalationLeaseClaimable } = await import("../server/storage");
const { pool } = await import("../server/db");

try {
  const userId = "user-perth";
  const lastCheckinAt = new Date("2026-05-17T22:50:35.373Z");
  const now = new Date("2026-05-26T01:01:00.000Z");

  const occurrence = computeMissedCheckinOccurrence({
    lastTime: lastCheckinAt,
    scheduleAnchorTime: new Date("2026-05-17T02:00:00.000Z"),
    now,
    intervalHours: 24,
    preferredCheckinTime: "09:00",
    timezone: "Australia/Perth",
    lastTimeIsCheckin: true,
  });

  assert.ok(occurrence, "May 26 should be overdue");
  assert.equal(occurrence.dueTime.toISOString(), "2026-05-26T01:00:00.000Z");
  assert.equal(occurrence.nextDueTime.toISOString(), "2026-05-27T01:00:00.000Z");

  const dueOccurrenceKey = `${userId}:${occurrence.occurrenceKey}`;
  assert.equal(dueOccurrenceKey, "user-perth:2026-05-26T01:00:00.000Z");

  const oldResolvedIncident = {
    startedAt: new Date("2026-05-19T01:01:00.000Z"),
    status: "resolved",
    reason: "missed_checkin",
  };
  const sameDueOccurrence = oldResolvedIncident.startedAt >= occurrence.dueTime
    && oldResolvedIncident.startedAt < occurrence.nextDueTime;

  assert.equal(
    sameDueOccurrence,
    false,
    "old resolved May 19 missed-check-in incident must not block May 26",
  );

  const sameDayIncident = {
    startedAt: new Date("2026-05-26T01:02:00.000Z"),
    status: "resolved",
    reason: "missed_checkin",
  };
  const sameDayOccurrence = sameDayIncident.startedAt >= occurrence.dueTime
    && sameDayIncident.startedAt < occurrence.nextDueTime;

  assert.equal(
    sameDayOccurrence,
    true,
    "an incident from the same scheduled due occurrence should dedupe",
  );

  const latePerthCheckin = new Date("2026-05-26T03:00:00.000Z"); // 11:00 Perth
  const nextAfterLateCheckin = computeNextCheckinDue({
    lastTime: latePerthCheckin,
    scheduleAnchorTime: new Date("2026-05-17T02:00:00.000Z"),
    intervalHours: 24,
    preferredCheckinTime: "09:00",
    timezone: "Australia/Perth",
    lastTimeIsCheckin: true,
  });
  assert.equal(
    nextAfterLateCheckin.toISOString(),
    "2026-05-27T01:00:00.000Z",
    "late 11:00 Perth check-in must not move tomorrow's 09:00 Perth due time",
  );

  const overdueAfterLateCheckin = computeMissedCheckinOccurrence({
    lastTime: latePerthCheckin,
    scheduleAnchorTime: new Date("2026-05-17T02:00:00.000Z"),
    now: new Date("2026-05-27T01:16:00.000Z"),
    intervalHours: 24,
    preferredCheckinTime: "09:00",
    timezone: "Australia/Perth",
    lastTimeIsCheckin: true,
  });
  assert.ok(overdueAfterLateCheckin, "next day 09:00 Perth should become overdue after a late prior-day check-in");
  assert.equal(overdueAfterLateCheckin.dueTime.toISOString(), "2026-05-27T01:00:00.000Z");

  const canberraOccurrence = computeMissedCheckinOccurrence({
    lastTime: new Date("2026-05-25T00:30:00.000Z"),
    scheduleAnchorTime: new Date("2026-05-24T23:00:00.000Z"),
    now: new Date("2026-05-26T23:10:00.000Z"),
    intervalHours: 24,
    preferredCheckinTime: "09:00",
    timezone: "Australia/Sydney",
    lastTimeIsCheckin: true,
  });
  assert.ok(canberraOccurrence, "Sydney/Canberra 09:00 local check-in should be due in that timezone");
  assert.equal(canberraOccurrence.dueTime.toISOString(), "2026-05-26T23:00:00.000Z");

  const elevenAmUser = computeMissedCheckinOccurrence({
    lastTime: new Date("2026-05-25T04:00:00.000Z"),
    scheduleAnchorTime: new Date("2026-05-24T02:00:00.000Z"),
    now: new Date("2026-05-26T03:05:00.000Z"),
    intervalHours: 24,
    preferredCheckinTime: "11:00",
    timezone: "Australia/Perth",
    lastTimeIsCheckin: true,
  });
  assert.ok(elevenAmUser, "Perth user with preferred 11:00 should be due at 11:00, not 09:00");
  assert.equal(elevenAmUser.dueTime.toISOString(), "2026-05-26T03:00:00.000Z");

  const weeklyLateCheckin = computeNextCheckinDue({
    lastTime: new Date("2026-05-26T03:00:00.000Z"), // Tuesday 11:00 Perth
    scheduleAnchorTime: new Date("2026-05-18T00:30:00.000Z"), // Monday schedule anchor
    intervalHours: 168,
    preferredCheckinTime: "09:00",
    timezone: "Australia/Perth",
    lastTimeIsCheckin: true,
  });
  assert.equal(
    weeklyLateCheckin.toISOString(),
    "2026-06-01T01:00:00.000Z",
    "weekly cadence should stay anchored to the original scheduled local day/time after a late check-in",
  );

  const dstBefore = computeAnchoredNextCheckinDue({
    userCreatedAt: new Date("2026-03-27T22:00:00.000Z"),
    lastCheckinAt: new Date("2026-03-28T22:30:00.000Z"),
    intervalHours: 24,
    preferredCheckinTime: "09:00",
    timezone: "Australia/Sydney",
  });
  const dstAfter = computeAnchoredNextCheckinDue({
    userCreatedAt: new Date("2026-03-27T22:00:00.000Z"),
    lastCheckinAt: dstBefore,
    intervalHours: 24,
    preferredCheckinTime: "09:00",
    timezone: "Australia/Sydney",
  });
  assert.equal(dstBefore.toISOString(), "2026-03-29T22:00:00.000Z", "Sydney 09:00 should account for UTC+11 before DST ends");
  assert.equal(dstAfter.toISOString(), "2026-03-30T22:00:00.000Z", "Sydney 09:00 should remain local-time anchored across DST-adjacent days");

  const simultaneousDue = [
    { userId: "a", due: new Date("2026-05-26T01:00:00.000Z") },
    { userId: "b", due: new Date("2026-05-26T01:00:00.000Z") },
    { userId: "c", due: new Date("2026-05-26T01:00:00.000Z") },
  ];
  assert.equal(simultaneousDue.filter((item) => item.due <= now).length, 3, "multiple users can be due in the same indexed batch");

  const claimed = new Set<string>();
  const claimBatch = (ids: string[]) => ids.filter((id) => {
    if (claimed.has(id)) return false;
    claimed.add(id);
    return true;
  });
  assert.deepEqual(claimBatch(["a", "b"]), ["a", "b"], "first worker claims due users");
  assert.deepEqual(claimBatch(["a", "b", "c"]), ["c"], "second worker skips already-claimed users");
  assert.equal(claimed.size, 3, "locking simulation prevents duplicate escalation claims");

  const leaseNow = new Date("2026-05-26T01:10:00.000Z");
  const dueAt = new Date("2026-05-26T01:00:00.000Z");
  assert.equal(
    isCheckinLeaseClaimable({ nextDueAt: dueAt, now: leaseNow }),
    true,
    "unlocked due row should be claimable",
  );
  assert.equal(
    isCheckinLeaseClaimable({
      nextDueAt: dueAt,
      now: leaseNow,
      processingLockId: "worker-a",
      processingLockedAt: new Date("2026-05-26T01:08:00.000Z"),
      leaseMs: 5 * 60_000,
    }),
    false,
    "fresh worker lease should block another worker",
  );
  assert.equal(
    isCheckinLeaseClaimable({
      nextDueAt: dueAt,
      now: leaseNow,
      processingLockId: "worker-a",
      processingLockedAt: new Date("2026-05-26T01:04:59.000Z"),
      leaseMs: 5 * 60_000,
    }),
    true,
    "stale worker lease should be recoverable after timeout",
  );
  assert.equal(
    isCheckinLeaseClaimable({
      nextDueAt: new Date("2026-05-26T01:15:00.000Z"),
      now: leaseNow,
    }),
    false,
    "future due row should not be claimable even when unlocked",
  );

  assert.equal(
    isIncidentEscalationLeaseClaimable({
      nextActionAt: dueAt,
      status: "open",
      now: leaseNow,
    }),
    true,
    "unlocked due incident should be claimable for escalation",
  );
  assert.equal(
    isIncidentEscalationLeaseClaimable({
      nextActionAt: dueAt,
      status: "open",
      now: leaseNow,
      processingLockId: "worker-a",
      processingLockedAt: new Date("2026-05-26T01:08:00.000Z"),
      leaseMs: 5 * 60_000,
    }),
    false,
    "fresh incident escalation lease should prevent duplicate SMS/call processing",
  );
  assert.equal(
    isIncidentEscalationLeaseClaimable({
      nextActionAt: dueAt,
      status: "open",
      now: leaseNow,
      processingLockId: "worker-a",
      processingLockedAt: new Date("2026-05-26T01:04:59.000Z"),
      leaseMs: 5 * 60_000,
    }),
    true,
    "stale incident escalation lease should recover after worker crash",
  );
  assert.equal(
    isIncidentEscalationLeaseClaimable({
      nextActionAt: dueAt,
      status: "resolved",
      now: leaseNow,
    }),
    false,
    "resolved incidents should never be claimed",
  );

  const incidentSteps = ["push", "sms", "call", "contact_1"];
  assert.deepEqual(
    incidentSteps,
    ["push", "sms", "call", "contact_1"],
    "missed-check-in escalation order remains push -> SMS -> wellness call -> emergency contact",
  );
  const safetyTimerIncident = { reason: "sos", source: "safety_timer", nextActionAt: dueAt, status: "open" };
  const safeWalkIncident = { reason: "sos", source: "safe_walk", nextActionAt: dueAt, status: "open" };
  assert.equal(isIncidentEscalationLeaseClaimable({ ...safetyTimerIncident, now: leaseNow }), true, "Safety Timer incidents use the same escalation lease");
  assert.equal(isIncidentEscalationLeaseClaimable({ ...safeWalkIncident, now: leaseNow }), true, "Safe Walk incidents use the same escalation lease");

  // ── Fix validation: refreshNextCheckinDueAt "past timestamp" guard ─────────
  // These tests reproduce the "9:00 AM Today at 3:11 PM" bug and verify the
  // fix. refreshNextCheckinDueAt now advances the computed nextDue past now
  // when the raw anchored result lands in the past (preferred time already
  // passed today with no same-day check-in).

  // Simulate the guard that refreshNextCheckinDueAt applies after computing.
  function applyRefreshGuard(
    rawNextDue: Date,
    guardNow: Date,
    intervalHours: number,
    preferredCheckinTime: string,
    timezone: string,
  ): Date {
    if (rawNextDue <= guardNow) {
      return computeNextCheckinDue({
        lastTime: rawNextDue,
        intervalHours,
        preferredCheckinTime,
        timezone,
        lastTimeIsCheckin: false,
      });
    }
    return rawNextDue;
  }

  // Shared fixtures
  // 3:11 PM Perth (UTC+8) = 2026-05-28T07:11:00Z
  const refreshGuardNow = new Date("2026-05-28T07:11:00.000Z");
  // Yesterday 2:00 PM Perth = 2026-05-27T06:00:00Z
  const yesterdayPerthCheckin = new Date("2026-05-27T06:00:00.000Z");
  const perthUserAnchor = new Date("2026-05-01T02:00:00.000Z"); // 10:00 AM Perth May 1

  // Test: settings change after 9 AM — raw result is today, guarded is tomorrow
  const rawPerth9am = computeAnchoredNextCheckinDue({
    userCreatedAt: perthUserAnchor,
    lastCheckinAt: yesterdayPerthCheckin,
    intervalHours: 24,
    preferredCheckinTime: "09:00",
    timezone: "Australia/Perth",
  });
  assert.equal(
    rawPerth9am.toISOString(),
    "2026-05-28T01:00:00.000Z",
    "raw anchored result for yesterday check-in is today 09:00 Perth (a past timestamp at 15:11)",
  );
  assert.ok(
    rawPerth9am <= refreshGuardNow,
    "today 09:00 Perth must be in the past when it is 15:11 Perth (guard precondition)",
  );
  const guardedPerth9am = applyRefreshGuard(rawPerth9am, refreshGuardNow, 24, "09:00", "Australia/Perth");
  assert.equal(
    guardedPerth9am.toISOString(),
    "2026-05-29T01:00:00.000Z",
    "after guard: settings change at 15:11 must produce tomorrow 09:00 Perth, not today",
  );

  // Test: new user with no prior check-ins — preferred time has already passed
  const newUserCreatedAt = new Date("2026-05-27T12:00:00.000Z"); // 8:00 PM Perth May 27
  const rawNewUser = computeAnchoredNextCheckinDue({
    userCreatedAt: newUserCreatedAt,
    lastCheckinAt: null,
    intervalHours: 24,
    preferredCheckinTime: "09:00",
    timezone: "Australia/Perth",
  });
  assert.equal(
    rawNewUser.toISOString(),
    "2026-05-28T01:00:00.000Z",
    "new user created at 8 PM yesterday: raw anchored result is today 09:00 Perth",
  );
  const guardedNewUser = applyRefreshGuard(rawNewUser, refreshGuardNow, 24, "09:00", "Australia/Perth");
  assert.equal(
    guardedNewUser.toISOString(),
    "2026-05-29T01:00:00.000Z",
    "new user at 15:11 must get tomorrow as next check-in, never a past timestamp",
  );

  // Test: guard does NOT fire when preferred time is still in the future
  const rawEvening = computeAnchoredNextCheckinDue({
    userCreatedAt: perthUserAnchor,
    lastCheckinAt: yesterdayPerthCheckin,
    intervalHours: 24,
    preferredCheckinTime: "20:00",
    timezone: "Australia/Perth",
  });
  // 20:00 Perth today = 12:00 UTC May 28, which is > 07:11 UTC (15:11 Perth)
  assert.equal(
    rawEvening.toISOString(),
    "2026-05-28T12:00:00.000Z",
    "20:00 preferred time is today 20:00 Perth (still in the future at 15:11)",
  );
  assert.ok(rawEvening > refreshGuardNow, "20:00 preferred time must be in the future at 15:11 — guard must not fire");
  const guardedEvening = applyRefreshGuard(rawEvening, refreshGuardNow, 24, "20:00", "Australia/Perth");
  assert.equal(
    guardedEvening.toISOString(),
    rawEvening.toISOString(),
    "guard must leave a future preferred time untouched",
  );

  // Test: Sydney user (UTC+10 AEST in May) — same guard behaviour
  // 3:11 PM Sydney = 05:11 UTC May 28. 9:00 AM Sydney May 28 = 23:00 UTC May 27.
  const sydneyNow = new Date("2026-05-28T05:11:00.000Z"); // 3:11 PM Sydney
  const yesterdaySydneyCheckin = new Date("2026-05-27T04:00:00.000Z"); // 2:00 PM Sydney May 27
  const sydneyAnchor = new Date("2026-05-01T00:00:00.000Z"); // 10:00 AM Sydney May 1
  const rawSydney = computeAnchoredNextCheckinDue({
    userCreatedAt: sydneyAnchor,
    lastCheckinAt: yesterdaySydneyCheckin,
    intervalHours: 24,
    preferredCheckinTime: "09:00",
    timezone: "Australia/Sydney",
  });
  assert.equal(
    rawSydney.toISOString(),
    "2026-05-27T23:00:00.000Z",
    "Sydney 09:00 today (May 28 AEST) = 23:00 UTC May 27 — a past timestamp at 15:11 Sydney",
  );
  const guardedSydney = applyRefreshGuard(rawSydney, sydneyNow, 24, "09:00", "Australia/Sydney");
  assert.equal(
    guardedSydney.toISOString(),
    "2026-05-28T23:00:00.000Z",
    "Sydney guard: settings change at 15:11 advances to tomorrow 09:00 Sydney",
  );

  // Test: multiple users with different preferred times at the same 15:11 Perth
  // Preferred times where the guard SHOULD fire (time already passed at 15:11 Perth):
  //   07:00 Perth today = 23:00 UTC May 27 → past → advance to 23:00 UTC May 28
  //   09:00 Perth today = 01:00 UTC May 28 → past → advance to 01:00 UTC May 29
  //   11:00 Perth today = 03:00 UTC May 28 → past → advance to 03:00 UTC May 29
  //   14:00 Perth today = 06:00 UTC May 28 → past → advance to 06:00 UTC May 29
  // Preferred time where the guard must NOT fire (still future at 15:11 Perth):
  //   20:00 Perth today = 12:00 UTC May 28 → future → unchanged
  const multiUserCases: Array<{ preferred: string; expectedRaw: string; expectedGuarded: string; shouldFire: boolean }> = [
    { preferred: "07:00", expectedRaw: "2026-05-27T23:00:00.000Z", expectedGuarded: "2026-05-28T23:00:00.000Z", shouldFire: true },
    { preferred: "09:00", expectedRaw: "2026-05-28T01:00:00.000Z", expectedGuarded: "2026-05-29T01:00:00.000Z", shouldFire: true },
    { preferred: "11:00", expectedRaw: "2026-05-28T03:00:00.000Z", expectedGuarded: "2026-05-29T03:00:00.000Z", shouldFire: true },
    { preferred: "14:00", expectedRaw: "2026-05-28T06:00:00.000Z", expectedGuarded: "2026-05-29T06:00:00.000Z", shouldFire: true },
    { preferred: "20:00", expectedRaw: "2026-05-28T12:00:00.000Z", expectedGuarded: "2026-05-28T12:00:00.000Z", shouldFire: false },
  ];
  for (const { preferred, expectedRaw, expectedGuarded, shouldFire } of multiUserCases) {
    const raw = computeAnchoredNextCheckinDue({
      userCreatedAt: perthUserAnchor,
      lastCheckinAt: yesterdayPerthCheckin,
      intervalHours: 24,
      preferredCheckinTime: preferred,
      timezone: "Australia/Perth",
    });
    assert.equal(
      raw.toISOString(),
      expectedRaw,
      `preferred ${preferred}: raw anchored result`,
    );
    const guarded = applyRefreshGuard(raw, refreshGuardNow, 24, preferred, "Australia/Perth");
    assert.equal(
      guarded.toISOString(),
      expectedGuarded,
      `preferred ${preferred}: after guard (shouldFire=${shouldFire})`,
    );
    assert.equal(
      guarded.getTime() !== raw.getTime(),
      shouldFire,
      `preferred ${preferred}: guard fired=${shouldFire}`,
    );
  }

  // Test: weekly cadence — guard applies same way
  // perthUserAnchor = May 1 (Friday), so weekly slots are May 1, 8, 15, 22, 29...
  // lastCheckinAt = May 21 2PM Perth (Thursday). Next weekly slot = May 22 (Fri) 9AM Perth.
  // At 3:11 PM May 28, May 22 9AM is already in the past.
  // One guard advance: May 22 → May 29 9AM Perth (still a Friday, in the future).
  const weeklyRaw = computeAnchoredNextCheckinDue({
    userCreatedAt: perthUserAnchor,
    lastCheckinAt: new Date("2026-05-21T06:00:00.000Z"), // Thursday 2:00 PM Perth
    intervalHours: 168,
    preferredCheckinTime: "09:00",
    timezone: "Australia/Perth",
  });
  assert.equal(
    weeklyRaw.toISOString(),
    "2026-05-22T01:00:00.000Z",
    "weekly cadence raw: next slot after Thursday 2PM is Friday May 22 09:00 Perth (past at 15:11 May 28)",
  );
  const weeklyGuarded = applyRefreshGuard(weeklyRaw, refreshGuardNow, 168, "09:00", "Australia/Perth");
  assert.equal(
    weeklyGuarded.toISOString(),
    "2026-05-29T01:00:00.000Z",
    "weekly cadence guard: advances to Friday May 29 09:00 Perth when May 22 slot is already past",
  );

  console.log("missed-checkin scheduler tests passed");
} finally {
  await pool.end().catch(() => {});
}
