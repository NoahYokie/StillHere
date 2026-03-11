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

export async function sendPushNotification(
  userId: string,
  payload: { title: string; body: string; url?: string; tag?: string }
): Promise<{ sent: number; failed: number }> {
  if (!configured) {
    console.log(`[PUSH] Not configured - would send to user ${userId}: ${payload.title}`);
    return { sent: 0, failed: 0 };
  }

  const subscriptions = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));

  let sent = 0;
  let failed = 0;

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
    body: "Your emergency contacts have been notified.",
    tag: "sos-confirmation",
  });
}

export async function sendIncidentPush(userId: string, userName: string, reason: "sos" | "missed_checkin"): Promise<void> {
  const title = reason === "sos" ? "Help request received" : "Missed check-in alert";
  const body = reason === "sos"
    ? `${userName} has requested help. Check the app for details.`
    : `${userName} missed their check-in. Your contacts are being notified.`;

  await sendPushNotification(userId, {
    title,
    body,
    tag: "incident",
  });
}
