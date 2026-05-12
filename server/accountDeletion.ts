// Batch 2: Account Deletion Processor Cleanup.
//
// Inline-then-cron hybrid. When a user taps "Delete account" we:
//   1. Snapshot processor IDs (Stripe customer/sub).
//   2. Insert a processor_cleanup_queue row holding the steps to retry. If
//      that insert fails we abort and return 500 -- we never want to delete
//      the user row without a way to retry processor cleanup.
//   3. Run each processor step inline with a 4-second timeout. Successful
//      steps are removed from steps_remaining; failed/timed-out steps stay.
//   4. Revoke all sessions, clear the in-memory passkey reg challenge,
//      delete the user row (FK cascades drop dependent app data).
//   5. Return success with `processorWarnings: string[]` for any steps the
//      cron drainer still has to finish.
//
// The cron drainer runs from /api/cron/tick (every ~2 min). It picks up to
// 25 due rows, retries each remaining step (4s timeout), advances attempts,
// applies exponential backoff `min(60 * 2^attempts, 3600)` seconds, stops
// auto-retrying after 24 attempts (logs `[CLEANUP] manual-intervention-needed`),
// and prunes completed rows older than 90 days.
//
// All processor-side runners are injectable so tests can swap in mocks
// without touching real Stripe/RevenueCat traffic.

import { db } from "./db";
import {
  users,
  authSessions,
  outboundSendLog,
  processorCleanupQueue,
} from "@shared/schema";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { getUncachableStripeClient } from "./stripeClient";

export type CleanupStep =
  | "stripe_sub_cancel"
  | "stripe_customer_del"
  | "revenuecat_delete"
  | "outbound_log_purge";

const STEP_NAMES: Record<CleanupStep, string> = {
  stripe_sub_cancel: "Stripe subscription",
  stripe_customer_del: "Stripe customer profile",
  revenuecat_delete: "RevenueCat customer record",
  outbound_log_purge: "Outbound message log",
};

const STEP_TIMEOUT_MS = 4_000;
const MAX_ATTEMPTS = 24;
const COMPLETED_PRUNE_DAYS = 90;

export interface ProcessorRunners {
  stripeSubCancel: (subId: string) => Promise<void>;
  stripeCustomerDel: (custId: string) => Promise<void>;
  revenueCatDelete: (userId: string) => Promise<void>;
  outboundLogPurge: (userId: string) => Promise<void>;
}

export const defaultRunners: ProcessorRunners = {
  async stripeSubCancel(subId: string) {
    const stripe = await getUncachableStripeClient();
    try {
      await stripe.subscriptions.cancel(subId);
    } catch (e: any) {
      if (e?.code === "resource_missing") return;
      throw e;
    }
  },
  async stripeCustomerDel(custId: string) {
    const stripe = await getUncachableStripeClient();
    try {
      await stripe.customers.del(custId);
    } catch (e: any) {
      if (e?.code === "resource_missing") return;
      throw e;
    }
  },
  async revenueCatDelete(userId: string) {
    const projectId = process.env.REVENUECAT_PROJECT_ID;
    const secret = process.env.REVENUECAT_SECRET_API_KEY;
    if (!projectId || !secret) {
      throw new Error("RevenueCat not configured");
    }
    const url = `https://api.revenuecat.com/v2/projects/${encodeURIComponent(projectId)}/customers/${encodeURIComponent(userId)}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${secret}`,
        Accept: "application/json",
      },
    });
    if (res.status === 200 || res.status === 202 || res.status === 204 || res.status === 404) return;
    if (res.status === 423 || res.status === 429 || res.status >= 500) {
      throw new Error(`rc_retry:${res.status}`);
    }
    throw new Error(`rc_failed:${res.status}`);
  },
  async outboundLogPurge(userId: string) {
    await db.delete(outboundSendLog).where(eq(outboundSendLog.userId, userId));
  },
};

// Per-user in-flight lock. Set SYNCHRONOUSLY at the top of deleteUserAccount
// before any await yields, so two concurrent "delete account" requests from
// the same user (double-tap, multi-tab) cannot both create queue rows and
// fire processor calls in parallel. The second caller gets `delete_in_progress`.
const deletionInFlight = new Set<string>();

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

interface StepContext {
  userId: string;
  stripeCustId: string | null;
  stripeSubId: string | null;
}

