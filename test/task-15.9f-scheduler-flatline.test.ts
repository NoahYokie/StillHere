import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgresql://test:test@localhost:5432/test";

const { computeMissedCheckinOccurrence } = await import("../server/storage");
const { pool } = await import("../server/db");

function occurrence(opts: {
  anchor: string;
  lastTime?: string;
  now: string;
  intervalHours?: number;
  preferredCheckinTime?: string | null;
  timezone?: string | null;
  lastTimeIsCheckin?: boolean;
}) {
  return computeMissedCheckinOccurrence({
    lastTime: new Date(opts.lastTime || opts.anchor),
    scheduleAnchorTime: new Date(opts.anchor),
    now: new Date(opts.now),
    intervalHours: opts.intervalHours ?? 24,
    preferredCheckinTime: opts.preferredCheckinTime,
    timezone: opts.timezone,
    lastTimeIsCheckin: opts.lastTimeIsCheckin ?? false,
  });
}

function expectWindow(label: string, result: any, dueTime: string, nextDueTime: string) {
  assert.ok(result, `${label}: expected an overdue occurrence`);
  assert.equal(result.dueTime.toISOString(), dueTime, `${label}: dueTime`);
  assert.equal(result.nextDueTime.toISOString(), nextDueTime, `${label}: nextDueTime`);
  assert.equal(result.occurrenceKey, dueTime, `${label}: occurrenceKey`);
}

