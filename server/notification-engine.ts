import { db } from "./db";
import { watcherNotificationPrefs } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { sendPushNotification } from "./push";
import { sendSms, isSmsConfigured } from "./sms";
import { storage } from "./storage";

const cooldowns = new Map<string, number>();
const COOLDOWN_MS = 2 * 60 * 1000;

function getCooldownKey(watcherId: string, eventType: string, targetUserId: string, place?: string | null): string {
  return `${watcherId}:${eventType}:${targetUserId}:${place || ""}`;
}

function isCoolingDown(key: string): boolean {
  const lastSent = cooldowns.get(key);
  return !!(lastSent && Date.now() - lastSent < COOLDOWN_MS);
}

function markSent(key: string): void {
  cooldowns.set(key, Date.now());
}

async function getArrivalPrefEnabled(watcherId: string, watchedUserId: string): Promise<boolean> {
  const [pref] = await db.select().from(watcherNotificationPrefs)
    .where(and(
      eq(watcherNotificationPrefs.watcherId, watcherId),
      eq(watcherNotificationPrefs.watchedUserId, watchedUserId),
    ))
    .limit(1);
  return pref ? pref.arrivalNotifications : true;
}

async function deliverNotification(
  userId: string,
  title: string,
  body: string,
  tag: string,
  url?: string,
  smsFallback?: boolean
): Promise<boolean> {
  try {
    const pushResult = await sendPushNotification(userId, { title, body, tag, url });

    if (smsFallback && pushResult.sent === 0 && isSmsConfigured()) {
      const user = await storage.getUser(userId);
      if (user?.phone) {
        await sendSms(user.phone, `${title}\n${body}`);
      }
    }
    return true;
  } catch (err) {
    console.error(`[NOTIFY] Failed to deliver to ${userId}:`, err);
    return false;
  }
}

export async function notifyConcern(
  userId: string,
  userName: string,
  reason: "missed_checkin" | "sos" | "heartbeat_silence" | "crash_detection"
): Promise<void> {
  const watcherContacts = await storage.getContactsLinkedToUser(userId);

  let reasonText: string;
  switch (reason) {
    case "missed_checkin":
      reasonText = `${userName} missed their check-in`;
      break;
    case "sos":
      reasonText = `${userName} triggered an emergency alert`;
      break;
    case "heartbeat_silence":
      reasonText = `${userName} hasn't been reachable for several minutes`;
      break;
    case "crash_detection":
      reasonText = `A possible incident was detected for ${userName}`;
      break;
    default:
      reasonText = `${userName} may need help`;
  }

  for (const contact of watcherContacts) {
    if (!contact.linkedUserId) continue;

    const key = getCooldownKey(contact.linkedUserId, "concern", userId);
    if (isCoolingDown(key)) continue;

    try {
      const sent = await deliverNotification(
        contact.linkedUserId,
        `Action needed`,
        reasonText,
        `concern-${userId}`,
        "/watched",
        true
      );
      if (sent) markSent(key);
    } catch (err: any) {
      console.error(`[NOTIFY] Concern delivery failed for watcher=${contact.linkedUserId} target=${userId} reason=${reason}:`, err?.message || err);
    }
  }
}

export async function notifyRecovery(
  userId: string,
  userName: string,
  resolvedBy: "user" | "watcher",
  resolverName?: string,
  method?: string
): Promise<void> {
  const watcherContacts = await storage.getContactsLinkedToUser(userId);

  const timeStr = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  let body: string;
  if (resolvedBy === "watcher") {
    body = `${userName} is safe now — confirmed by ${resolverName || "a watcher"}.`;
  } else if (method === "call") {
    body = `${userName} confirmed safe — responded to our check-in call at ${timeStr}.`;
  } else if (method === "sms") {
    body = `${userName} confirmed safe — replied to our check-in message at ${timeStr}.`;
  } else {
    body = `${userName} is safe — they confirmed just now.`;
  }

  for (const contact of watcherContacts) {
    if (!contact.linkedUserId) continue;

    const key = getCooldownKey(contact.linkedUserId, "recovery", userId);
    if (isCoolingDown(key)) continue;

    try {
      const sent = await deliverNotification(
        contact.linkedUserId,
        "All clear",
        body,
        `recovery-${userId}`,
        "/watched",
        true
      );
      if (sent) markSent(key);
    } catch (err: any) {
      console.error(`[NOTIFY] Recovery delivery failed for watcher=${contact.linkedUserId} target=${userId}:`, err?.message || err);
    }
  }
}

export async function notifyArrival(
  userId: string,
  userName: string,
  placeName: string | null
): Promise<void> {
  const watcherContacts = await storage.getContactsLinkedToUser(userId);

  const body = placeName
    ? `${userName} arrived at ${placeName}`
    : `${userName} arrived safely`;

  for (const contact of watcherContacts) {
    if (!contact.linkedUserId) continue;

    try {
      const prefEnabled = await getArrivalPrefEnabled(contact.linkedUserId, userId);
      if (!prefEnabled) continue;

      const key = getCooldownKey(contact.linkedUserId, "arrival", userId, placeName);
      if (isCoolingDown(key)) continue;

      const sent = await deliverNotification(
        contact.linkedUserId,
        placeName ? `Arrived at ${placeName}` : "Arrived safely",
        body,
        `arrival-${userId}`,
        "/watched",
        false
      );
      if (sent) markSent(key);
    } catch (err: any) {
      console.error(`[NOTIFY] Arrival delivery failed for watcher=${contact.linkedUserId} target=${userId} place=${placeName}:`, err?.message || err);
    }
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of cooldowns) {
    if (now - ts > COOLDOWN_MS * 2) {
      cooldowns.delete(key);
    }
  }
}, 5 * 60 * 1000);
