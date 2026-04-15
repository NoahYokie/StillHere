import { db } from "./db";
import { watcherNotificationPrefs } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { sendPushNotification } from "./push";
import { sendSms, isSmsConfigured } from "./sms";
import { storage } from "./storage";

export type RecipientRole = "SUBJECT" | "WATCHER";

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

function logMessage(opts: {
  event: string;
  role: RecipientRole;
  recipientId: string;
  channel: "push" | "sms" | "push+sms" | "in-app";
  dedup?: string;
  suppressed?: boolean;
  reason?: string;
}) {
  const masked = opts.recipientId.startsWith("+")
    ? `***${opts.recipientId.slice(-4)}`
    : opts.recipientId.substring(0, 8) + "...";

  if (opts.suppressed) {
    console.log(`[NOTIFY] Suppressed ${opts.event} to ${masked} (Role: ${opts.role}, reason: ${opts.dedup || opts.reason})`);
  } else {
    console.log(`[NOTIFY] Sent ${opts.event} to ${masked} (Role: ${opts.role}, channel: ${opts.channel})`);
  }
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
): Promise<{ sent: boolean; channel: "push" | "sms" | "push+sms" }> {
  try {
    const pushResult = await sendPushNotification(userId, { title, body, tag, url });
    let channel: "push" | "sms" | "push+sms" = "push";

    if (smsFallback && pushResult.sent === 0 && isSmsConfigured()) {
      const user = await storage.getUser(userId);
      if (user?.phone) {
        await sendSms(user.phone, `${title}\n${body}`);
        channel = "sms";
      }
    } else if (smsFallback && pushResult.sent > 0) {
      channel = "push";
    }

    return { sent: true, channel };
  } catch (err) {
    console.error(`[NOTIFY] Failed to deliver to ${userId}:`, err);
    return { sent: false, channel: "push" };
  }
}

