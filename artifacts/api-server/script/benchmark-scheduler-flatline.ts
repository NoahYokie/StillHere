import { performance } from "node:perf_hooks";

process.env.DATABASE_URL ||= "postgresql://test:test@localhost:5432/test";

const { computeMissedCheckinOccurrence } = await import("../server/storage");
const { pool } = await import("../server/db");

type Sample = { ms: number };

const now = new Date("2026-06-24T12:00:00.000Z");
const zones = ["UTC", "America/New_York", "Australia/Sydney", "Asia/Kolkata", "Pacific/Chatham"];
const prefs = ["09:00", "18:30", "02:30", null];

function callFor(ageDays: number, i: number) {
  const anchorJitterMs = (i % 97) * 13 * 60_000;
  const anchor = new Date(now.getTime() - ageDays * 86_400_000 - anchorJitterMs);
  const timezone = zones[i % zones.length];
  const preferredCheckinTime = prefs[i % prefs.length];
  const intervalHours = i % 4 === 0 ? 168 : 24;
  return computeMissedCheckinOccurrence({
    lastTime: anchor,
    scheduleAnchorTime: anchor,
    now,
    intervalHours,
    preferredCheckinTime,
    timezone,
    lastTimeIsCheckin: false,
  });
}

function percentile(samples: Sample[], pct: number): number {
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * pct))] || 0;
}

function benchAge(ageDays: number, iterations: number): { ageDays: number; iterations: number; p50Ms: number; p95Ms: number; maxMs: number } {
  const samples: Sample[] = [];
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    callFor(ageDays, i);
    const ms = performance.now() - started;
    samples.push({ ms });
  }
  return {
    ageDays,
    iterations,
    p50Ms: Number(percentile(samples, 0.50).toFixed(3)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...samples.map((s) => s.ms)).toFixed(3)),
  };
}

function benchWorkerTick(users: number): {
  users: number;
  totalMs: number;
  longestSynchronousSpanMs: number;
  processed: number;
} {
  let processed = 0;
  let longest = 0;
  const startedAll = performance.now();
  for (let i = 0; i < users; i++) {
    const ageDays = 1 + Math.floor((i / Math.max(1, users - 1)) * 3650);
    const started = performance.now();
    const result = callFor(ageDays, i);
    const span = performance.now() - started;
    longest = Math.max(longest, span);
    if (result) processed++;
  }
  return {
    users,
    totalMs: Number((performance.now() - startedAll).toFixed(3)),
    longestSynchronousSpanMs: Number(longest.toFixed(3)),
    processed,
  };
}

try {
  for (let i = 0; i < 100; i++) callFor(30, i);
  const singleCall = [1, 30, 115, 540, 1095, 3650].map((age) => benchAge(age, 500));
  const workerTick = benchWorkerTick(1000);
  const result = { singleCall, workerTick };
  console.log(JSON.stringify(result, null, 2));

  for (const row of singleCall) {
    if (row.p95Ms >= 25) throw new Error(`p95 exceeded target for age ${row.ageDays}: ${row.p95Ms}ms`);
    if (row.maxMs >= 50) throw new Error(`max exceeded outer guard for age ${row.ageDays}: ${row.maxMs}ms`);
  }
  if (workerTick.longestSynchronousSpanMs >= 50) {
    throw new Error(`worker longest sync span exceeded 50ms: ${workerTick.longestSynchronousSpanMs}ms`);
  }
} finally {
  await pool.end().catch(() => {});
}
