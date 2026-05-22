import webpush from "web-push";
import { db } from "./db";
import { pushSubscriptions } from "@shared/schema";
import { eq } from "drizzle-orm";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:support@stillhere.health";
const IOS_BUNDLE_ID = "com.daudabangoura.stillhere.safety";

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

  // Phase 1.1: dedupe-loop protection for push as well. We don't gate on
  // the full enforceSendPolicy (push is non-billable + incident-driven), but
  // when a dedupeKey is supplied we collapse repeated identical sends in the
  // 5-min window so a worker loop can't spam the same notification.
  if (options.dedupeKey) {
    try {
      const dec = await policy.enforceSendPolicy(auditCtx);
      if (dec.degraded && options.incidentId) {
        const { storage } = await import("./storage");
        await storage.updateIncident(options.incidentId, { degradedDelivery: true });
      }
      if (!dec.allowed && dec.reason === "duplicate") {
        console.log(`[PUSH] Deduped (loop) user=${userId} key=${options.dedupeKey}`);
        return { sent: 0, failed: 0 };
      }
      // For non-duplicate "not allowed" results (e.g. channel cap), keep the
      // legacy log-only behavior — push has no billable cost and the
      // incident already has degradedDelivery flagged above when relevant.
    } catch (e: any) {
      console.warn(`[PUSH] policy check failed, sending anyway: ${e?.message || e}`);
    }
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
    if (sub.endpoint.startsWith("apns://")) {
      const token = sub.endpoint.slice("apns://".length);
      try {
        const result = await sendAPNsAlertPush(token, payload);
        if (result.ok) {
          sent++;
        } else {
          if (result.removeSubscription) {
            await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
            console.log(`[PUSH] Removed expired APNs token ${sub.id}`);
          }
          console.error(`[PUSH] Failed to send APNs push ${sub.id}: ${result.errorMessage}`);
          failed++;
        }
      } catch (error: any) {
        console.error(`[PUSH] APNs push failed ${sub.id}:`, error?.message || error);
        failed++;
      }
      continue;
    }

    if (!configured) {
      console.log(`[PUSH] Web push not configured - skipping web subscription ${sub.id} for user ${userId}: ${payload.title}`);
      failed++;
      continue;
    }

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

async function sendAPNsAlertPush(
  deviceToken: string,
  payload: { title: string; body: string; url?: string; tag?: string },
): Promise<{ ok: boolean; removeSubscription?: boolean; errorMessage?: string }> {
  const apnsKeyId = process.env.APNS_KEY_ID;
  const apnsTeamId = process.env.APNS_TEAM_ID;
  const apnsKey = process.env.APNS_AUTH_KEY;

  if (!apnsKeyId || !apnsTeamId || !apnsKey) {
    return { ok: false, errorMessage: "apns_not_configured" };
  }

  const jwt = await generateAPNsJWT(apnsKeyId, apnsTeamId, apnsKey);
  const host = process.env.APNS_ENV === "sandbox" || process.env.NODE_ENV !== "production"
    ? "api.sandbox.push.apple.com"
    : "api.push.apple.com";

  const response = await fetch(`https://${host}/3/device/${deviceToken}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": IOS_BUNDLE_ID,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      aps: {
        alert: {
          title: payload.title,
          body: payload.body,
        },
        sound: "default",
      },
      url: payload.url || "/",
      tag: payload.tag,
    }),
  });

  if (response.ok) return { ok: true };

  const body = await response.text().catch(() => "");
  let reason = body;
  try {
    const parsed = JSON.parse(body);
    reason = parsed?.reason || body;
  } catch {}

  const removeSubscription = response.status === 410 ||
    reason === "BadDeviceToken" ||
    reason === "Unregistered";

  return {
    ok: false,
    removeSubscription,
    errorMessage: `apns_${response.status}${reason ? `_${reason}` : ""}`,
  };
}

async function generateAPNsJWT(keyId: string, teamId: string, key: string): Promise<string> {
  const crypto = await import("crypto");
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claims = Buffer.from(JSON.stringify({ iss: teamId, iat: now })).toString("base64url");
  const unsignedToken = `${header}.${claims}`;

  const privateKey = crypto.createPrivateKey({
    key: key.includes("BEGIN") ? key : `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----`,
    format: "pem",
  });

  const signature = crypto.sign("sha256", Buffer.from(unsignedToken), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });

  return `${unsignedToken}.${signature.toString("base64url")}`;
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