export async function notifySubjectConfirmation(
  userId: string,
  method: string,
  hadIncident: boolean
): Promise<void> {
  let body: string;
  if (hadIncident) {
    body = "You're checked in. Your watchers have been notified you're safe.";
  } else if (method === "call") {
    body = "Got it. You're checked in by phone. We've let your contacts know.";
  } else if (method === "sms") {
    body = "Got it. You're checked in by SMS. We've let your contacts know.";
  } else {
    body = "You're checked in. Your contacts know you're safe.";
  }

  try {
    const result = await deliverNotification(
      userId,
      "Checked in",
      body,
      `subject-confirm-${Date.now()}`,
      "/",
      false
    );
    logMessage({
      event: "SUBJECT_CONFIRMATION",
      role: "SUBJECT",
      recipientId: userId,
      channel: result.channel,
    });
  } catch (err: any) {
    console.error(`[NOTIFY] Subject confirmation failed for userId=${userId}:`, err?.message || err);
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

  const notifiedIdentities = new Set<string>();

  for (const contact of watcherContacts) {
    if (!contact.linkedUserId) {
      logMessage({
        event: "CONCERN",
        role: "WATCHER",
        recipientId: contact.name,
        channel: "push",
        suppressed: true,
        reason: "not linked to app user",
      });
      continue;
    }

    if (contact.linkedUserId === userId) {
      logMessage({
        event: "CONCERN",
        role: "SUBJECT",
        recipientId: contact.linkedUserId,
        channel: "push",
        suppressed: true,
        reason: "recipient is the subject themselves",
      });
      continue;
    }

    if (notifiedIdentities.has(contact.linkedUserId)) {
      logMessage({
        event: "CONCERN",
        role: "WATCHER",
        recipientId: contact.linkedUserId,
        channel: "push",
        suppressed: true,
        dedup: "duplicate of already-sent watcher push",
      });
      continue;
    }

    const key = getCooldownKey(contact.linkedUserId, "concern", userId);
    if (isCoolingDown(key)) {
      logMessage({
        event: "CONCERN",
        role: "WATCHER",
        recipientId: contact.linkedUserId,
        channel: "push",
        suppressed: true,
        dedup: `cooldown active (${COOLDOWN_MS / 1000}s)`,
      });
      continue;
    }

    try {
      const result = await deliverNotification(
        contact.linkedUserId,
        `Action needed`,
        reasonText,
        `concern-${userId}`,
        "/watched",
        true
      );
      if (result.sent) {
        markSent(key);
        notifiedIdentities.add(contact.linkedUserId);
        logMessage({
          event: "CONCERN",
          role: "WATCHER",
          recipientId: contact.linkedUserId,
          channel: result.channel,
        });
      }
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
    body = `Good news. ${userName} is safe now, confirmed by ${resolverName || "a watcher"} at ${timeStr}. No action needed.`;
  } else if (method === "call") {
    body = `Good news. ${userName} confirmed safe by phone call at ${timeStr}. No action needed.`;
  } else if (method === "sms") {
    body = `Good news. ${userName} confirmed safe by SMS at ${timeStr}. No action needed.`;
  } else {
    body = `Good news. ${userName} confirmed safe in app at ${timeStr}. No action needed.`;
  }

  const notifiedIdentities = new Set<string>();

  for (const contact of watcherContacts) {
    if (!contact.linkedUserId) {
      logMessage({
        event: "RECOVERY",
        role: "WATCHER",
        recipientId: contact.name,
        channel: "push",
        suppressed: true,
        reason: "not linked to app user",
      });
      continue;
    }

    if (contact.linkedUserId === userId) {
      logMessage({
        event: "RECOVERY",
        role: "SUBJECT",
        recipientId: contact.linkedUserId,
        channel: "push",
        suppressed: true,
        reason: "recipient is the subject (use SUBJECT_CONFIRMATION instead)",
      });
      continue;
    }

    if (notifiedIdentities.has(contact.linkedUserId)) {
      logMessage({
        event: "RECOVERY",
        role: "WATCHER",
        recipientId: contact.linkedUserId,
        channel: "push",
        suppressed: true,
        dedup: "duplicate of already-sent watcher push",
      });
      continue;
    }

    const key = getCooldownKey(contact.linkedUserId, "recovery", userId);
    if (isCoolingDown(key)) {
      logMessage({
        event: "RECOVERY",
        role: "WATCHER",
        recipientId: contact.linkedUserId,
        channel: "push",
        suppressed: true,
        dedup: `cooldown active (${COOLDOWN_MS / 1000}s)`,
      });
      continue;
    }

    try {
      const result = await deliverNotification(
        contact.linkedUserId,
        "All clear",
        body,
        `recovery-${userId}`,
        "/watched",
        true
      );
      if (result.sent) {
        markSent(key);
        notifiedIdentities.add(contact.linkedUserId);
        logMessage({
          event: "RECOVERY",
          role: "WATCHER",
          recipientId: contact.linkedUserId,
          channel: result.channel,
        });
      }
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

  const notifiedIdentities = new Set<string>();

  for (const contact of watcherContacts) {
    if (!contact.linkedUserId) continue;
    if (contact.linkedUserId === userId) continue;

    if (notifiedIdentities.has(contact.linkedUserId)) {
      logMessage({
        event: "ARRIVAL",
        role: "WATCHER",
        recipientId: contact.linkedUserId,
        channel: "push",
        suppressed: true,
        dedup: "duplicate of already-sent watcher push",
      });
      continue;
    }

    try {
      const prefEnabled = await getArrivalPrefEnabled(contact.linkedUserId, userId);
      if (!prefEnabled) {
        logMessage({
          event: "ARRIVAL",
          role: "WATCHER",
          recipientId: contact.linkedUserId,
          channel: "push",
          suppressed: true,
          reason: "arrival notifications disabled",
        });
        continue;
      }

      const key = getCooldownKey(contact.linkedUserId, "arrival", userId, placeName);
      if (isCoolingDown(key)) {
        logMessage({
          event: "ARRIVAL",
          role: "WATCHER",
          recipientId: contact.linkedUserId,
          channel: "push",
          suppressed: true,
          dedup: `cooldown active`,
        });
        continue;
      }

      const result = await deliverNotification(
        contact.linkedUserId,
        placeName ? `Arrived at ${placeName}` : "Arrived safely",
        body,
        `arrival-${userId}`,
        "/watched",
        false
      );
      if (result.sent) {
        markSent(key);
        notifiedIdentities.add(contact.linkedUserId);
        logMessage({
          event: "ARRIVAL",
          role: "WATCHER",
          recipientId: contact.linkedUserId,
          channel: result.channel,
        });
      }
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
