import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgresql://test:test@localhost:5432/test";

const { computeMissedCheckinOccurrence } = await import("../server/storage");
const { pool } = await import("../server/db");

try {
  const userId = "user-perth";
  const lastCheckinAt = new Date("2026-05-17T22:50:35.373Z");
  const now = new Date("2026-05-26T01:01:00.000Z");

  const occurrence = computeMissedCheckinOccurrence({
    lastTime: lastCheckinAt,
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

  console.log("missed-checkin scheduler tests passed");
} finally {
  await pool.end().catch(() => {});
}
