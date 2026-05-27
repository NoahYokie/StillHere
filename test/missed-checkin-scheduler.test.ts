import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgresql://test:test@localhost:5432/test";

const { computeAnchoredNextCheckinDue, computeMissedCheckinOccurrence, computeNextCheckinDue, isCheckinLeaseClaimable } = await import("../server/storage");
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

  console.log("missed-checkin scheduler tests passed");
} finally {
  await pool.end().catch(() => {});
}