try {
  const anchor = "2026-01-01T00:00:00.000Z";

  // Task 15.9F council-ratified boundary convention:
  // canonical occurrence windows are [due, next).
  // Exact due belongs to the current occurrence; exact nextDue belongs to the
  // next occurrence. Do not restore the old (due, next] behavior.
  expectWindow(
    "[due,next) canonical: now exactly equals dueTime resolves to current occurrence",
    occurrence({ anchor, now: "2026-01-03T09:00:00.000Z", preferredCheckinTime: "09:00", timezone: "UTC" }),
    "2026-01-03T09:00:00.000Z",
    "2026-01-04T09:00:00.000Z",
  );
  assert.equal(
    occurrence({
      anchor: "2026-01-01T20:00:00.000Z",
      now: "2026-01-02T08:59:59.999Z",
      preferredCheckinTime: "09:00",
      timezone: "UTC",
    }),
    null,
    "account created after preferred time is not overdue before its first real due",
  );
  assert.equal(
    occurrence({
      anchor,
      lastTime: "2026-01-02T09:00:00.000Z",
      now: "2026-01-03T08:59:59.999Z",
      preferredCheckinTime: "09:00",
      timezone: "UTC",
      lastTimeIsCheckin: true,
    }),
    null,
    "1ms before the next dueTime is not overdue when the prior window was satisfied",
  );
  expectWindow(
    "1ms after dueTime",
    occurrence({ anchor, now: "2026-01-03T09:00:00.001Z", preferredCheckinTime: "09:00", timezone: "UTC" }),
    "2026-01-03T09:00:00.000Z",
    "2026-01-04T09:00:00.000Z",
  );
  expectWindow(
    "[due,next) canonical: now exactly equals nextDueTime resolves to next occurrence",
    occurrence({ anchor, now: "2026-01-04T09:00:00.000Z", preferredCheckinTime: "09:00", timezone: "UTC" }),
    "2026-01-04T09:00:00.000Z",
    "2026-01-05T09:00:00.000Z",
  );
  expectWindow(
    "1ms before nextDueTime stays in prior window",
    occurrence({ anchor, now: "2026-01-04T08:59:59.999Z", preferredCheckinTime: "09:00", timezone: "UTC" }),
    "2026-01-03T09:00:00.000Z",
    "2026-01-04T09:00:00.000Z",
  );

  assert.equal(
    occurrence({
      anchor,
      lastTime: "2026-01-03T09:00:00.000Z",
      now: "2026-01-03T09:00:00.001Z",
      preferredCheckinTime: "09:00",
      timezone: "UTC",
      lastTimeIsCheckin: true,
    }),
    null,
    "lastCheckinAt exactly dueTime satisfies the due window",
  );
  assert.equal(
    occurrence({
      anchor,
      lastTime: "2026-01-04T09:00:00.000Z",
      now: "2026-01-04T09:00:00.001Z",
      preferredCheckinTime: "09:00",
      timezone: "UTC",
      lastTimeIsCheckin: true,
    }),
    null,
    "lastCheckinAt exactly nextDueTime satisfies the next due window",
  );
  assert.equal(
    occurrence({
      anchor,
      lastTime: "2026-01-03T08:59:59.999Z",
      now: "2026-01-03T09:00:00.001Z",
      preferredCheckinTime: "09:00",
      timezone: "UTC",
      lastTimeIsCheckin: true,
    }),
    null,
    "lastCheckinAt 1ms before dueTime satisfies the window under the existing same-local-day early check-in rule",
  );

  const straddleAnchor = "2026-01-01T00:00:00.000Z";
  const straddlePreviousDue = "2026-01-02T09:00:00.000Z";
  const straddleDue = "2026-01-03T09:00:00.000Z";
  const straddleNextDue = "2026-01-04T09:00:00.000Z";
  const beforeStraddle = occurrence({
    anchor: straddleAnchor,
    lastTime: straddlePreviousDue,
    now: "2026-01-03T08:59:59.999Z",
    preferredCheckinTime: "09:00",
    timezone: "UTC",
    lastTimeIsCheckin: true,
  });
  const afterStraddle = occurrence({
    anchor: straddleAnchor,
    lastTime: straddlePreviousDue,
    now: "2026-01-03T09:00:00.001Z",
    preferredCheckinTime: "09:00",
    timezone: "UTC",
    lastTimeIsCheckin: true,
  });
  const repeatedAfterStraddle = occurrence({
    anchor: straddleAnchor,
    lastTime: straddlePreviousDue,
    now: "2026-01-03T09:00:00.500Z",
    preferredCheckinTime: "09:00",
    timezone: "UTC",
    lastTimeIsCheckin: true,
  });
  assert.equal(
    beforeStraddle,
    null,
    "boundary-straddle dedup: worker just before dueTime does not enter the next cycle when prior cycle is satisfied",
  );
  expectWindow(
    "boundary-straddle dedup: worker just after dueTime enters one deterministic current occurrence",
    afterStraddle,
    straddleDue,
    straddleNextDue,
  );
  assert.equal(
    repeatedAfterStraddle?.occurrenceKey,
    afterStraddle?.occurrenceKey,
    "boundary-straddle dedup: repeated post-boundary evaluations use the same occurrenceKey for the same logical cycle",
  );

  expectWindow(
    "spring-forward skipped local hour resolves to first valid local time after skip",
    occurrence({
      anchor: "2026-03-01T05:00:00.000Z",
      now: "2026-03-08T07:00:00.000Z",
      preferredCheckinTime: "02:30",
      timezone: "America/New_York",
    }),
    "2026-03-08T07:00:00.000Z",
    "2026-03-09T06:30:00.000Z",
  );
  expectWindow(
    "fall-back repeated local hour resolves to earlier occurrence",
    occurrence({
      anchor: "2026-10-25T04:00:00.000Z",
      now: "2026-11-01T05:30:00.000Z",
      preferredCheckinTime: "01:30",
      timezone: "America/New_York",
    }),
    "2026-11-01T05:30:00.000Z",
    "2026-11-02T06:30:00.000Z",
  );
  expectWindow(
    "no-DST control zone",
    occurrence({
      anchor: "2026-01-01T00:00:00.000Z",
      now: "2026-01-03T03:30:00.000Z",
      preferredCheckinTime: "09:00",
      timezone: "Asia/Kolkata",
    }),
    "2026-01-03T03:30:00.000Z",
    "2026-01-04T03:30:00.000Z",
  );
  expectWindow(
    "[due,next) DST exact boundary: skipped local hour due instant belongs to current occurrence",
    occurrence({
      anchor: "2026-03-01T05:00:00.000Z",
      now: "2026-03-08T07:00:00.000Z",
      preferredCheckinTime: "02:30",
      timezone: "America/New_York",
    }),
    "2026-03-08T07:00:00.000Z",
    "2026-03-09T06:30:00.000Z",
  );
  expectWindow(
    "[due,next) DST exact nextDue boundary: next due instant starts the next occurrence",
    occurrence({
      anchor: "2026-03-01T05:00:00.000Z",
      now: "2026-03-09T06:30:00.000Z",
      preferredCheckinTime: "02:30",
      timezone: "America/New_York",
    }),
    "2026-03-09T06:30:00.000Z",
    "2026-03-10T06:30:00.000Z",
  );

  expectWindow(
    "ancient daily account resolves to current intended window",
    occurrence({
      anchor: "2016-06-01T00:00:00.000Z",
      lastTime: "2018-01-01T08:00:00.000Z",
      now: "2026-06-24T10:30:00.000Z",
      preferredCheckinTime: "18:00",
      timezone: "Australia/Sydney",
      lastTimeIsCheckin: true,
    }),
    "2026-06-24T08:00:00.000Z",
    "2026-06-25T08:00:00.000Z",
  );
  expectWindow(
    "[due,next) long-stale exact due boundary resolves to current occurrence",
    occurrence({
      anchor: "2016-06-01T00:00:00.000Z",
      lastTime: "2018-01-01T08:00:00.000Z",
      now: "2026-06-24T08:00:00.000Z",
      preferredCheckinTime: "18:00",
      timezone: "Australia/Sydney",
      lastTimeIsCheckin: true,
    }),
    "2026-06-24T08:00:00.000Z",
    "2026-06-25T08:00:00.000Z",
  );
  expectWindow(
    "[due,next) long-stale exact nextDue boundary resolves to next occurrence",
    occurrence({
      anchor: "2016-06-01T00:00:00.000Z",
      lastTime: "2018-01-01T08:00:00.000Z",
      now: "2026-06-25T08:00:00.000Z",
      preferredCheckinTime: "18:00",
      timezone: "Australia/Sydney",
      lastTimeIsCheckin: true,
    }),
    "2026-06-25T08:00:00.000Z",
    "2026-06-26T08:00:00.000Z",
  );
  assert.equal(
    occurrence({
      anchor: "2016-06-01T00:00:00.000Z",
      lastTime: "2026-06-24T08:00:00.000Z",
      now: "2026-06-24T10:30:00.000Z",
      preferredCheckinTime: "18:00",
      timezone: "Australia/Sydney",
      lastTimeIsCheckin: true,
    }),
    null,
    "ancient account with recent within-window check-in is not overdue",
  );
  expectWindow(
    "ancient weekly account resolves to current anchored weekday",
    occurrence({
      anchor: "2016-06-03T00:00:00.000Z",
      lastTime: "2018-01-05T02:00:00.000Z",
      now: "2026-06-06T02:00:00.000Z",
      intervalHours: 168,
      preferredCheckinTime: "09:00",
      timezone: "Australia/Perth",
      lastTimeIsCheckin: true,
    }),
    "2026-06-05T01:00:00.000Z",
    "2026-06-12T01:00:00.000Z",
  );

  expectWindow(
    "null preferred time and timezone use 09:00 UTC",
    occurrence({ anchor, now: "2026-01-03T09:00:00.000Z", preferredCheckinTime: null, timezone: null }),
    "2026-01-03T09:00:00.000Z",
    "2026-01-04T09:00:00.000Z",
  );
  expectWindow(
    "sub-daily interval normalizes to current daily semantics",
    occurrence({ anchor, now: "2026-01-03T09:00:00.000Z", intervalHours: 3, preferredCheckinTime: "09:00", timezone: "UTC" }),
    "2026-01-03T09:00:00.000Z",
    "2026-01-04T09:00:00.000Z",
  );
  expectWindow(
    "non-24h multiple uses bounded elapsed-hours fallback",
    occurrence({ anchor, now: "2026-01-03T02:00:00.000Z", intervalHours: 25, preferredCheckinTime: "09:00", timezone: "UTC" }),
    "2026-01-03T02:00:00.000Z",
    "2026-01-04T03:00:00.000Z",
  );

  const ages = [1, 30, 115, 540, 1095, 3650];
  const zones = ["UTC", "America/New_York", "Australia/Sydney", "Asia/Kolkata", "Pacific/Chatham"];
  const prefs = ["09:00", "18:30", null];
  for (const age of ages) {
    for (const timezone of zones) {
      for (const preferredCheckinTime of prefs) {
        for (const intervalHours of [24, 168]) {
          const now = new Date("2026-06-24T12:00:00.000Z");
          const ageAnchor = new Date(now.getTime() - age * 86_400_000);
          const result = computeMissedCheckinOccurrence({
            lastTime: ageAnchor,
            scheduleAnchorTime: ageAnchor,
            now,
            intervalHours,
            preferredCheckinTime,
            timezone,
            lastTimeIsCheckin: false,
          });
          if (result) {
            assert.ok(result.dueTime <= now, "matrix dueTime <= now");
            assert.ok(now < result.nextDueTime, "matrix now < nextDueTime");
            assert.equal(result.occurrenceKey, result.dueTime.toISOString(), "matrix occurrenceKey follows dueTime");

            const satisfied = computeMissedCheckinOccurrence({
              lastTime: result.dueTime,
              scheduleAnchorTime: ageAnchor,
              now,
              intervalHours,
              preferredCheckinTime,
              timezone,
              lastTimeIsCheckin: true,
            });
            assert.equal(satisfied, null, `within-window check-in should satisfy age=${age} tz=${timezone} interval=${intervalHours}`);
          } else {
            assert.equal(intervalHours, 168, `only not-yet-due weekly matrix rows should be null age=${age} tz=${timezone}`);
            assert.ok(age < 7, `weekly null rows should only happen before the first weekly due age=${age} tz=${timezone}`);
          }
        }
      }
    }
  }

  console.log("Task 15.9F scheduler flatline correctness tests passed");
} finally {
  await pool.end().catch(() => {});
}
