import webpush from "web-push";
import { db } from "./db";
import { pushSubscriptions } from "@shared/schema";
import { eq } from "drizzle-orm";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:support@stillhere.health";

let configured = false;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  console.log("[PUSH] Web push configured with VAPID keys");
} else {
  console.warn("[PUSH] VAPID keys not configured - push notifications disabled. Generate with: npx web-push generate-vapid-keys");
}

export function isPushConfigured(): boolean {
  return configured;
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY;
}

export interface PushNotificationOptions {
  // Why this push is going out. Drives audit logging + circuit breaker.
  // Defaults to "system_alert" so legacy callers still record an audit row.
  purpose?: import("./outbound-policy").OutboundPurpose;
  incidentId?: string | null;
  dedupeKey?: string | null;
}

export async function sendPushNotification(
  userId: string,
  payload: { title: string; body: string; url?: string; tag?: string },
  options: PushNotificationOptions = {},
): Promise<{ sent: number; failed: number }> {
  // Best-effort audit. Push is incident-driven and non-billable, so we do
  // not gate on enforceSendPolicy; we only record the attempt + outcome so
  // the global per-channel circuit breaker has data to work with.
  const policy = await import("./outbound-policy");
  const auditCtx: import("./outbound-policy").SendContext = {
    channel: "push",
    purpose: options.purpose || "system_alert",
    destination: userId,
    userId,
    incidentId: options.incidentId ?? null,
    dedupeKey: options.dedupeKey ?? null,
  };
  const recordOutcome = async (status: import("./outbound-policy").OutboundStatus, errorMessage?: string) => {
    try { await policy.recordSendAttempt(auditCtx, status, { errorMessage }); } catch {}
  };

  if (!configured) {
    console.log(`[PUSH] Not configured - would send to user ${userId}: ${payload.title}`);
    await recordOutcome("provider_unconfigured", "vapid_missing");
    return { sent: 0, failed: 0 };
  }

  // Store-review safety net: never push to a review account, and never
  // fan out to a review account's contacts. The DB lookup is cheap and
  // fails open (real users still get pushed if the lookup throws).
  try {
    const { users } = await import("@shared/schema");
    const row = await db.select({ rev: users.isReviewAccount }).from(users).where(eq(users.id, userId)).limit(1);
    if (row[0]?.rev) {
      console.log(`[PUSH] Skipped (review account) for user ${userId}: ${payload.title}`);
      await recordOutcome("blocked_optout", "review_account");
      return { sent: 0, failed: 0 };
    }
  } catch (e: any) {
    console.warn(`[PUSH] Review-flag lookup failed for ${userId}, sending anyway:`, e?.message || e);
  }

  const subscriptions = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));

  let sent = 0;
  let failed = 0;

  if (subscriptions.length === 0) {
    await recordOutcome("failed", "no_subscriptions");
    return { sent: 0, failed: 0 };
  }

  for (const sub of subscriptions) {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth,
      },
    };

    try {
      await webpush.sendNotification(
        pushSubscription,
        JSON.stringify(payload)
      );
      sent++;
    } catch (error: any) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
        console.log(`[PUSH] Removed expired subscription ${sub.id}`);
      } else {
        console.error(`[PUSH] Failed to send to subscription ${sub.id}:`, error.message);
      }
      failed++;
    }
  }

  if (sent > 0) {
    await recordOutcome("sent", failed > 0 ? `partial_failed=${failed}` : undefined);
  } else {
    await recordOutcome("failed", `all_subscriptions_failed=${failed}`);
  }

  return { sent, failed };
}

export async function sendReminderPush(userId: string, userName: string): Promise<void> {
  await sendPushNotification(userId, {
    title: "Time to check in",
    body: `Hi ${userName}, tap here to let your family know you're OK.`,
    url: "/",
    tag: "checkin-reminder",
  });
}

export async function sendSosConfirmationPush(userId: string): Promise<void> {
  await sendPushNotification(userId, {
    title: "Help alert sent",
    body: "We attempted to reach your emergency contacts.",
    tag: "sos-confirmation",
  });
}

export async function sendIncidentPush(userId: string, userName: string, reason: "sos" | "missed_checkin"): Promise<void> {
  const title = reason === "sos" ? "Help request received" : "Missed checkin alert";
  const body = reason === "sos"
    ? `${userName} has requested help. Check the app for details.`
    : `${userName} missed their checkin. We are attempting to reach your contacts.`;

  await sendPushNotification(userId, {
    title,
    body,
    tag: "incident",
  });
}
