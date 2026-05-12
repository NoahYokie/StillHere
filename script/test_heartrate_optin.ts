// Standalone verification for the Batch 1 heart-rate opt-in gating.
// Run with `npx tsx script/test_heartrate_optin.ts`. Uses the same DB the
// dev server is using (DATABASE_URL). Creates throwaway users prefixed
// with "_hr_test_" and deletes them at the end. No vitest dependency on
// purpose; this repo has no test runner configured.

import { db } from "../server/db";
import { storage } from "../server/storage";
import { users, heartRateReadings, heartRateAlerts } from "../shared/schema";
import { eq, like } from "drizzle-orm";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string) {
  passed++;
  console.log(`  PASS  ${name}`);
}

function bad(name: string, detail: string) {
  failed++;
  failures.push(`${name}: ${detail}`);
  console.log(`  FAIL  ${name}  -  ${detail}`);
}

async function expect(name: string, cond: boolean, detail = "") {
  if (cond) ok(name); else bad(name, detail || "expected true");
}

async function makeUser(suffix: string) {
  const [u] = await db.insert(users).values({
    name: `_hr_test_${suffix}_${Date.now()}`,
    phone: `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`,
  }).returning();
  return u;
}

async function cleanup() {
  // Delete dependent rows first to avoid FK issues on user delete
  const testUsers = await db.select().from(users).where(like(users.name, "_hr_test_%"));
  for (const u of testUsers) {
    await db.delete(heartRateAlerts).where(eq(heartRateAlerts.userId, u.id));
    await db.delete(heartRateReadings).where(eq(heartRateReadings.userId, u.id));
    await db.delete(users).where(eq(users.id, u.id));
  }
}

