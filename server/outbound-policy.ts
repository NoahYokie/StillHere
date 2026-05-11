// Outbound communication policy & audit. Phase 1 of the SMS / alert abuse
// hardening pass. Every outbound send (SMS, voice call, push, email, in-app
// system_alert) flows through this module so we can:
//   1. Enforce per-user / per-IP / per-destination windowed rate limits for
//      Category-A "user-initiated" purposes (OTP, family invite, contact
//      test, safety drill, test broadcast, marketing).
//   2. Collapse duplicate Category-B "incident-driven" sends within a 5-min
//      window via a caller-supplied dedupeKey, and trip a circuit breaker
//      when the global per-channel hourly ceiling is exceeded.
//   3. Audit every attempt to outbound_send_log for cost, abuse, and
//      deliverability reporting.
//
// The module is intentionally fail-open for incident-driven traffic: if the
// audit table itself is down we still let the safety message through and log
// the failure to console. We are fail-CLOSED only on:
//   * OUTBOUND_LOG_SECRET missing in production (we refuse to start).
//   * Category-A user-initiated abuse limits.
//   * Category-B 5-min duplicate within the same dedupeKey.
//   * Channel circuit-breaker (global ceiling for the past hour).

import { createHmac } from "crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "./db";
import { outboundSendLog } from "@shared/schema";

export type OutboundChannel = "sms" | "email" | "push" | "voice" | "in_app";
export type OutboundPurpose =
  | "otp"
  | "family_invite"
  | "contact_test"
  | "safety_drill"
  | "test_broadcast"
  | "marketing"
  | "sos_alert"
  | "missed_checkin_alert"
  | "wellness_call"
  | "escalation_alert"
  | "all_clear"
  | "contact_responded"
  | "no_response"
  | "handling_timeout"
  | "drive_crash"
  | "geofence"
  | "reminder"
  | "presence"
  | "system_alert"
  | "drill_acknowledgement"
  | "concern"
  | "recovery";

export type OutboundStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "failed"
  | "blocked_policy"
  | "blocked_optout"
  | "provider_unconfigured";

