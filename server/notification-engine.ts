import { db } from "./db";
import { watcherNotificationPrefs } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { sendPushNotification } from "./push";
import { sendSms, isSmsConfigured } from "./sms";
import { storage } from "./storage";

export type RecipientRole = "SUBJECT" | "WATCHER";

// Store-review safety net. When the subject of a notification is the
// dedicated Apple/Play review account, suppress all watcher fan-out
// (push + SMS) so the reviewer can exercise every screen without paging
// real people. Fails open on lookup error: real users never get silently
// dropped if the DB hiccups.
async function isReviewSubject(userId: string): Promise<boolean> {
  try {
    const u = await storage.getUser(userId);
    return !!u?.isReviewAccount;
  } catch {
    return false;
  }
}

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
  smsFallback?: boolean,
  audit?: { purpose?: import("./outbound-policy").OutboundPurpose; incidentId?: string | null; dedupeKey?: string | null },
): Promise<{ sent: boolean; channel: "push" | "sms" | "push+sms" }> {
  try {
    const pushResult = await sendPushNotification(userId, { title, body, tag, url }, {
      purpose: audit?.purpose || "system_alert",
      incidentId: audit?.incidentId ?? null,
      dedupeKey: audit?.dedupeKey ?? null,
    });
    let channel: "push" | "sms" | "push+sms" = "push";

    if (smsFallback && pushResult.sent === 0 && isSmsConfigured()) {
      const user = await storage.getUser(userId);
      if (user?.phone) {
        await sendSms(user.phone, `${title}\n${body}`, {
          purpose: audit?.purpose || "system_alert",
          userId,
          incidentId: audit?.incidentId ?? null,
          dedupeKey: audit?.dedupeKey ? `${audit.dedupeKey}:sms` : null,
        });
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
    body = "You're checked in. Your check-in update was sent to your Safety Circle.";
  } else if (method === "call") {
    body = "Got it. You're checked in by phone. Your check-in update was sent to your Safety Circle.";
  } else if (method === "sms") {
    body = "Got it. You're checked in by SMS. Your check-in update was sent to your Safety Circle.";
  } else {
    body = "You're checked in. Your check-in update was sent to your Safety Circle.";
  }

  try {
    const result = await deliverNotification(
      userId,
      "Checked in",
      body,
      `subject-confirm-${Date.now()}`,
      "/",
      false,
      { purpose: "recovery", dedupeKey: `subject_confirm:${userId}:${Math.floor(Date.now()/60000)}` },
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

function isUserInSleepHours(user: { sleepStart?: string; sleepEnd?: string; timezone?: string }): boolean {
  const tz = user.timezone || "Australia/Melbourne";
  const now = new Date();
  const localTime = now.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  const [h, m] = localTime.split(":").map(Number);
  const currentMin = h * 60 + m;
  const [sh, sm] = (user.sleepStart || "22:30").split(":").map(Number);
  const [eh, em] = (user.sleepEnd || "07:00").split(":").map(Number);
  const sleepStartMin = sh * 60 + sm;
  const sleepEndMin = eh * 60 + em;
  if (sleepStartMin > sleepEndMin) {
    return currentMin >= sleepStartMin || currentMin < sleepEndMin;
  }
  return currentMin >= sleepStartMin && currentMin < sleepEndMin;
}

export async function notifyConcern(
  userId: string,
  userName: string,
  reason: "missed_checkin" | "sos" | "heartbeat_silence" | "crash_detection"
): Promise<void> {
  if (await isReviewSubject(userId)) {
    console.log(`[NOTIFY] Suppressed concern fan-out: ${reason} for review-account subject ${userId}`);
    return;
  }
  const isEmergency = reason === "sos" || reason === "crash_detection";
  const protectedUser = await storage.getUser(userId);
  if (!isEmergency && protectedUser && isUserInSleepHours(protectedUser)) {
    console.log(`[NOTIFY] Suppressed ${reason} concern for user=${userId} (sleep hours active)`);
    return;
  }

  const watcherContacts = await storage.getContactsLinkedToUser(userId);

  let reasonText: string;
  let title: string;
  switch (reason) {
    case "missed_checkin":
      title = "Can you check in?";
      reasonText = `We haven't heard from ${userName}. Tap here to try reaching them.`;
      break;
    case "sos":
      title = "Emergency alert";
      reasonText = `${userName} needs help right now. Tap here to see what's happening.`;
      break;
    case "heartbeat_silence":
      title = "Still trying to reach them";
      reasonText = `We're still trying to reach ${userName}. No action needed yet.`;
      break;
    case "crash_detection":
      title = "Possible incident";
      reasonText = `We detected something unusual for ${userName}. Tap here for details.`;
      break;
    default:
      title = "Heads up";
      reasonText = `${userName} may need your help. Tap here to see what you can do.`;
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
        title,
        reasonText,
        `concern-${userId}`,
        "/watched",
        true,
        { purpose: "concern", dedupeKey: `concern:${userId}:${reason}:${contact.linkedUserId}` },
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
  if (await isReviewSubject(userId)) {
    console.log(`[NOTIFY] Suppressed recovery fan-out for review-account subject ${userId}`);
    return;
  }
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
        true,
        { purpose: "recovery", dedupeKey: `recovery:${userId}:${contact.linkedUserId}` },
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
  if (await isReviewSubject(userId)) {
    console.log(`[NOTIFY] Suppressed arrival fan-out for review-account subject ${userId}`);
    return;
  }
  const watcherContacts = await storage.getContactsLinkedToUser(userId);

  const body = placeName
    ? `${userName} arrived at ${placeName}`
    : `${userName} arrived`;

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
        placeName ? `Arrived at ${placeName}` : "Arrived",
        body,
        `arrival-${userId}`,
        "/watched",
        false,
        { purpose: "presence", dedupeKey: `arrival:${userId}:${placeName || "_"}:${contact.linkedUserId}` },
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