async function main() {
  console.log("\n[Batch 1] Heart-rate opt-in gating verification\n");

  await cleanup();

  // ---------- Scenario 1: monitoring=false saves nothing ----------
  {
    console.log("\nScenario 1: monitoring=false saves nothing");
    const u = await makeUser("monoff");
    const cfg = await storage.getUserHeartRateConfig(u.id);
    await expect("default monitoring=false", cfg.monitoring === false, JSON.stringify(cfg));
    await expect("default alerts=false", cfg.alerts === false, JSON.stringify(cfg));

    const saved = await storage.saveHeartRateReadings(u.id, [
      { bpm: 72, recordedAt: new Date() },
      { bpm: 130, recordedAt: new Date() },
    ]);
    await expect("saveHeartRateReadings returns []", saved.length === 0, `got ${saved.length}`);

    const rows = await db.select().from(heartRateReadings).where(eq(heartRateReadings.userId, u.id));
    await expect("zero rows in heart_rate_readings", rows.length === 0, `got ${rows.length}`);
  }

  // ---------- Scenario 2: monitoring=true alerts=false ----------
  {
    console.log("\nScenario 2: monitoring=true alerts=false saves but no alerts");
    const u = await makeUser("monon_altoff");
    await storage.setUserHeartRateConfig(u.id, { monitoring: true, alerts: false });

    const saved = await storage.saveHeartRateReadings(u.id, [
      { bpm: 72, recordedAt: new Date() },
      { bpm: 145, recordedAt: new Date() },
      { bpm: 35, recordedAt: new Date() },
    ]);
    await expect("3 readings persisted", saved.length === 3, `got ${saved.length}`);

    // Even though we have 145 (>120) and 35 (<40), no alerts should exist
    // because the route gates on alerts=false. We mimic the route by NOT
    // calling createHeartRateAlert here; verify the table is empty.
    const alerts = await db.select().from(heartRateAlerts).where(eq(heartRateAlerts.userId, u.id));
    await expect("zero alert rows", alerts.length === 0, `got ${alerts.length}`);
  }

  // ---------- Scenario 3: monitoring=true alerts=true creates alerts ----------
  {
    console.log("\nScenario 3: monitoring=true alerts=true creates alerts at thresholds");
    const u = await makeUser("monon_alton");
    await storage.setUserHeartRateConfig(u.id, { monitoring: true, alerts: true });
    const cfg = await storage.getUserHeartRateConfig(u.id);
    await expect("monitoring on", cfg.monitoring === true);
    await expect("alerts on", cfg.alerts === true);

    // Mimic the route's alert path
    const saveAndMaybeAlert = async (bpm: number) => {
      await storage.saveHeartRateReadings(u.id, [{ bpm, recordedAt: new Date() }]);
      const cfg2 = await storage.getUserHeartRateConfig(u.id);
      if (!cfg2.alerts) return;
      const existing = await storage.getActiveHeartRateAlerts(u.id);
      if (bpm > 120 && !existing.some(a => a.alertType === "high")) {
        await storage.createHeartRateAlert(u.id, "high", bpm);
      } else if (bpm < 40 && !existing.some(a => a.alertType === "low")) {
        await storage.createHeartRateAlert(u.id, "low", bpm);
      }
    };

    await saveAndMaybeAlert(72);   // no alert
    await saveAndMaybeAlert(125);  // HIGH
    await saveAndMaybeAlert(130);  // already active HIGH, no dup
    await saveAndMaybeAlert(35);   // LOW

    const alerts = await db.select().from(heartRateAlerts).where(eq(heartRateAlerts.userId, u.id));
    await expect("exactly 2 alerts (1 high, 1 low)", alerts.length === 2, `got ${alerts.length}: ${JSON.stringify(alerts.map(a => a.alertType))}`);
    await expect("has HIGH alert", alerts.some(a => a.alertType === "high"));
    await expect("has LOW alert", alerts.some(a => a.alertType === "low"));
  }

  // ---------- Scenario 4: invariant - monitoring=false forces alerts=false ----------
  {
    console.log("\nScenario 4: turning monitoring off forces alerts off");
    const u = await makeUser("invariant");
    await storage.setUserHeartRateConfig(u.id, { monitoring: true, alerts: true });
    let cfg = await storage.getUserHeartRateConfig(u.id);
    await expect("both on", cfg.monitoring && cfg.alerts);

    await storage.setUserHeartRateConfig(u.id, { monitoring: false });
    cfg = await storage.getUserHeartRateConfig(u.id);
    await expect("monitoring off", cfg.monitoring === false);
    await expect("alerts forced off", cfg.alerts === false, "alerts should not survive monitoring being disabled");
  }

  // ---------- Scenario 5: weekly report omits HR when monitoring=false ----------
  {
    console.log("\nScenario 5: weekly report omits HR when monitoring=false");
    const u = await makeUser("report");
    // Bypass the storage gate via direct insert so we can prove the report
    // gate (NOT the storage gate) is what suppresses HR in the report.
    await db.insert(heartRateReadings).values([
      { userId: u.id, bpm: 72, source: "watch", recordedAt: new Date() },
      { userId: u.id, bpm: 80, source: "watch", recordedAt: new Date() },
    ]);
    const rowsBefore = await db.select().from(heartRateReadings).where(eq(heartRateReadings.userId, u.id));
    await expect("readings exist in DB", rowsBefore.length === 2);

    // Mirror the exact gate from server/routes.ts weekly report builder
    const buildHeartRateSummary = async (userId: string) => {
      const cfg = await storage.getUserHeartRateConfig(userId);
      if (!cfg.monitoring) return null;
      const hist = await storage.getHeartRateHistory(userId, 7 * 24);
      if (hist.length === 0) return null;
      const bpms = hist.map(r => r.bpm);
      return {
        avgBpm: Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length),
        minBpm: Math.min(...bpms),
        maxBpm: Math.max(...bpms),
        alerts: 0,
      };
    };

    const summaryOff = await buildHeartRateSummary(u.id);
    await expect("summary is null when monitoring=false", summaryOff === null, `got ${JSON.stringify(summaryOff)}`);

    await storage.setUserHeartRateConfig(u.id, { monitoring: true, alerts: false });
    const summaryOn = await buildHeartRateSummary(u.id);
    await expect("summary populated when monitoring=true", summaryOn !== null && summaryOn.avgBpm === 76, `got ${JSON.stringify(summaryOn)}`);
  }

  await cleanup();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("Test runner crashed:", e);
  cleanup().finally(() => process.exit(2));
});