async function runStep(
  step: CleanupStep,
  ctx: StepContext,
  runners: ProcessorRunners,
): Promise<void> {
  switch (step) {
    case "stripe_sub_cancel":
      if (!ctx.stripeSubId) return;
      await runners.stripeSubCancel(ctx.stripeSubId);
      return;
    case "stripe_customer_del":
      if (!ctx.stripeCustId) return;
      await runners.stripeCustomerDel(ctx.stripeCustId);
      return;
    case "revenuecat_delete":
      await runners.revenueCatDelete(ctx.userId);
      return;
    case "outbound_log_purge":
      await runners.outboundLogPurge(ctx.userId);
      return;
  }
}

export interface DeleteUserAccountResult {
  processorWarnings: string[];
  queueRowId: string;
  remainingSteps: CleanupStep[];
}

export interface DeleteUserAccountOpts {
  userId: string;
  challengeStore?: Map<string, unknown>;
  runners?: ProcessorRunners;
}

/**
 * Delete a user account end-to-end.
 *
 * Throws `Error("queue_insert_failed")` if the processor_cleanup_queue insert
 * fails -- caller should surface a 500. Throws `Error("user_not_found")` if
 * the user row is missing -- caller should surface a 404. Otherwise resolves
 * with the warnings for the client.
 */
export async function deleteUserAccount(
  opts: DeleteUserAccountOpts,
): Promise<DeleteUserAccountResult> {
  const { userId } = opts;
  const runners = opts.runners ?? defaultRunners;
  const challengeStore = opts.challengeStore;

  // SYNCHRONOUS in-flight check. Must happen before any await so concurrent
  // requests from the same user can never both pass.
  if (deletionInFlight.has(userId)) {
    throw new Error("delete_in_progress");
  }
  deletionInFlight.add(userId);

  try {
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (!u) throw new Error("user_not_found");

    const stripeSubId = u.stripeSubscriptionId ?? null;
    const stripeCustId = u.stripeCustomerId ?? null;

    const initialSteps: CleanupStep[] = [];
    if (stripeSubId) initialSteps.push("stripe_sub_cancel");
    if (stripeCustId) initialSteps.push("stripe_customer_del");
    // Always attempt RC cleanup. Cheap when no record exists (returns 404 = ok).
    initialSteps.push("revenuecat_delete");
    initialSteps.push("outbound_log_purge");

    // Step 2: queue insert. Abort the whole operation on failure.
    let queueRowId: string;
    try {
      const [row] = await db
        .insert(processorCleanupQueue)
        .values({
          userId,
          stripeCustomerId: stripeCustId,
          stripeSubscriptionId: stripeSubId,
          stepsRemaining: initialSteps,
          nextAttemptAt: new Date(),
        })
        .returning();
      queueRowId = row.id;
    } catch (e) {
      console.error(`[CLEANUP] queue insert failed for user ***${userId.slice(-4)}: ${(e as Error).message}`);
      throw new Error("queue_insert_failed");
    }

    // Step 3: inline cleanup with per-step timeout. External calls, NOT in tx.
    const ctx: StepContext = { userId, stripeCustId, stripeSubId };
    let remaining: CleanupStep[] = [...initialSteps];
    let lastError: string | null = null;

    for (const step of initialSteps) {
      try {
        await withTimeout(runStep(step, ctx, runners), STEP_TIMEOUT_MS, step);
        remaining = remaining.filter((s) => s !== step);
      } catch (e) {
        const msg = (e as Error).message.slice(0, 500);
        lastError = `${step}: ${msg}`;
        console.warn(`[CLEANUP] inline step ${step} failed for user ***${userId.slice(-4)}: ${msg}`);
      }
    }

    // Step 4-7 atomic: queue progress, session revocation, user delete all
    // happen in ONE transaction. If any one fails the user row is preserved
    // and the queue row keeps all steps as remaining; the user can retry
    // deletion. Processor calls already made are idempotent (resource_missing
    // / 404 are absorbed) so no compensation needed.
    await db.transaction(async (tx) => {
      if (remaining.length === 0) {
        await tx
          .update(processorCleanupQueue)
          .set({
            stepsRemaining: [],
            completedAt: new Date(),
            lastAttemptAt: new Date(),
            lastError: null,
          })
          .where(eq(processorCleanupQueue.id, queueRowId));
      } else {
        await tx
          .update(processorCleanupQueue)
          .set({
            stepsRemaining: remaining,
            lastAttemptAt: new Date(),
            lastError,
            nextAttemptAt: new Date(Date.now() + 60_000),
          })
          .where(eq(processorCleanupQueue.id, queueRowId));
      }

      // Revoke ALL sessions for this user (every device).
      await tx.delete(authSessions).where(eq(authSessions.userId, userId));

      // Delete user row. FK cascades drop dependent app data
      // (passkeys, contacts, checkins, settings, location_pings, geofences,
      // conversations, messages, etc).
      await tx.delete(users).where(eq(users.id, userId));
    });

    // Step 6 (post-tx, in-memory): clear deterministic passkey registration
    // challenge. Auth challenges (`auth:${txnId}`) are random tx ids not
    // linked to userId, so we rely on the 60-second sweeper for those.
    if (challengeStore) {
      challengeStore.delete(`reg:${userId}`);
    }

    // Step 8: build human-readable warnings for the client.
    const processorWarnings = remaining.map((s) => STEP_NAMES[s]);

    console.log(
      `[CLEANUP] account deleted user=***${userId.slice(-4)} ` +
        `inline_done=${initialSteps.length - remaining.length}/${initialSteps.length} ` +
        `warnings=[${processorWarnings.join(",")}]`,
    );

    return { processorWarnings, queueRowId, remainingSteps: remaining };
  } finally {
    deletionInFlight.delete(userId);
  }
}

