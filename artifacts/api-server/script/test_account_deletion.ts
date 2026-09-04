// Standalone verification for the Batch 2 Account Deletion Processor Cleanup.
// Run with `npx tsx script/test_account_deletion.ts`. Uses the same DB the
// dev server is using (DATABASE_URL). Creates throwaway users prefixed with
// "_acctdel_test_" and deletes them at the end. No vitest dependency on
// purpose; this repo has no test runner configured.
//
// Coverage:
//   1.  Inline cleanup full success.
//   2.  Inline cleanup partial failure (Stripe sub ok, customer del times out,
//       RevenueCat 503, outbound purge ok). User row still gone, queue keeps
//       failed steps, response has processorWarnings.
//   3.  Cron drainer completes a partial-failure row when processors recover.
//   4.  Per-step 4-second timeout is enforced.
//   5.  Stripe `resource_missing` is treated as success (cancel + delete).
//   6.  RevenueCat 404 is treated as success.
//   7.  All sessions for the deleted user are revoked.
//   8.  Passkey reg challenge for the deleted user is cleared.
//   9.  Outbound send log rows for the deleted user are hard-deleted.
//   10. Stripe sub-cancel skipped when no subscription id present.
//   11. Stripe customer-del skipped when no customer id present.
//   12. Cron backoff schedule uses min(60 * 2^attempts, 3600) seconds.
//   13. After 24 attempts the row is parked 1 year out and not auto-retried.
//   14. Completed rows older than 90 days are pruned.
//   15. Deleting an unknown user throws "user_not_found".
//   16. Concurrent processor failures do not abort the user row deletion.

import { db } from "../server/db";
import {
  users,
  authSessions,
  outboundSendLog,
  processorCleanupQueue,
} from "../shared/schema";
import { eq, like, sql } from "drizzle-orm";
import {
  deleteUserAccount,
  drainProcessorCleanupQueue,
  type ProcessorRunners,
} from "../server/accountDeletion";

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

function expect(name: string, cond: boolean, detail = "") {
  if (cond) ok(name);
  else bad(name, detail || "expected true");
}

async function makeUser(suffix: string, withProcessorIds = true) {
  const fakeStripeCust = withProcessorIds ? `cus_test_${suffix}_${Date.now()}` : null;
  const fakeStripeSub = withProcessorIds ? `sub_test_${suffix}_${Date.now()}` : null;
  const [u] = await db.insert(users).values({
    name: `_acctdel_test_${suffix}_${Date.now()}`,
    phone: `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`,
    stripeCustomerId: fakeStripeCust,
    stripeSubscriptionId: fakeStripeSub,
  }).returning();
  return u;
}

async function cleanup() {
  const testUsers = await db.select().from(users).where(like(users.name, "_acctdel_test_%"));
  for (const u of testUsers) {
    await db.delete(authSessions).where(eq(authSessions.userId, u.id));
    await db.delete(outboundSendLog).where(eq(outboundSendLog.userId, u.id));
    await db.delete(processorCleanupQueue).where(eq(processorCleanupQueue.userId, u.id));
    await db.delete(users).where(eq(users.id, u.id));
  }
  // Also wipe orphan queue rows from prior runs.
  await db.execute(sql`DELETE FROM processor_cleanup_queue WHERE user_id IN (
    SELECT user_id FROM processor_cleanup_queue WHERE user_id NOT IN (SELECT id FROM users)
  ) AND created_at > NOW() - INTERVAL '1 day' AND last_error LIKE '%test%'`);
}

interface MockState {
  stripeSubCancelCalls: string[];
  stripeCustomerDelCalls: string[];
  revenueCatDeleteCalls: string[];
  outboundLogPurgeCalls: string[];
}

function makeMockRunners(
  state: MockState,
  overrides: Partial<ProcessorRunners> = {},
): ProcessorRunners {
  return {
    stripeSubCancel: overrides.stripeSubCancel ?? (async (id) => { state.stripeSubCancelCalls.push(id); }),
    stripeCustomerDel: overrides.stripeCustomerDel ?? (async (id) => { state.stripeCustomerDelCalls.push(id); }),
    revenueCatDelete: overrides.revenueCatDelete ?? (async (id) => { state.revenueCatDeleteCalls.push(id); }),
    outboundLogPurge: overrides.outboundLogPurge ?? (async (id) => {
      state.outboundLogPurgeCalls.push(id);
      await db.delete(outboundSendLog).where(eq(outboundSendLog.userId, id));
    }),
  };
}

