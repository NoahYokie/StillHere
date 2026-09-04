import webpush from "web-push";
import { db } from "./db";
import { guardianActivityReviews, messages, pushSubscriptions } from "@shared/schema";
import { and, eq } from "drizzle-orm";

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
  badgeCount?: number | null;
  priority?: "normal" | "system_info" | "safety_critical";
}

export async function computeAuthoritativeBadgeCount(userId: string): Promise<number> {
  const unreadRows = await db.select({ id: messages.id }).from(messages).where(
    and(eq(messages.receiverId, userId), eq(messages.read, false), eq(messages.messageType, "user")),
  );

  const pendingReviews = process.env.GUARDIAN_REVIEWS_ENABLED === "false"
    ? []
    : await db.select({ id: guardianActivityReviews.id }).from(guardianActivityReviews).where(
      and(
        eq(guardianActivityReviews.guardianUserId, userId),
        eq(guardianActivityReviews.status, "pending"),
        eq(guardianActivityReviews.countsTowardBadge, true),
      ),
    );

  return unreadRows.length + pendingReviews.length;
}

export function buildAPNsAlertPayload(
  payload: { title: string; body: string; url?: string; tag?: string },
  badgeCount?: number,
): Record<string, any> {
  return {
    aps: {
      alert: {
        title: payload.title,
        body: payload.body,
      },
      sound: "default",
      ...(Number.isInteger(badgeCount) ? { badge: Math.max(0, Number(badgeCount)) } : {}),
    },
    url: payload.url || "/",
    tag: payload.tag,
    badgeCount,
  };
}

export function buildAPNsBadgePayload(badgeCount: number): Record<string, any> {
  return {
    aps: {
      badge: Math.max(0, badgeCount),
      "content-available": 1,
    },
    badgeCount: Math.max(0, badgeCount),
    tag: "badge-sync",
  };
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
  const badgeCount = Number.isInteger(options.badgeCount)
    ? Math.max(0, Number(options.badgeCount))
    : await computeAuthoritativeBadgeCount(userId).catch((error: any) => {
      console.warn(`[PUSH] Badge count failed for user=${userId}: ${error?.message || error}`);
      return undefined;
    });

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
        const result = await sendAPNsAlertPush(token, payload, { badgeCount });
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
        JSON.stringify({ ...payload, badgeCount })
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
    // High-visibility warning for safety-critical zero-delivery. Surfaces
    // silent push failures before the SMS fallback fires.
    const purpose = options.purpose || "system_alert";
    const { isSafetyCritical } = await import("./outbound-policy");
    if (purpose === "system_alert" || isSafetyCritical(purpose)) {
      console.warn(JSON.stringify({
        event: "PUSH_DELIVERY_ZERO",
        userId,
        purpose,
        subscriptionCount: subscriptions.length,
        failed,
        tag: payload.tag,
      }));
    }
  }

  return { sent, failed };
}

export async function syncBadgeCount(userId: string): Promise<number> {
  const badgeCount = await computeAuthoritativeBadgeCount(userId);
  const subscriptions = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));

  const apnsSubscriptions = subscriptions.filter((sub) => sub.endpoint.startsWith("apns://"));
  for (const sub of apnsSubscriptions) {
    const token = sub.endpoint.slice("apns://".length);
    try {
      const result = await sendAPNsBadgePush(token, badgeCount);
      if (!result.ok) {
        if (result.removeSubscription) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
        }
        console.warn(`[PUSH] Badge sync failed ${sub.id}: ${result.errorMessage}`);
      }
    } catch (error: any) {
      console.warn(`[PUSH] Badge sync error ${sub.id}: ${error?.message || error}`);
    }
  }

  return badgeCount;
}

async function sendAPNsBadgePush(
  deviceToken: string,
  badgeCount: number,
): Promise<{ ok: boolean; removeSubscription?: boolean; errorMessage?: string }> {
  return sendAPNsRawPush(deviceToken, buildAPNsBadgePayload(badgeCount), {
    pushType: "background",
    priority: "5",
  });
}

async function sendAPNsAlertPush(
  deviceToken: string,
  payload: { title: string; body: string; url?: string; tag?: string },
  options: { badgeCount?: number } = {},
): Promise<{ ok: boolean; removeSubscription?: boolean; errorMessage?: string }> {
  return sendAPNsRawPush(deviceToken, buildAPNsAlertPayload(payload, options.badgeCount), {
    pushType: "alert",
    priority: "10",
  });
}

async function sendAPNsRawPush(
  deviceToken: string,
  bodyPayload: Record<string, any>,
  options: { pushType: "alert" | "background"; priority: "10" | "5" },
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

  // Apple APNs provider API is HTTP/2 only. Node's fetch/undici speaks HTTP/1.1
  // here, which fails before APNs can return a useful status. Use http2
  // directly so native iOS pushes work from Cloud Run.
  const http2 = await import("http2");
  const body = JSON.stringify(bodyPayload);

  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const client = http2.connect(`https://${host}`);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try { client.close(); } catch {}
      fn();
    };

    client.setTimeout(10_000, () => {
      finish(() => reject(new Error("apns_timeout")));
    });
    client.on("error", (error) => {
      finish(() => reject(error));
    });

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": IOS_BUNDLE_ID,
      "apns-push-type": options.pushType,
      "apns-priority": options.priority,
      "content-type": "application/json",
    });

    let status = 0;
    let chunks = "";
    req.setEncoding("utf8");
    req.on("response", (headers) => {
      const rawStatus = headers[":status"];
      status = typeof rawStatus === "number" ? rawStatus : parseInt(String(rawStatus || "0"), 10);
    });
    req.on("data", (chunk) => {
      chunks += chunk;
    });
    req.on("end", () => {
      finish(() => resolve({ status, body: chunks }));
    });
    req.on("error", (error) => {
      finish(() => reject(error));
    });
    req.end(body);
  });

  if (response.status >= 200 && response.status < 300) return { ok: true };

  const responseBody = response.body || "";
  let reason = responseBody;
  try {
    const parsed = JSON.parse(responseBody);
    reason = parsed?.reason || responseBody;
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
    key: normalizeAPNsPrivateKey(key),
    format: "pem",
  });

  const signature = crypto.sign("sha256", Buffer.from(unsignedToken), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });

  return `${unsignedToken}.${signature.toString("base64url")}`;
}

function normalizeAPNsPrivateKey(key: string): string {
  const trimmed = key.trim().replace(/\\n/g, "\n");
  if (trimmed.includes("BEGIN PRIVATE KEY")) return trimmed;
  return `-----BEGIN PRIVATE KEY-----\n${trimmed}\n-----END PRIVATE KEY-----`;
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