export interface DrainResult {
  processed: number;
  succeeded: number;
  stillFailing: number;
  abandoned: number;
  pruned: number;
}

/**
 * Cron drainer. Called from /api/cron/tick. Idempotent. Bounded work per call.
 */
export async function drainProcessorCleanupQueue(
  runnersOverride?: ProcessorRunners,
): Promise<DrainResult> {
  const runners = runnersOverride ?? defaultRunners;
  const now = new Date();

  // 1. Prune completed rows older than 90 days.
  const cutoff = new Date(now.getTime() - COMPLETED_PRUNE_DAYS * 24 * 3600 * 1000);
  const pruned = await db
    .delete(processorCleanupQueue)
    .where(
      and(
        sql`${processorCleanupQueue.completedAt} IS NOT NULL`,
        lte(processorCleanupQueue.completedAt, cutoff),
      ),
    )
    .returning({ id: processorCleanupQueue.id });

  // 2. Pick up to 25 due rows.
  const due = await db
    .select()
    .from(processorCleanupQueue)
    .where(
      and(
        isNull(processorCleanupQueue.completedAt),
        lte(processorCleanupQueue.nextAttemptAt, now),
      ),
    )
    .limit(25);

  let succeeded = 0;
  let stillFailing = 0;
  let abandoned = 0;

  for (const row of due) {
    if (row.attempts >= MAX_ATTEMPTS) {
      console.error(
        `[CLEANUP] manual-intervention-needed user=***${row.userId.slice(-4)} ` +
          `steps=[${row.stepsRemaining.join(",")}] last_error=${row.lastError ?? "n/a"}`,
      );
      // Park the row 1 year out so it stops appearing in due queries but
      // is still inspectable (not pruned, not completed).
      await db
        .update(processorCleanupQueue)
        .set({ nextAttemptAt: new Date(now.getTime() + 365 * 24 * 3600 * 1000) })
        .where(eq(processorCleanupQueue.id, row.id));
      abandoned++;
      continue;
    }

    const ctx: StepContext = {
      userId: row.userId,
      stripeCustId: row.stripeCustomerId,
      stripeSubId: row.stripeSubscriptionId,
    };
    let remaining = [...row.stepsRemaining] as CleanupStep[];
    let lastError: string | null = null;

    for (const step of row.stepsRemaining as CleanupStep[]) {
      try {
        await withTimeout(runStep(step, ctx, runners), STEP_TIMEOUT_MS, step);
        remaining = remaining.filter((s) => s !== step);
      } catch (e) {
        lastError = `${step}: ${(e as Error).message}`.slice(0, 500);
      }
    }

    const newAttempts = row.attempts + 1;
    if (remaining.length === 0) {
      succeeded++;
      await db
        .update(processorCleanupQueue)
        .set({
          stepsRemaining: [],
          completedAt: new Date(),
          lastAttemptAt: new Date(),
          attempts: newAttempts,
          lastError: null,
        })
        .where(eq(processorCleanupQueue.id, row.id));
    } else {
      stillFailing++;
      const backoffSec = Math.min(60 * Math.pow(2, newAttempts), 3600);
      await db
        .update(processorCleanupQueue)
        .set({
          stepsRemaining: remaining,
          lastAttemptAt: new Date(),
          attempts: newAttempts,
          lastError,
          nextAttemptAt: new Date(Date.now() + backoffSec * 1000),
        })
        .where(eq(processorCleanupQueue.id, row.id));
    }
  }

  return {
    processed: due.length,
    succeeded,
    stillFailing,
    abandoned,
    pruned: pruned.length,
  };
}