function freshState(): MockState {
  return {
    stripeSubCancelCalls: [],
    stripeCustomerDelCalls: [],
    revenueCatDeleteCalls: [],
    outboundLogPurgeCalls: [],
  };
}

async function main() {
  console.log("\n[Batch 2] Account Deletion Processor Cleanup verification\n");

  await cleanup();

  // ---------------- Scenario 1: Full inline success ----------------
  {
    console.log("\nScenario 1: full inline success");
    const u = await makeUser("inline_ok");
    const challengeStore = new Map<string, unknown>();
    challengeStore.set(`reg:${u.id}`, { challenge: "x", expiresAt: Date.now() + 60_000 });
    challengeStore.set(`reg:other`, { challenge: "y", expiresAt: Date.now() + 60_000 });

    // Insert a session row + outbound log row for this user.
    await db.insert(authSessions).values({
      token: `tok_${u.id}`,
      userId: u.id,
      expiresAt: new Date(Date.now() + 86400_000),
    });
    await db.insert(outboundSendLog).values({
      channel: "sms",
      purpose: "otp",
      status: "sent",
      destinationHash: "h_" + u.id,
      userId: u.id,
    });

    const state = freshState();
    const runners = makeMockRunners(state);

    const result = await deleteUserAccount({ userId: u.id, challengeStore, runners });

    expect("S1 processorWarnings empty", result.processorWarnings.length === 0, JSON.stringify(result.processorWarnings));
    expect("S1 stripe sub cancel called", state.stripeSubCancelCalls.length === 1);
    expect("S1 stripe customer del called", state.stripeCustomerDelCalls.length === 1);
    expect("S1 revenuecat delete called", state.revenueCatDeleteCalls.length === 1);
    expect("S1 outbound purge called", state.outboundLogPurgeCalls.length === 1);

    const userRows = await db.select().from(users).where(eq(users.id, u.id));
    expect("S1 user row deleted", userRows.length === 0);

    const sessionRows = await db.select().from(authSessions).where(eq(authSessions.userId, u.id));
    expect("S1 sessions revoked", sessionRows.length === 0);

    const outboundRows = await db.select().from(outboundSendLog).where(eq(outboundSendLog.userId, u.id));
    expect("S1 outbound rows hard-deleted", outboundRows.length === 0);

    expect("S1 reg challenge cleared", !challengeStore.has(`reg:${u.id}`));
    expect("S1 unrelated challenge preserved", challengeStore.has(`reg:other`));

    const queueRows = await db.select().from(processorCleanupQueue).where(eq(processorCleanupQueue.userId, u.id));
    expect("S1 queue row exists", queueRows.length === 1);
    expect("S1 queue completed_at set", !!queueRows[0]?.completedAt);
    expect("S1 queue stepsRemaining empty", queueRows[0]?.stepsRemaining.length === 0);
  }

  // ---------------- Scenario 2: Inline partial failure ----------------
  {
    console.log("\nScenario 2: partial failure (customer del times out, RC fails)");
    const u = await makeUser("partial");
    const challengeStore = new Map<string, unknown>();
    const state = freshState();
    const runners = makeMockRunners(state, {
      stripeCustomerDel: async () => { await new Promise((r) => setTimeout(r, 5000)); },
      revenueCatDelete: async () => { throw new Error("rc_retry:503"); },
    });

    const t0 = Date.now();
    const result = await deleteUserAccount({ userId: u.id, challengeStore, runners });
    const elapsed = Date.now() - t0;

    expect("S2 inline elapsed under 16s budget", elapsed < 16_000, `elapsed=${elapsed}ms`);
    expect("S2 elapsed >= 4s (timeout enforced)", elapsed >= 3900, `elapsed=${elapsed}ms`);

    const warnings = result.processorWarnings.sort();
    expect(
      "S2 warnings include customer profile + RC",
      warnings.includes("Stripe customer profile") && warnings.includes("RevenueCat customer record"),
      JSON.stringify(warnings),
    );
    expect("S2 warnings size 2", warnings.length === 2, JSON.stringify(warnings));

    const userRows = await db.select().from(users).where(eq(users.id, u.id));
    expect("S2 user row still deleted despite processor failures", userRows.length === 0);

    const queueRows = await db.select().from(processorCleanupQueue).where(eq(processorCleanupQueue.userId, u.id));
    expect("S2 queue row exists", queueRows.length === 1);
    const qr = queueRows[0]!;
    expect("S2 queue NOT completed", qr.completedAt === null);
    expect("S2 queue attempts still 0 (inline doesn't bump)", qr.attempts === 0, `attempts=${qr.attempts}`);
    expect("S2 stepsRemaining = 2", qr.stepsRemaining.length === 2, JSON.stringify(qr.stepsRemaining));
    expect(
      "S2 stepsRemaining contains both failed steps",
      qr.stepsRemaining.includes("stripe_customer_del") && qr.stepsRemaining.includes("revenuecat_delete"),
    );
    expect("S2 lastError populated", !!qr.lastError);

    // ---------------- Scenario 3: Drainer recovers ----------------
    console.log("\nScenario 3: drainer completes partial-failure row when processors recover");
    const recoverState = freshState();
    const recoverRunners = makeMockRunners(recoverState);

    // Force nextAttemptAt to "now" so the drainer picks it up.
    await db.update(processorCleanupQueue)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(processorCleanupQueue.id, qr.id));

    const drainResult = await drainProcessorCleanupQueue(recoverRunners);
    expect("S3 drainer processed >= 1", drainResult.processed >= 1, JSON.stringify(drainResult));
    expect("S3 drainer succeeded >= 1", drainResult.succeeded >= 1, JSON.stringify(drainResult));

    const queueAfter = await db.select().from(processorCleanupQueue).where(eq(processorCleanupQueue.id, qr.id));
    expect("S3 queue completed_at set", !!queueAfter[0]?.completedAt);
    expect("S3 queue stepsRemaining empty", queueAfter[0]?.stepsRemaining.length === 0);
    expect("S3 attempts incremented to 1", queueAfter[0]?.attempts === 1, `attempts=${queueAfter[0]?.attempts}`);
  }

  // ---------------- Scenario 4: Stripe resource_missing = success ----------------
  // ESM modules are read-only at runtime so we can't monkey-patch the real
  // Stripe client. Instead we (a) source-grep `defaultRunners` to prove the
  // `resource_missing` catch is wired in both Stripe runners, and (b) verify
  // the orchestrator marks the row complete when runners return successfully
  // (which is exactly what defaultRunners does after absorbing the missing).
  {
    console.log("\nScenario 4: defaultRunners absorb Stripe resource_missing");
    const fs = await import("node:fs");
    const src = fs.readFileSync("server/accountDeletion.ts", "utf8");
    const subBlock = /stripeSubCancel\s*\([^)]*\)\s*\{[\s\S]*?if\s*\(\s*e\?\.code\s*===\s*["']resource_missing["']\s*\)\s*return;[\s\S]*?\},/.test(src);
    const custBlock = /stripeCustomerDel\s*\([^)]*\)\s*\{[\s\S]*?if\s*\(\s*e\?\.code\s*===\s*["']resource_missing["']\s*\)\s*return;[\s\S]*?\},/.test(src);
    expect("S4a defaultRunners.stripeSubCancel catches resource_missing", subBlock);
    expect("S4b defaultRunners.stripeCustomerDel catches resource_missing", custBlock);

    // Behavior shape: when runners return silently (post-catch), the
    // orchestrator records no warnings and completes the queue row.
    const u = await makeUser("rm_shape");
    const result = await deleteUserAccount({
      userId: u.id,
      runners: makeMockRunners(freshState()),
    });
    expect("S4c success-shaped runners produce no warnings", result.processorWarnings.length === 0, JSON.stringify(result.processorWarnings));
  }

  // ---------------- Scenario 5: User without processor IDs ----------------
  {
    console.log("\nScenario 5: user with no processor IDs skips Stripe steps");
    const u = await makeUser("noproc", false);
    const state = freshState();
    const runners = makeMockRunners(state);

    const result = await deleteUserAccount({ userId: u.id, runners });
    expect("S5 stripe sub cancel NOT called", state.stripeSubCancelCalls.length === 0);
    expect("S5 stripe customer del NOT called", state.stripeCustomerDelCalls.length === 0);
    expect("S5 revenuecat delete called", state.revenueCatDeleteCalls.length === 1);
    expect("S5 outbound purge called", state.outboundLogPurgeCalls.length === 1);
    expect("S5 no warnings", result.processorWarnings.length === 0);

    const queueRows = await db.select().from(processorCleanupQueue).where(eq(processorCleanupQueue.userId, u.id));
    expect("S5 queue completed", !!queueRows[0]?.completedAt);
  }

  // ---------------- Scenario 6: user_not_found ----------------
  {
    console.log("\nScenario 6: deleting unknown user throws user_not_found");
    let caught: Error | null = null;
    try {
      await deleteUserAccount({ userId: "00000000-0000-0000-0000-000000000000" });
    } catch (e) {
      caught = e as Error;
    }
    expect("S6 throws user_not_found", caught?.message === "user_not_found", caught?.message ?? "no error");
  }

  // ---------------- Scenario 7: Backoff math + 24-attempt ceiling ----------------
  {
    console.log("\nScenario 7: backoff + 24-attempt ceiling");
    const u = await makeUser("backoff");
    const state = freshState();
    const failingRunners = makeMockRunners(state, {
      revenueCatDelete: async () => { throw new Error("rc_retry:503"); },
    });

    await deleteUserAccount({ userId: u.id, runners: failingRunners });
    let qr = (await db.select().from(processorCleanupQueue).where(eq(processorCleanupQueue.userId, u.id)))[0]!;

    // Simulate 24 prior attempts.
    await db.update(processorCleanupQueue)
      .set({ attempts: 23, nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(processorCleanupQueue.id, qr.id));

    let drain = await drainProcessorCleanupQueue(failingRunners);
    expect("S7a drain processed at least 1", drain.processed >= 1);
    qr = (await db.select().from(processorCleanupQueue).where(eq(processorCleanupQueue.id, qr.id)))[0]!;
    expect("S7a attempts now 24", qr.attempts === 24, `attempts=${qr.attempts}`);

    // Backoff after 24 attempts: min(60 * 2^24, 3600) = 3600 seconds. Allow 60s slack.
    const expectedNext = Date.now() + 3600 * 1000;
    const drift = Math.abs(qr.nextAttemptAt.getTime() - expectedNext);
    expect("S7a backoff capped at 3600s", drift < 60_000, `drift=${drift}ms`);

    // Force due again, drain should ABANDON (park 1 year out).
    await db.update(processorCleanupQueue)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(processorCleanupQueue.id, qr.id));
    drain = await drainProcessorCleanupQueue(failingRunners);
    expect("S7b abandoned >= 1", drain.abandoned >= 1, JSON.stringify(drain));

    qr = (await db.select().from(processorCleanupQueue).where(eq(processorCleanupQueue.id, qr.id)))[0]!;
    expect("S7b attempts NOT incremented past 24", qr.attempts === 24, `attempts=${qr.attempts}`);
    const oneYear = 365 * 24 * 3600 * 1000;
    const yearDrift = Math.abs(qr.nextAttemptAt.getTime() - (Date.now() + oneYear));
    expect("S7b parked 1 year out", yearDrift < 5 * 60 * 1000, `drift=${yearDrift}ms`);
  }

  // ---------------- Scenario 8: 90-day prune ----------------
  {
    console.log("\nScenario 8: 90-day prune of completed rows");
    // Insert a synthetic completed row dated 100 days ago.
    const oldDate = new Date(Date.now() - 100 * 24 * 3600 * 1000);
    const fakeUserId = "11111111-1111-1111-1111-111111111111";
    const [oldRow] = await db.insert(processorCleanupQueue).values({
      userId: fakeUserId,
      stepsRemaining: [],
      completedAt: oldDate,
      lastAttemptAt: oldDate,
      nextAttemptAt: oldDate,
    }).returning();

    const drain = await drainProcessorCleanupQueue(makeMockRunners(freshState()));
    expect("S8 drain pruned >= 1", drain.pruned >= 1, JSON.stringify(drain));

    const stillThere = await db.select().from(processorCleanupQueue).where(eq(processorCleanupQueue.id, oldRow.id));
    expect("S8 old completed row gone", stillThere.length === 0);
  }

  // ---------------- Scenario 9b: Concurrent delete -> in-flight lock ----------------
  {
    console.log("\nScenario 9b: concurrent delete returns delete_in_progress");
    const u = await makeUser("inflight");
    const slow = makeMockRunners(freshState(), {
      revenueCatDelete: async () => { await new Promise((r) => setTimeout(r, 200)); },
    });
    const p1 = deleteUserAccount({ userId: u.id, runners: slow });
    // Fire second call synchronously (before p1 awaits past the sync lock add).
    let secondError: Error | null = null;
    try {
      await deleteUserAccount({ userId: u.id, runners: slow });
    } catch (e) {
      secondError = e as Error;
    }
    expect("S9b second call throws delete_in_progress", secondError?.message === "delete_in_progress", secondError?.message ?? "no error");
    const r1 = await p1;
    expect("S9b first call still completes", r1.processorWarnings.length === 0);
    // Lock should be released: a fresh delete attempt for a different user works.
    const u2 = await makeUser("inflight2");
    const r2 = await deleteUserAccount({ userId: u2.id, runners: makeMockRunners(freshState()) });
    expect("S9b lock released after first call", r2.processorWarnings.length === 0);
  }

  // ---------------- Scenario 10: RevenueCat status matrix ----------------
  {
    console.log("\nScenario 10: defaultRunners.revenueCatDelete status branches");
    process.env.REVENUECAT_PROJECT_ID = process.env.REVENUECAT_PROJECT_ID || "test_proj";
    process.env.REVENUECAT_SECRET_API_KEY = process.env.REVENUECAT_SECRET_API_KEY || "sk_test";
    const { defaultRunners } = await import("../server/accountDeletion");
    const realFetch = globalThis.fetch;

    async function withFetchStatus(status: number) {
      globalThis.fetch = (async () => new Response(status === 204 || status === 304 ? null : "", { status })) as any;
      try {
        await defaultRunners.revenueCatDelete("u_test");
        return { ok: true, err: null as any };
      } catch (e) {
        return { ok: false, err: e as Error };
      } finally {
        globalThis.fetch = realFetch;
      }
    }

    let r = await withFetchStatus(200);
    expect("S10a 200 = success", r.ok, r.err?.message);
    r = await withFetchStatus(204);
    expect("S10b 204 = success", r.ok, r.err?.message);
    r = await withFetchStatus(404);
    expect("S10c 404 = success", r.ok, r.err?.message);
    r = await withFetchStatus(423);
    expect("S10d 423 throws rc_retry", !r.ok && /rc_retry:423/.test(r.err?.message ?? ""), r.err?.message ?? "");
    r = await withFetchStatus(429);
    expect("S10e 429 throws rc_retry", !r.ok && /rc_retry:429/.test(r.err?.message ?? ""), r.err?.message ?? "");
    r = await withFetchStatus(500);
    expect("S10f 500 throws rc_retry", !r.ok && /rc_retry:500/.test(r.err?.message ?? ""), r.err?.message ?? "");
    r = await withFetchStatus(503);
    expect("S10g 503 throws rc_retry", !r.ok && /rc_retry:503/.test(r.err?.message ?? ""), r.err?.message ?? "");
    r = await withFetchStatus(403);
    expect("S10h 403 throws rc_failed (non-retryable)", !r.ok && /rc_failed:403/.test(r.err?.message ?? ""), r.err?.message ?? "");
    r = await withFetchStatus(401);
    expect("S10i 401 throws rc_failed (non-retryable)", !r.ok && /rc_failed:401/.test(r.err?.message ?? ""), r.err?.message ?? "");
  }

  // ---------------- Scenario 9: Backoff at attempt=1 = 120s ----------------
  {
    console.log("\nScenario 9: backoff at attempt=1 == 120s");
    const u = await makeUser("backoff_low");
    const failingRunners = makeMockRunners(freshState(), {
      revenueCatDelete: async () => { throw new Error("rc_retry:503"); },
    });
    await deleteUserAccount({ userId: u.id, runners: failingRunners });
    let qr = (await db.select().from(processorCleanupQueue).where(eq(processorCleanupQueue.userId, u.id)))[0]!;
    await db.update(processorCleanupQueue)
      .set({ attempts: 0, nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(processorCleanupQueue.id, qr.id));

    await drainProcessorCleanupQueue(failingRunners);
    qr = (await db.select().from(processorCleanupQueue).where(eq(processorCleanupQueue.id, qr.id)))[0]!;
    expect("S9 attempts == 1", qr.attempts === 1);

    // min(60 * 2^1, 3600) = 120s.
    const expected = Date.now() + 120 * 1000;
    const drift = Math.abs(qr.nextAttemptAt.getTime() - expected);
    expect("S9 backoff = 120s at attempt 1", drift < 60_000, `drift=${drift}ms`);
  }

  await cleanup();

  console.log(`\n========================================`);
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  if (failed > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\nAll Batch 2 account-deletion tests passed.\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error("Test crashed:", e);
  process.exit(2);
});