export interface SendContext {
  channel: OutboundChannel;
  purpose: OutboundPurpose;
  destination: string;          // raw phone / email / endpoint / userId; will be hashed
  userId?: string | null;       // subject of the safety event, if known
  incidentId?: string | null;
  ipAddress?: string | null;    // raw IP from req.ip; will be hashed
  dedupeKey?: string | null;    // explicit dedupe scope for Category-B
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  retryAfterSeconds?: number;
  // True when the global channel ceiling for the past hour is exhausted.
  // Safety-critical sends are still `allowed: true` (we never deny safety),
  // but callers should also try a fallback channel and mark the incident
  // as `degradedDelivery=true` so the watcher UI shows "we tried but the
  // primary channel is congested".
  degraded?: boolean;
  // When allowed=true, callers MUST pass this id to markSendProviderResult
  // so the audit row's status/providerId/error are updated.
  attemptId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// HMAC secret bootstrap. In production we REFUSE to start without an explicit
// OUTBOUND_LOG_SECRET — silently deriving from SESSION_SECRET would let the
// session secret be unintentionally re-purposed and would make the audit log
// a privacy time-bomb. In development we derive from SESSION_SECRET (with a
// loud warning) so local devs don't have to set one more env var.
// ─────────────────────────────────────────────────────────────────────────────
function resolveOutboundLogSecret(): string {
  const explicit = process.env.OUTBOUND_LOG_SECRET;
  if (explicit && explicit.length >= 32) return explicit;

  const isProd = process.env.NODE_ENV === "production";
  if (isProd) {
    if (!explicit) {
      throw new Error(
        "[outbound-policy] OUTBOUND_LOG_SECRET is required in production. " +
        "Generate a 64-char random hex and set it as a secret. Refusing to start.",
      );
    }
    throw new Error(
      "[outbound-policy] OUTBOUND_LOG_SECRET is too short (need >=32 chars). Refusing to start.",
    );
  }

  const session = process.env.SESSION_SECRET;
  if (!session || session.length < 16) {
    throw new Error(
      "[outbound-policy] OUTBOUND_LOG_SECRET missing and SESSION_SECRET unsuitable for derivation. " +
      "Set OUTBOUND_LOG_SECRET to a 64-char random hex.",
    );
  }
  console.warn(
    "[outbound-policy] OUTBOUND_LOG_SECRET not set; deriving from SESSION_SECRET for development only. " +
    "Set OUTBOUND_LOG_SECRET explicitly before deploying.",
  );
  return createHmac("sha256", session).update("outbound-log-derive-v1").digest("hex");
}

const OUTBOUND_LOG_SECRET = resolveOutboundLogSecret();

export function hashDestination(raw: string | null | undefined): string {
  const normalized = (raw ?? "").trim().toLowerCase();
  return createHmac("sha256", OUTBOUND_LOG_SECRET).update(`d:${normalized}`).digest("hex");
}

export function hashIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return createHmac("sha256", OUTBOUND_LOG_SECRET).update(`i:${raw.trim()}`).digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// Tunables. Defaults are intentionally generous for a safety app; ops can
// tighten via env. All values are per-hour unless noted.
// ─────────────────────────────────────────────────────────────────────────────
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const GLOBAL_CEILING_PER_HOUR: Record<OutboundChannel, number> = {
  sms: envInt("MAX_OUTBOUND_SMS_PER_HOUR", 500),
  voice: envInt("MAX_OUTBOUND_CALLS_PER_HOUR", 100),
  email: envInt("MAX_OUTBOUND_EMAILS_PER_HOUR", 2000),
  push: envInt("MAX_OUTBOUND_PUSH_PER_HOUR", 5000),
  in_app: envInt("MAX_OUTBOUND_IN_APP_PER_HOUR", 5000),
};

// Category-A purposes are user-initiated and abuse-prone. They get strict
// per-user, per-IP, and per-destination windowed limits in addition to the
// global channel ceiling.
//   user/IP windows: hourly + daily
//   destination window: short minute window to stop "spam this number" loops
type CategoryALimit = {
  perUserPerHour: number;
  perUserPerDay: number;
  perIpPerHour: number;
  perIpPerDay: number;
  perDestPerWindowMs: number; // minimum gap between sends to the same destination
};

const CATEGORY_A: Partial<Record<OutboundPurpose, CategoryALimit>> = {
  otp:             { perUserPerHour: 5,  perUserPerDay: 20, perIpPerHour: 10, perIpPerDay: 40, perDestPerWindowMs: 60_000 },
  family_invite:   { perUserPerHour: 5,  perUserPerDay: 20, perIpPerHour: 10, perIpPerDay: 40, perDestPerWindowMs: 30 * 60_000 },
  contact_test:    { perUserPerHour: 10, perUserPerDay: 30, perIpPerHour: 20, perIpPerDay: 60, perDestPerWindowMs: 10 * 60_000 },
  safety_drill:    { perUserPerHour: 2,  perUserPerDay: 5,  perIpPerHour: 4,  perIpPerDay: 10, perDestPerWindowMs: 30 * 60_000 },
  test_broadcast:  { perUserPerHour: 3,  perUserPerDay: 10, perIpPerHour: 6,  perIpPerDay: 20, perDestPerWindowMs: 10 * 60_000 },
  marketing:       { perUserPerHour: 1,  perUserPerDay: 1,  perIpPerHour: 5,  perIpPerDay: 10, perDestPerWindowMs: 24 * 60 * 60_000 },
};

// Category-B (incident-driven) dedupe window. A second attempt with the
// same dedupeKey within this window is silently collapsed — first send wins.
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

function isCategoryA(purpose: OutboundPurpose): boolean {
  return CATEGORY_A[purpose] != null;
}

// Safety-critical purposes (Category-S). Per locked policy, these MUST NEVER
// be denied by the outbound policy. The policy still:
//   * writes a `queued` audit row,
//   * checks the channel circuit breaker and reports `degraded:true` so the
//     caller can fan out to a fallback channel and flip
//     incidents.degradedDelivery,
//   * skips Cat-A user/IP/dest limits entirely,
//   * skips Cat-B 5-min dedupe entirely (incident worker may legitimately
//     re-fire the same alert during a long incident).
const SAFETY_CRITICAL: ReadonlySet<OutboundPurpose> = new Set([
  "sos_alert",
  "missed_checkin_alert",
  "wellness_call",
  "escalation_alert",
  "no_response",
  "drive_crash",
  "handling_timeout",
  "all_clear",
  "contact_responded",
  "concern",
  "recovery",
  "geofence",
]);

export function isSafetyCritical(purpose: OutboundPurpose): boolean {
  return SAFETY_CRITICAL.has(purpose);
}

async function countRecent(opts: {
  channel?: OutboundChannel;
  purpose?: OutboundPurpose;
  userId?: string;
  ipHash?: string;
  destinationHash?: string;
  dedupeKey?: string;
  sinceMs: number;
  countableStatuses?: OutboundStatus[];
}): Promise<number> {
  const since = new Date(Date.now() - opts.sinceMs);
  const conditions: any[] = [gte(outboundSendLog.createdAt, since)];
  if (opts.channel) conditions.push(eq(outboundSendLog.channel, opts.channel));
  if (opts.purpose) conditions.push(eq(outboundSendLog.purpose, opts.purpose));
  if (opts.userId) conditions.push(eq(outboundSendLog.userId, opts.userId));
  if (opts.ipHash) conditions.push(eq(outboundSendLog.ipHash, opts.ipHash));
  if (opts.destinationHash) conditions.push(eq(outboundSendLog.destinationHash, opts.destinationHash));
  if (opts.dedupeKey) conditions.push(eq(outboundSendLog.dedupeKey, opts.dedupeKey));
  // Default: count anything that wasn't already blocked. For dedupe lookups
  // we want to count successful + in-flight sends so a retry within the
  // window is collapsed.
  const statuses = opts.countableStatuses ?? ["queued", "sent", "delivered"];
  if (statuses.length > 0) {
    conditions.push(sql`${outboundSendLog.status} = ANY(${statuses}::outbound_status[])`);
  }
  // NOTE: errors propagate. enforceSendPolicy() decides per-purpose whether
  // to fail-open (safety) or fail-closed (Cat-A / Cat-B abuse controls).
  const [{ value }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(outboundSendLog)
    .where(and(...conditions));
  return Number(value) || 0;
}

async function writeAttempt(row: {
  channel: OutboundChannel;
  purpose: OutboundPurpose;
  status: OutboundStatus;
  destinationHash: string;
  dedupeKey?: string | null;
  userId?: string | null;
  incidentId?: string | null;
  ipHash?: string | null;
  providerId?: string | null;
  errorMessage?: string | null;
}): Promise<string | null> {
  try {
    const [inserted] = await db.insert(outboundSendLog).values({
      channel: row.channel,
      purpose: row.purpose,
      status: row.status,
      destinationHash: row.destinationHash,
      dedupeKey: row.dedupeKey ?? null,
      userId: row.userId ?? null,
      incidentId: row.incidentId ?? null,
      ipHash: row.ipHash ?? null,
      providerId: row.providerId ?? null,
      errorMessage: row.errorMessage ? row.errorMessage.slice(0, 500) : null,
    }).returning({ id: outboundSendLog.id });
    return inserted?.id ?? null;
  } catch (err: any) {
    console.warn(`[outbound-policy] writeAttempt failed (failing open): ${err?.message || err}`);
    return null;
  }
}

// Public API ─────────────────────────────────────────────────────────────────

/**
 * Decide whether a send is allowed and, when allowed, write a `queued` audit
 * row. Callers MUST then perform the actual send and call
 * `markSendProviderResult(attemptId, ...)` to finalize the audit row.
 *
 * For incident-driven Category-B traffic we are intentionally permissive:
 *   - dedupeKey collisions in the last 5 minutes return blocked_policy (with
 *     reason=duplicate) so the caller can softly skip without raising an error.
 *   - global channel ceiling is the only other gate.
 *
 * For Category-A user-initiated traffic we layer:
 *   - per-user hourly + daily counts
 *   - per-IP hourly + daily counts (when ipAddress provided)
 *   - per-destination minimum-gap window
 *   - global channel ceiling
 */
export async function enforceSendPolicy(ctx: SendContext): Promise<PolicyDecision> {
  try {
    return await enforceSendPolicyInner(ctx);
  } catch (err: any) {
    // Policy datastore is unavailable. Per locked policy, safety-critical
    // sends MUST still go through (fail-open with degraded:true so the
    // caller flips degradedDelivery and uses fallback channels). All
    // other purposes fail CLOSED so abuse controls are not silently
    // bypassed when the audit table is down.
    const safety = isSafetyCritical(ctx.purpose);
    console.error(`[outbound-policy] enforceSendPolicy datastore error (purpose=${ctx.purpose}, safety=${safety}): ${err?.message || err}`);
    if (safety) {
      return { allowed: true, degraded: true, reason: "policy_unavailable_safety_override" };
    }
    return { allowed: false, reason: "policy_unavailable", retryAfterSeconds: 60 };
  }
}

async function enforceSendPolicyInner(ctx: SendContext): Promise<PolicyDecision> {
  const destinationHash = hashDestination(ctx.destination);
  const ipHash = hashIp(ctx.ipAddress);
  const safety = isSafetyCritical(ctx.purpose);

  // 1. Channel circuit breaker (global hourly ceiling).
  const ceiling = GLOBAL_CEILING_PER_HOUR[ctx.channel];
  let degraded = false;
  if (ceiling > 0) {
    const used = await countRecent({
      channel: ctx.channel,
      sinceMs: 60 * 60 * 1000,
      countableStatuses: ["queued", "sent", "delivered"],
    });
    if (used >= ceiling) {
      if (safety) {
        // Safety MUST NEVER be denied. Record the breach for ops dashboards
        // and tell the caller to mark degradedDelivery + fan out to fallback
        // channels, but allow the send through.
        console.warn(`[outbound-policy] channel_ceiling exceeded (safety override) channel=${ctx.channel} purpose=${ctx.purpose} used=${used}/${ceiling}`);
        degraded = true;
      } else {
        await writeAttempt({
          channel: ctx.channel, purpose: ctx.purpose, status: "blocked_policy",
          destinationHash, dedupeKey: ctx.dedupeKey, userId: ctx.userId, incidentId: ctx.incidentId,
          ipHash, errorMessage: `channel_ceiling:${ctx.channel}:${used}/${ceiling}`,
        });
        return { allowed: false, reason: "channel_circuit_broken", retryAfterSeconds: 600 };
      }
    }
  }

  // Safety bypass: skip Cat-A and Cat-B gates entirely. We still write the
  // queued audit row below so cost/abuse reporting stays accurate.
  if (safety) {
    const attemptId = await writeAttempt({
      channel: ctx.channel, purpose: ctx.purpose, status: "queued",
      destinationHash, dedupeKey: ctx.dedupeKey, userId: ctx.userId, incidentId: ctx.incidentId,
      ipHash, errorMessage: degraded ? "safety_override_circuit_breaker" : null,
    });
    return { allowed: true, degraded, attemptId: attemptId ?? undefined };
  }

  // 2. Category-B dedupe (5-min window on the same dedupeKey).
  if (!isCategoryA(ctx.purpose) && ctx.dedupeKey) {
    const dup = await countRecent({
      dedupeKey: ctx.dedupeKey,
      sinceMs: DEDUPE_WINDOW_MS,
      countableStatuses: ["queued", "sent", "delivered"],
    });
    if (dup > 0) {
      await writeAttempt({
        channel: ctx.channel, purpose: ctx.purpose, status: "blocked_policy",
        destinationHash, dedupeKey: ctx.dedupeKey, userId: ctx.userId, incidentId: ctx.incidentId,
        ipHash, errorMessage: "duplicate_dedupe_window",
      });
      return { allowed: false, reason: "duplicate", retryAfterSeconds: Math.ceil(DEDUPE_WINDOW_MS / 1000) };
    }
  }

  // 3. Category-A per-user / per-IP / per-destination limits.
  const limits = CATEGORY_A[ctx.purpose];
  if (limits) {
    if (ctx.userId) {
      const hourly = await countRecent({ purpose: ctx.purpose, userId: ctx.userId, sinceMs: 60 * 60 * 1000 });
      if (hourly >= limits.perUserPerHour) {
        await writeAttempt({
          channel: ctx.channel, purpose: ctx.purpose, status: "blocked_policy",
          destinationHash, dedupeKey: ctx.dedupeKey, userId: ctx.userId, incidentId: ctx.incidentId,
          ipHash, errorMessage: `user_hourly:${hourly}/${limits.perUserPerHour}`,
        });
        return { allowed: false, reason: "user_hourly_limit", retryAfterSeconds: 60 * 60 };
      }
      const daily = await countRecent({ purpose: ctx.purpose, userId: ctx.userId, sinceMs: 24 * 60 * 60 * 1000 });
      if (daily >= limits.perUserPerDay) {
        await writeAttempt({
          channel: ctx.channel, purpose: ctx.purpose, status: "blocked_policy",
          destinationHash, dedupeKey: ctx.dedupeKey, userId: ctx.userId, incidentId: ctx.incidentId,
          ipHash, errorMessage: `user_daily:${daily}/${limits.perUserPerDay}`,
        });
        return { allowed: false, reason: "user_daily_limit", retryAfterSeconds: 24 * 60 * 60 };
      }
    }
    if (ipHash) {
      const ipHourly = await countRecent({ purpose: ctx.purpose, ipHash, sinceMs: 60 * 60 * 1000 });
      if (ipHourly >= limits.perIpPerHour) {
        await writeAttempt({
          channel: ctx.channel, purpose: ctx.purpose, status: "blocked_policy",
          destinationHash, dedupeKey: ctx.dedupeKey, userId: ctx.userId, incidentId: ctx.incidentId,
          ipHash, errorMessage: `ip_hourly:${ipHourly}/${limits.perIpPerHour}`,
        });
        return { allowed: false, reason: "ip_hourly_limit", retryAfterSeconds: 60 * 60 };
      }
      const ipDaily = await countRecent({ purpose: ctx.purpose, ipHash, sinceMs: 24 * 60 * 60 * 1000 });
      if (ipDaily >= limits.perIpPerDay) {
        await writeAttempt({
          channel: ctx.channel, purpose: ctx.purpose, status: "blocked_policy",
          destinationHash, dedupeKey: ctx.dedupeKey, userId: ctx.userId, incidentId: ctx.incidentId,
          ipHash, errorMessage: `ip_daily:${ipDaily}/${limits.perIpPerDay}`,
        });
        return { allowed: false, reason: "ip_daily_limit", retryAfterSeconds: 24 * 60 * 60 };
      }
    }
    if (limits.perDestPerWindowMs > 0) {
      const destRecent = await countRecent({
        purpose: ctx.purpose,
        destinationHash,
        sinceMs: limits.perDestPerWindowMs,
      });
      if (destRecent > 0) {
        await writeAttempt({
          channel: ctx.channel, purpose: ctx.purpose, status: "blocked_policy",
          destinationHash, dedupeKey: ctx.dedupeKey, userId: ctx.userId, incidentId: ctx.incidentId,
          ipHash, errorMessage: `dest_window:${destRecent} in ${limits.perDestPerWindowMs}ms`,
        });
        return {
          allowed: false,
          reason: "destination_cooldown",
          retryAfterSeconds: Math.ceil(limits.perDestPerWindowMs / 1000),
        };
      }
    }
  }

  // All checks passed — write a queued row and return its id.
  const attemptId = await writeAttempt({
    channel: ctx.channel, purpose: ctx.purpose, status: "queued",
    destinationHash, dedupeKey: ctx.dedupeKey, userId: ctx.userId, incidentId: ctx.incidentId,
    ipHash,
  });
  return { allowed: true, attemptId: attemptId ?? undefined };
}

/**
 * Update the audit row for a previous enforceSendPolicy() decision once the
 * provider has accepted (or rejected) the message. No-op when attemptId is
 * missing (e.g. fail-open insert path).
 */
export async function markSendProviderResult(
  attemptId: string | undefined,
  status: OutboundStatus,
  details?: { providerId?: string | null; errorMessage?: string | null },
): Promise<void> {
  if (!attemptId) return;
  try {
    await db.update(outboundSendLog).set({
      status,
      providerId: details?.providerId ?? null,
      errorMessage: details?.errorMessage ? details.errorMessage.slice(0, 500) : null,
    }).where(eq(outboundSendLog.id, attemptId));
  } catch (err: any) {
    console.warn(`[outbound-policy] markSendProviderResult failed: ${err?.message || err}`);
  }
}

/**
 * Convenience: log a send attempt that bypassed enforceSendPolicy (e.g. an
 * in-app system_alert that is itself the fallback). Records a single row in
 * one go. Returns void; callers don't need to chain markSendProviderResult.
 */
export async function recordSendAttempt(ctx: SendContext, status: OutboundStatus, details?: {
  providerId?: string | null;
  errorMessage?: string | null;
}): Promise<void> {
  await writeAttempt({
    channel: ctx.channel,
    purpose: ctx.purpose,
    status,
    destinationHash: hashDestination(ctx.destination),
    dedupeKey: ctx.dedupeKey,
    userId: ctx.userId,
    incidentId: ctx.incidentId,
    ipHash: hashIp(ctx.ipAddress),
    providerId: details?.providerId ?? null,
    errorMessage: details?.errorMessage ?? null,
  });
}

/**
 * Quick "is this channel currently circuit-broken?" probe used by the
 * notification engine to decide whether to skip straight to a fallback
 * channel without burning a policy decision.
 */
export async function isChannelCircuitBroken(channel: OutboundChannel): Promise<boolean> {
  const ceiling = GLOBAL_CEILING_PER_HOUR[channel];
  if (ceiling <= 0) return false;
  const used = await countRecent({
    channel,
    sinceMs: 60 * 60 * 1000,
    countableStatuses: ["queued", "sent", "delivered"],
  });
  return used >= ceiling;
}
