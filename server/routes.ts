import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import rateLimit from "express-rate-limit";
import { storage } from "./storage";
import { processLocationContext, getUserContext, getRecentContextEvents } from "./context-processor";
import { notifyConcern, notifyRecovery, notifySubjectConfirmation } from "./notification-engine";
import { addMinutes, addHours, addDays } from "date-fns";
import { db, pool } from "./db";
import { eq, and, lt, gte, desc, isNull, sql, inArray } from "drizzle-orm";
import { users, settings, authSessions, safeWalks, safetyTimers, watcherNotificationPrefs, incidents, checkins, contextEvents, contacts, outboundSendLog, type FamilyRole } from "@shared/schema";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { randomBytes, createHmac } from "crypto";
import * as crypto from "crypto";
import {
  createOtp,
  verifyOtp,
  deleteSession,
  setSessionCookie,
  clearSessionCookie,
  getSessionToken,
  getUserFromSession,
  normalizePhone,
} from "./auth";
import {
  sendSosAlert,
  sendMissedCheckinAlert,
  sendTestMessage,
  sendSafetyCircleRequest,
  sendReminderSms,
  sendAllClearNotification,
  sendEscalationAlert,
  sendHandlingTimeoutAlert,
  isTwilioConfigured,
  getTurnCredentials,
  sendSms,
  verifyTwilioSignature,
  escapeXml,
} from "./sms";
import {
  isPushConfigured,
  getVapidPublicKey,
  sendReminderPush,
  sendPushNotification,
} from "./push";
import { emitToUser, isUserOnline } from "./socket";
import { sendEmergencyEmail, sendGeofenceEmail, sendCrashEmail } from "./email";
import { getTrackingPolicyForUser, emitTrackingPolicyChanged } from "./tracking-policy";
import { deleteUserAccount, drainProcessorCleanupQueue } from "./accountDeletion";
import { twilioVoiceLimiter } from "./throughput";
import { getWeatherSummary } from "./weather";
import { detectActivityFromSpeed } from "@shared/activity-detection";

// Helper to get userId from session
// Per-user SOS in-flight lock. Set SYNCHRONOUSLY at the top of the SOS handler
// before any await yields, so concurrent SOS taps from the same user can never
// race past the dedup check. Values are wall-clock ms timestamps.
const sosInFlightByUser = new Map<string, number>();
const SOS_INFLIGHT_TTL_MS = 60_000;

const CRON_TICK_LOCK_ID = 420_001;
const SAFETY_STATE_TICK_LOCK_ID = 420_002;

async function tryAcquireDbAdvisoryLock(lockId: number): Promise<null | (() => Promise<void>)> {
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [lockId]);
    locked = result.rows?.[0]?.locked === true;
    if (!locked) {
      client.release();
      return null;
    }
    return async () => {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
      } finally {
        client.release();
      }
    };
  } catch (error) {
    if (!locked) client.release();
    throw error;
  }
}

const getUserId = (req: Request): string | null => {
  return (req as any).userId || null;
};

const getBaseUrl = (): string => {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) {
    const firstDomain = domains.split(",")[0].trim();
    return `https://${firstDomain}`;
  }
  return "https://stillhere.health";
};

function getContactPageWeatherCoords(data: any): { lat: number; lng: number } | null {
  const lat =
    data?.locationSession?.lastLat ??
    data?.safetyTimer?.lastLat ??
    data?.safeWalk?.lastLat ??
    data?.crashDrive?.endLat ??
    data?.crashDrive?.startLat ??
    data?.lastCheckin?.lat ??
    null;
  const lng =
    data?.locationSession?.lastLng ??
    data?.safetyTimer?.lastLng ??
    data?.safeWalk?.lastLng ??
    data?.crashDrive?.endLng ??
    data?.crashDrive?.startLng ??
    data?.lastCheckin?.lng ??
    null;
  return typeof lat === "number" && typeof lng === "number" ? { lat, lng } : null;
}

function getWatchedUserWeatherCoords(watched: any): { lat: number; lng: number } | null {
  const lat = watched?.lastLocationLat != null
    ? Number(watched.lastLocationLat)
    : watched?.lastHeartbeatLat != null
    ? Number(watched.lastHeartbeatLat)
    : null;
  const lng = watched?.lastLocationLng != null
    ? Number(watched.lastLocationLng)
    : watched?.lastHeartbeatLng != null
    ? Number(watched.lastHeartbeatLng)
    : null;
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)
    ? { lat, lng }
    : null;
}

const getTwilioVoiceFromNumber = (): string | null => {
  const value = process.env.TWILIO_VOICE_PHONE_NUMBER || process.env.TWILIO_PHONE_NUMBER || null;
  if (!value || value === "+15555550123") return null;
  return value;
};

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatContextEvent(type: string, placeName: string | null, detail: string | null): string {
  if (detail) return detail;
  const place = placeName || "nearby";
  switch (type) {
    case "dwell_start": return `Settled in at ${place}`;
    case "dwell_end": return `Left ${place}`;
    case "trip_start": return placeName ? `Left ${place}` : "Heading out";
    case "trip_end": return placeName ? `Arrived at ${place}` : "Arrived safely";
    default: return type;
  }
}

type CheckinMethod = "app" | "sms" | "call";

interface ResolveOptions {
  resolvedBy?: "user" | "watcher";
  resolverName?: string;
  skipCreateCheckin?: boolean;
}

async function resolveCheckin(userId: string, method: CheckinMethod, options?: ResolveOptions): Promise<{ resolved: boolean; hadIncident: boolean }> {
  const user = await storage.getUser(userId);
  if (!user) {
    console.error(`[RESOLVE] User not found: ${userId}`);
    return { resolved: false, hadIncident: false };
  }

  const resolvedBy = options?.resolvedBy || "user";
  const resolverName = options?.resolverName;

  if (!options?.skipCreateCheckin) {
    const checkinMethod = method === "call" ? "auto" : method === "app" ? "button" : method;
    await storage.createCheckin(userId, checkinMethod as any, {});
    await storage.resetReminderState(userId);
    console.log(`[RESOLVE] Check-in recorded for user=${userId} via ${method}`);
  } else {
    console.log(`[RESOLVE] Skipped duplicate check-in creation for user=${userId} (already created by caller)`);
  }

  if (user.safetyState === "concern" || user.safetyState === "quiet") {
    await storage.updateSafetyState(userId, "active", `Confirmed safe via ${method}`);
    console.log(`[RESOLVE] Safety state restored: ${user.safetyState} → active`);
  }

  const openIncident = await storage.getOpenIncident(userId);
  let hadIncident = false;
  let smsSuccess = 0;
  let smsFailed = 0;

  if (openIncident) {
    hadIncident = true;
    await storage.updateIncident(openIncident.id, {
      status: "resolved",
      resolvedAt: new Date(),
    });
    console.log(`[RESOLVE] Incident ${openIncident.id} resolved (${openIncident.reason})`);

    const session = await storage.getActiveLocationSession(userId);
    if (session) {
      await storage.endLocationSession(session.id);
      console.log(`[RESOLVE] Location session ended`);
    }

    const baseUrl = getBaseUrl();
    const allClearAt = new Date();
    const allClearTimeLabel = formatOwnerLocalAlertTime(allClearAt, user.timezone);
    const allContacts = (await storage.getContacts(userId)).filter(isContactActiveForAlerts);
    console.log(`[ALL-CLEAR] Preparing to send all-clear SMS. userId=${userId}, incidentId=${openIncident.id}, method=${method}, contacts=${allContacts.length}`);

    const smsDedup = new Set<string>();

    for (const contact of allContacts) {
      const normalizedPhone = normalizePhone(contact.phone);
      if (smsDedup.has(normalizedPhone)) {
        console.log(`[NOTIFY] Suppressed RECOVERY_SMS to ***${contact.phone.slice(-4)} (Role: WATCHER, reason: duplicate phone)`);
        continue;
      }
      try {
        // Mint a purpose='allclear', short-lived (4h) token specifically for this
        // resolution SMS. The link surfaces a read-only "they're safe" page with
        // no location, no history, and no actions, even if the user starts a new
        // sharing session later. Standing tokens are not reused here, so a leaked
        // SMS link cannot grant ongoing visibility.
        const fresh = await storage.generateToken(contact.id, { ttlHours: 4, purpose: "allclear" });
        const link = `${baseUrl}/e/${fresh.token}`;
        await sendAllClearNotification(normalizedPhone, user.name, link, { alertSentLabel: allClearTimeLabel });
        smsSuccess++;
        smsDedup.add(normalizedPhone);
        console.log(`[NOTIFY] Sent RECOVERY_SMS to ***${contact.phone.slice(-4)} (Role: WATCHER, channel: sms, ttlHours: 4)`);
        console.log(JSON.stringify({ event: "CONTACT_SENT", type: "recovery", role: "WATCHER", contactId: contact.id, userId, method, timestamp: new Date().toISOString() }));
      } catch (err: any) {
        smsFailed++;
        console.error(`[ALL-CLEAR] FAILED to contact=${contact.id} (phone ***${contact.phone.slice(-4)}): ${err?.message || err}`);
      }
    }
    console.log(`[ALL-CLEAR] Complete: ${smsSuccess} success, ${smsFailed} failed`);
  }

  let watcherNotified = false;
  try {
    await notifyRecovery(userId, user.name, resolvedBy, resolverName, method);
    watcherNotified = true;
  } catch (err) {
    console.error(`[RESOLVE] notifyRecovery failed:`, err);
  }

  try {
    await notifySubjectConfirmation(userId, method, hadIncident);
  } catch (err) {
    console.error(`[RESOLVE] Subject confirmation failed:`, err);
  }

  const timeStr = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  const methodLabel = resolvedBy === "watcher" 
    ? `Confirmed safe by ${resolverName || "a watcher"}`
    : method === "call" ? "Confirmed safe by phone call" 
    : method === "sms" ? "Confirmed safe by SMS" 
    : "Confirmed safe in app";
  const watcherContacts = await storage.getContactsLinkedToUser(userId);
  for (const contact of watcherContacts) {
    if (contact.linkedUserId) {
      emitToUser(contact.linkedUserId, "concern:resolved", {
        userId,
        userName: user.name,
        resolvedBy,
        resolvedByName: resolverName,
        method,
        methodLabel,
        timeLabel: `at ${timeStr}`,
        resolvedAt: new Date().toISOString(),
      });
    }
  }

  console.log(JSON.stringify({
    event: "SAFETY_RESOLVED",
    userId,
    method,
    resolvedBy,
    hadIncident,
    safetyStateRestored: user.safetyState !== "active",
    smsAllClearSent: hadIncident ? smsSuccess > 0 : false,
    smsAllClearCount: hadIncident ? smsSuccess : 0,
    smsAllClearFailed: hadIncident ? smsFailed : 0,
    watcherNotified,
    watcherCount: watcherContacts.filter(c => c.linkedUserId).length,
    incidentResolved: hadIncident,
    tokensRevoked: hadIncident,
    timestamp: new Date().toISOString(),
  }));

  // Notify the user's connected clients that their tracking policy may have
  // shifted (e.g. open incident closed → presence-mode user can stop GPS).
  emitTrackingPolicyChanged(userId, "incident_resolved").catch(() => {});

  console.log(`[RESOLVE] Complete: user=${userId} confirmed safe via ${method}, incident=${hadIncident}`);
  return { resolved: true, hadIncident };
}

function isValidEmail(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

interface NotifyContactSummary {
  attempted: string[];
  delivered: string[];
  smsAttempted: boolean;
  smsDelivered: boolean;
}

function isAcceptedWatcherLink(contact: { linkedUserId?: string | null; watcherConsentStatus?: string | null }, linkedUserId?: string | null): boolean {
  if (!contact.linkedUserId) return false;
  if (linkedUserId && contact.linkedUserId !== linkedUserId) return false;
  return contact.watcherConsentStatus === "accepted";
}

function isContactActiveForAlerts(contact: { softDeletedAt?: Date | string | null; pausedUntil?: Date | string | null }): boolean {
  if (contact.softDeletedAt) return false;
  if (!contact.pausedUntil) return true;
  return new Date(contact.pausedUntil).getTime() <= Date.now();
}

async function sendLinkedWatcherPresencePush(
  userId: string,
  title: string,
  body: string,
  tag: string,
  url = "/watched",
): Promise<void> {
  const watcherContacts = await storage.getContactsLinkedToUser(userId);
  const sentTo = new Set<string>();
  await Promise.allSettled(
    watcherContacts.map(async (contact) => {
      const linkedUserId = contact.linkedUserId;
      if (!linkedUserId || linkedUserId === userId || sentTo.has(linkedUserId)) return;
      if (!isAcceptedWatcherLink(contact, linkedUserId) || !isContactActiveForAlerts(contact)) return;
      sentTo.add(linkedUserId);
      await sendPushNotification(linkedUserId, {
        title,
        body,
        url,
        tag,
      }, {
        purpose: "presence",
        dedupeKey: `${tag}:${userId}:${linkedUserId}:${Math.floor(Date.now() / 300000)}`,
      });
    }),
  );
}

function timezonePlaceLabel(timezone?: string | null): string {
  if (!timezone) return "UTC";
  const city = timezone.split("/").pop()?.replace(/_/g, " ");
  return city ? `${city} time` : timezone;
}

function formatPreferredCheckinLabel(preferredTime?: string | null, timezone?: string | null): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec((preferredTime || "").trim());
  if (!match) return null;
  const hour = Math.max(0, Math.min(23, parseInt(match[1], 10)));
  const minute = Math.max(0, Math.min(59, parseInt(match[2], 10)));
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix} ${timezonePlaceLabel(timezone)}`;
}

function formatOwnerLocalAlertTime(date: Date, timezone?: string | null): string {
  const tz = timezone || "UTC";
  try {
    const time = date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: tz,
    });
    return `${time} ${timezonePlaceLabel(timezone)}`;
  } catch {
    return `${date.toISOString()} UTC`;
  }
}

async function createProtectedUserSystemAlert(
  user: { id: string; name?: string | null },
  content: string,
  meta?: Record<string, any>,
): Promise<void> {
  try {
    const msg = await storage.saveMessage(user.id, user.id, content, {
      messageType: "system_alert",
      meta,
    });
    emitToUser(user.id, "message:new", {
      ...msg,
      senderName: "StillHere",
      type: "system-alert",
    });
  } catch (err: any) {
    console.error(`[NOTIFY] In-app system alert failed for user=${user.id}:`, err?.message || err);
  }
}

async function placeWellnessCallForIncident(
  user: { id: string; phone?: string | null; name?: string | null },
  incident: { id: string },
  timeline: Array<{ type: string; time: string; detail: string }>,
  time: Date,
  detailPrefix = "Wellness call",
): Promise<boolean> {
  const timeStr = time.toISOString();
  const userSettings = await storage.getSettings(user.id).catch(() => null);
  const autoWellnessCallFlag = !!(userSettings as any)?.autoWellnessCall;
  const twilioReady = isTwilioConfigured();
  const hasPhone = !!user.phone;

  console.log(JSON.stringify({
    event: "CALL_FLOW_DIAGNOSTIC",
    source: "safe_walk",
    userId: user.id,
    autoWellnessCallEnabled: autoWellnessCallFlag,
    twilioConfigured: twilioReady,
    hasPhone,
    phoneLast4: hasPhone && user.phone ? `***${user.phone.slice(-4)}` : null,
    willAttemptCall: autoWellnessCallFlag && twilioReady && hasPhone,
    incidentId: incident.id,
    timestamp: timeStr,
  }));

  if (!autoWellnessCallFlag || !twilioReady || !user.phone) {
    const reasons = [];
    if (!autoWellnessCallFlag) reasons.push("autoWellnessCall disabled");
    if (!twilioReady) reasons.push("Twilio not configured");
    if (!hasPhone) reasons.push("no phone number");
    const reason = reasons.join(", ");
    timeline.push({ type: "call_skipped", time: timeStr, detail: `${detailPrefix} skipped: ${reason}` });
    console.log(`[SAFE-WALK] Wellness call skipped for user=${user.id}: ${reason}`);
    return false;
  }

  const voicePolicy = await import("./outbound-policy");
  let voiceAttemptId: string | undefined;
  try {
    const voiceDecision = await voicePolicy.enforceSendPolicy({
      channel: "voice",
      purpose: "wellness_call",
      destination: user.phone,
      userId: user.id,
      incidentId: incident.id,
      dedupeKey: `wellness_call:${incident.id}`,
    });
    voiceAttemptId = voiceDecision.attemptId;
    if (voiceDecision.degraded) {
      await storage.updateIncident(incident.id, { degradedDelivery: true });
    }
    if (!voiceDecision.allowed) {
      timeline.push({ type: "call_failed", time: timeStr, detail: `${detailPrefix} blocked by policy: ${voiceDecision.reason}` });
      console.warn(`[SAFE-WALK] Wellness call blocked by policy (${voiceDecision.reason}) for user=${user.id}`);
      return false;
    }

    const twilio = (await import("twilio")).default;
    const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
    const voiceFromNumber = getTwilioVoiceFromNumber();
    if (!voiceFromNumber) {
      throw new Error("Twilio voice caller number is not configured. Set TWILIO_VOICE_PHONE_NUMBER to a verified or purchased Twilio voice number.");
    }
    const baseUrl = getBaseUrl();
    const callParams: any = {
      to: user.phone!,
      from: voiceFromNumber,
      url: `${baseUrl}/api/wellness-call/respond`,
      method: "POST",
      machineDetection: "DetectMessageEnd",
      asyncAmd: true,
      asyncAmdStatusCallback: `${baseUrl}/api/wellness-call/status`,
      asyncAmdStatusCallbackMethod: "POST",
      statusCallback: `${baseUrl}/api/wellness-call/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    };
    const callResult = await twilioVoiceLimiter.run(() => client.calls.create(callParams));
    await voicePolicy.markSendProviderResult(voiceAttemptId, "sent", { providerId: callResult.sid });
    timeline.push({ type: "call", time: timeStr, detail: `${detailPrefix} placed` });
    await storage.updateIncident(incident.id, {
      callSentAt: time,
      wellnessCallStatus: "placed",
      escalationTimeline: JSON.stringify(timeline),
    });
    console.log(`[SAFE-WALK] Wellness call placed for user=${user.id} (SID: ${callResult.sid})`);
    return true;
  } catch (err: any) {
    const callError = err?.message || "unknown error";
    timeline.push({ type: "call_failed", time: timeStr, detail: `${detailPrefix} failed: ${callError}` });
    console.error(`[SAFE-WALK] Wellness call failed for user=${user.id}: ${callError}`);
    try {
      await voicePolicy.markSendProviderResult(voiceAttemptId, "failed", { errorMessage: callError });
      await storage.updateIncident(incident.id, { degradedDelivery: true });
    } catch {}
    return false;
  }
}

async function notifyContact(
  contact: { id: string; phone: string; name: string; linkedUserId: string | null; userId: string; email?: string | null; watcherConsentStatus?: string | null },
  userName: string,
  link: string,
  reason: "sos" | "missed_checkin",
  sendSmsFn: (
    phone: string,
    userName: string,
    link: string,
    options?: { userId?: string | null; incidentId?: string | null; ipAddress?: string | null; dedupeKey?: string | null; scheduledCheckinLabel?: string | null; alertSentLabel?: string | null },
  ) => Promise<{ success: boolean; error?: string } | any>,
  audit?: { incidentId?: string | null; ipAddress?: string | null },
): Promise<NotifyContactSummary> {
  const summary: NotifyContactSummary = { attempted: [], delivered: [], smsAttempted: false, smsDelivered: false };
  const incidentId = audit?.incidentId ?? null;
  const ipAddress = audit?.ipAddress ?? null;
  let subjectUser: Awaited<ReturnType<typeof storage.getUser>> | undefined;
  let subjectSettings: Awaited<ReturnType<typeof storage.getSettings>> | undefined;

  // Store-review safety net: if the SUBJECT user (the one in trouble) is the
  // dedicated Apple/Play review account, never page real emergency contacts.
  try {
    subjectUser = await storage.getUser(contact.userId);
    if (subjectUser?.isReviewAccount) {
      console.log(`[NOTIFY] Skipped contact fan-out (review account subject ${contact.userId})`);
      return summary;
    }
  } catch (e: any) {
    console.warn(`[NOTIFY] Review-flag lookup failed for subject ${contact.userId}, dispatching anyway:`, e?.message || e);
  }
  try {
    subjectSettings = await storage.getSettings(contact.userId);
  } catch {}
  const scheduledCheckinLabel = reason === "missed_checkin"
    ? formatPreferredCheckinLabel(subjectSettings?.preferredCheckinTime, subjectUser?.timezone)
    : null;
  const alertSentLabel = formatOwnerLocalAlertTime(new Date(), subjectUser?.timezone);

  // Channel 1: SMS
  const normalizedPhone = normalizePhone(contact.phone);
  summary.attempted.push("sms");
  summary.smsAttempted = true;
  try {
    const smsRes = await sendSmsFn(normalizedPhone, userName, link, {
      userId: contact.userId,
      incidentId,
      ipAddress,
      dedupeKey: incidentId ? `contact_alert:${incidentId}:${contact.id}` : null,
      scheduledCheckinLabel,
      alertSentLabel,
    });
    if (smsRes && smsRes.success) {
      summary.delivered.push("sms");
      summary.smsDelivered = true;
      console.log(`[NOTIFY] Sent SMS to contact`);
    } else {
      console.warn(`[NOTIFY] SMS not delivered to contact ${contact.id}: ${smsRes?.error || "unknown"}`);
    }
  } catch (e: any) {
    console.error(`[NOTIFY] SMS threw for contact ${contact.id}:`, e?.message || e);
  }

  // Channel 2: Email
  const cleanEmail = isValidEmail(contact.email) ? contact.email!.trim() : null;
  if (contact.email && !cleanEmail) {
    console.warn(`[NOTIFY] Skipping email for contact ${contact.id} — value in email field is not a valid email address`);
  }
  if (cleanEmail) {
    summary.attempted.push("email");
    try {
      const emailRes = await sendEmergencyEmail(cleanEmail, userName, link, reason, {
        lat: subjectUser?.lastLat ?? null,
        lng: subjectUser?.lastLng ?? null,
        locationAt: subjectUser?.lastLocationAt ?? null,
        timezone: subjectUser?.timezone ?? null,
      }, {
        userId: contact.userId,
        incidentId,
        dedupeKey: incidentId ? `contact_email:${incidentId}:${contact.id}` : null,
      });
      // Strict: only count actual provider-confirmed deliveries. Dev dry-runs
      // (no RESEND_API_KEY) and policy-deduped sends return success:true with
      // dryRun:true; treating those as delivered would suppress
      // incidents.deliveryFailed when the contact in fact got nothing.
      if (emailRes && (emailRes as any).success === true && !(emailRes as any).dryRun) {
        summary.delivered.push("email");
        console.log(`[NOTIFY] Also sent email to contact`);
      }
    } catch (e) {
      console.error(`[NOTIFY] Email failed:`, e);
    }
  }

  // Channels 3 + 4: Push + in-app message (linked-user only)
  const linkedUserId = contact.linkedUserId;
  if (linkedUserId && isAcceptedWatcherLink(contact, linkedUserId)) {
    summary.attempted.push("push");
    try {
      const timingSuffix = reason === "missed_checkin" && scheduledCheckinLabel
        ? ` Scheduled check-in time: ${scheduledCheckinLabel}.`
        : "";
      const pushRes = await sendPushNotification(linkedUserId, {
        title: reason === "sos" ? `SOS from ${userName}` : `Safety Alert: ${userName} has not checked in`,
        body: reason === "sos"
          ? `${userName} has activated an emergency SOS and needs immediate assistance. Open the app to respond.`
          : `${userName} has not completed their scheduled safety checkin.${timingSuffix} Open the app to respond.`,
        url: "/watched",
        tag: "emergency-alert",
      }, {
        purpose: reason === "sos" ? "sos_alert" : "missed_checkin_alert",
        incidentId,
        dedupeKey: incidentId ? `contact_push:${incidentId}:${linkedUserId}` : null,
      });
      if (pushRes && pushRes.sent > 0) {
        summary.delivered.push("push");
        console.log(`[NOTIFY] Also sent push notification to contact (in-app user)`);
      }
    } catch (err: any) {
      console.error(`[NOTIFY] Push to linked contact=${contact.id} failed:`, err?.message || err);
    }

    summary.attempted.push("in_app");
    try {
      const alertContent = reason === "sos"
        ? `${userName} has activated an emergency SOS. Please check on them immediately.`
        : `${userName} has not completed their safety checkin.${scheduledCheckinLabel ? ` Scheduled check-in time: ${scheduledCheckinLabel}.` : ""} Please check on them.`;
      await storage.saveMessage(contact.userId, linkedUserId, alertContent);
      emitToUser(linkedUserId, "message:new", {
        type: "emergency-alert",
        userName,
        reason,
      });
      summary.delivered.push("in_app");
    } catch (err: any) {
      console.error(`[NOTIFY] In-app message to linked contact=${contact.id} failed:`, err?.message || err);
    }
  }

  // Flip incident flags: degradedDelivery if SMS attempted but only fallbacks
  // succeeded; deliveryFailed if every attempted channel failed. Never throws
  // — a flag-update failure must not block a safety event.
  //
  // Multi-contact semantics (intentional UNION at incident level):
  //   - deliveryFailed=true on the incident means at least one contact got
  //     nothing through any channel.
  //   - degradedDelivery=true on the incident means at least one contact
  //     required a fallback for delivery to succeed.
  // These can both be true on the same incident when different contacts had
  // different fates (e.g. contact A unreachable, contact B reached only by
  // push). At the per-contact decision below they remain mutually exclusive.
  if (incidentId) {
    try {
      const allFailed = summary.attempted.length > 0 && summary.delivered.length === 0;
      const smsBackedByFallback = summary.smsAttempted && !summary.smsDelivered && summary.delivered.length > 0;
      const patch: any = {};
      if (allFailed) patch.deliveryFailed = true;
      if (smsBackedByFallback) patch.degradedDelivery = true;
      if (Object.keys(patch).length > 0) {
        await storage.updateIncident(incidentId, patch);
        if (allFailed) {
          console.warn(`[NOTIFY] All channels failed for contact ${contact.id} on incident ${incidentId}; deliveryFailed=true`);
        } else if (smsBackedByFallback) {
          console.log(`[NOTIFY] SMS unavailable for contact ${contact.id} on incident ${incidentId}; delivered via ${summary.delivered.join("/")}; degradedDelivery=true`);
        }
      }
    } catch (e: any) {
      console.warn(`[NOTIFY] Could not update incident delivery flags: ${e?.message || e}`);
    }
  }

  return summary;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  const isNativeAuthRequest = (req: Request) =>
    req.get("Origin") === "capacitor://localhost" || req.get("X-StillHere-Native") === "1";
  
  // ============================================
  // HEALTH CHECK (public)
  // ============================================
  
  app.get("/api/health", (req, res) => {
    res.json({ 
      ok: true, 
      port: process.env.PORT || 5000,
      timestamp: new Date().toISOString(),
    });
  });

  // Stripe billing routes (checkout, portal, products, /api/billing/me).
  // The webhook is registered earlier in server/index.ts with raw body parsing.
  const { registerStripeRoutes } = await import("./stripeRoutes");
  registerStripeRoutes(app);
  // RevenueCat routes for iOS/Android in-app purchases.
  const { registerRevenueCatRoutes } = await import("./revenuecatRoutes");
  registerRevenueCatRoutes(app);
  
  // ============================================
  // AUTH ROUTES (public)
  // ============================================

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many authentication attempts, please try again later" },
  });

  // Send OTP code
  app.post("/api/auth/send-code", authLimiter, async (req, res) => {
    try {
      const { phone } = req.body;
      
      if (!phone) {
        return res.status(400).json({ error: "Phone number is required" });
      }

      const result = await createOtp(phone);
      
      if (!result.success) {
        return res.status(429).json({ 
          error: result.error,
          waitSeconds: result.waitSeconds,
        });
      }
      
      res.json({ success: true, phone: result.phone });
    } catch (error) {
      console.error("Error sending OTP:", error);
      res.status(500).json({ error: "Failed to send code" });
    }
  });
  
  // Verify OTP code  -  rate limited to prevent brute force
  const verifyAttempts = new Map<string, { count: number; resetAt: number }>();
  const MAX_VERIFY_ATTEMPTS = 5;
  const VERIFY_WINDOW_MS = 10 * 60 * 1000;

  app.post("/api/auth/verify-code", authLimiter, async (req, res) => {
    try {
      const { phone, code } = req.body;
      
      if (!phone || !code) {
        return res.status(400).json({ error: "Phone and code are required" });
      }

      const normalizedPhone = normalizePhone(phone);
      const now = Date.now();
      const attempts = verifyAttempts.get(normalizedPhone);
      if (attempts && now < attempts.resetAt) {
        if (attempts.count >= MAX_VERIFY_ATTEMPTS) {
          return res.status(429).json({ error: "Too many attempts. Please request a new code." });
        }
      } else {
        verifyAttempts.set(normalizedPhone, { count: 0, resetAt: now + VERIFY_WINDOW_MS });
      }
      
      const ageConfirmed = req.body?.ageConfirmed === true;
      const result = await verifyOtp(phone, code, { ageConfirmed });

      if (!result.success) {
        // COPPA / age gate (Batch 3). New user did not tick the 13+ box.
        // Distinct error code so the client can show a specific message.
        // No session is set, no user row was created.
        if (result.error === "age_gate_required") {
          return res.status(400).json({
            error: "age_gate_required",
            message: "StillHere is not available for users under 13.",
          });
        }
        const entry = verifyAttempts.get(normalizedPhone)!;
        entry.count++;
        return res.status(401).json({ error: "Invalid or expired code" });
      }
      
      verifyAttempts.delete(normalizedPhone);
      
      // Set session cookie
      setSessionCookie(res, result.sessionToken!);

      // Backfill: link any existing contacts that have this phone number
      if (result.userId) {
        try {
          const allContacts = await storage.findContactsByPhone(normalizedPhone);
          console.log(`[AUTH] Found ${allContacts.filter((c) => c.userId !== result.userId && !c.linkedUserId).length} pending watcher request(s) for user=${result.userId}`);
        } catch (err: any) {
          const maskedPhone = normalizedPhone ? `***${normalizedPhone.slice(-4)}` : "(no phone)";
          console.error(`[AUTH] Contact backfill failed for ${maskedPhone}:`, err?.message || err);
        }
      }
      
      const payload: Record<string, unknown> = {
        success: true,
        userId: result.userId,
        isNewUser: result.isNewUser,
        needsSetup: result.needsSetup,
      };

      if (isNativeAuthRequest(req)) {
        payload.nativeSessionToken = result.sessionToken;
      }

      res.json(payload);
    } catch (error) {
      console.error("Error verifying OTP:", error);
      res.status(500).json({ error: "Failed to verify code" });
    }
  });
  
  // Get current auth status
  app.get("/api/auth/me", async (req, res) => {
    try {
      const userId = getUserId(req);
      
      if (!userId) {
        return res.json({ authenticated: false });
      }
      
      const user = (req as any).user;
      const needsSetup = !user?.name || user.name.trim() === "";

      // hasActiveSafetyEvent lets the client suppress the Limitations of
      // Service gate while the user is mid-incident. Best-effort: if the
      // lookup fails we default to true (fail-safe: never trap a user who
      // might actually be in a safety flow).
      let hasActiveSafetyEvent = true;
      try {
        hasActiveSafetyEvent = await storage.hasActiveSafetyEvent(userId);
      } catch (err) {
        console.warn("[AUTH ME] hasActiveSafetyEvent lookup failed:", (err as any)?.message || err);
      }

      res.json({
        authenticated: true,
        userId,
        user: {
          id: user.id,
          name: user.name,
          phone: user.phone,
          timezone: user.timezone,
          acknowledgedLimitationsAt: user.acknowledgedLimitationsAt ?? null,
        },
        needsSetup,
        acknowledgedLimitationsAt: user.acknowledgedLimitationsAt ?? null,
        hasActiveSafetyEvent,
      });
    } catch (error) {
      console.error("Error getting auth status:", error);
      res.status(500).json({ error: "Failed to get auth status" });
    }
  });

  app.get("/api/watcher-requests", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const user = await storage.getUser(userId);
      if (!user?.phone) return res.json({ requests: [] });
      const matches = await storage.findContactsByPhone(normalizePhone(user.phone));
      const requests = [];
      for (const contact of matches) {
        if (contact.userId === userId || contact.linkedUserId || contact.softDeletedAt) continue;
        if (contact.watcherConsentStatus === "declined") continue;
        const owner = await storage.getUser(contact.userId);
        requests.push({
          contactId: contact.id,
          ownerName: owner?.name || "Someone",
          contactName: contact.name,
          role: contact.circleRole || "primary",
          requestedAt: contact.watcherConsentRequestedAt || contact.createdAt,
        });
      }
      res.json({ requests });
    } catch (error) {
      console.error("[WATCHER_REQUESTS] list failed:", (error as any)?.message || error);
      res.status(500).json({ error: "Failed to load watcher requests" });
    }
  });

  app.post("/api/watcher-requests/:contactId/accept", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const user = await storage.getUser(userId);
      const contact = await storage.getContact(req.params.contactId);
      if (!user?.phone || !contact || contact.softDeletedAt) {
        return res.status(404).json({ error: "Request not found" });
      }
      if (contact.userId === userId || normalizePhone(contact.phone) !== normalizePhone(user.phone)) {
        return res.status(403).json({ error: "You can only accept watcher requests sent to your phone number" });
      }
      if (contact.linkedUserId && contact.linkedUserId !== userId) {
        return res.status(409).json({ error: "This watcher request is already linked to another account" });
      }
      const updated = await storage.linkContactToUser(contact.id, userId);
      await sendPushNotification(contact.userId, {
        title: "Safety Circle accepted",
        body: `${user.name || contact.name} accepted your StillHere Safety Circle request.`,
        url: "/safety-circle",
        tag: `watcher-request-accepted-${contact.id}`,
      }).catch(() => {});
      res.json({ success: true, contact: updated });
    } catch (error) {
      console.error("[WATCHER_REQUESTS] accept failed:", (error as any)?.message || error);
      res.status(500).json({ error: "Failed to accept watcher request" });
    }
  });

  app.post("/api/watcher-requests/:contactId/decline", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const user = await storage.getUser(userId);
      const contact = await storage.getContact(req.params.contactId);
      if (!user?.phone || !contact || contact.softDeletedAt) {
        return res.status(404).json({ error: "Request not found" });
      }
      if (contact.userId === userId || normalizePhone(contact.phone) !== normalizePhone(user.phone)) {
        return res.status(403).json({ error: "You can only decline watcher requests sent to your phone number" });
      }
      await db.update(contacts)
        .set({
          linkedUserId: null,
          watcherConsentStatus: "declined",
          watcherConsentDeclinedAt: new Date(),
        })
        .where(eq(contacts.id, contact.id));
      res.json({ success: true });
    } catch (error) {
      console.error("[WATCHER_REQUESTS] decline failed:", (error as any)?.message || error);
      res.status(500).json({ error: "Failed to decline watcher request" });
    }
  });
  
  // Limitations of Service acknowledgement. Idempotent: subsequent calls
  // are a no-op and return the original acknowledgement timestamp. Does NOT
  // touch any safety feature, contact, incident, or setting.
  app.post("/api/limitations/acknowledge", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const user = await storage.markLimitationsAcknowledged(userId);
      res.json({
        success: true,
        acknowledgedLimitationsAt: user.acknowledgedLimitationsAt,
      });
    } catch (error) {
      console.error("Error acknowledging limitations:", error);
      res.status(500).json({ error: "Failed to record acknowledgement" });
    }
  });

  // Logout
  app.post("/api/auth/logout", async (req, res) => {
    try {
      const sessionToken = getSessionToken(req);
      
      if (sessionToken) {
        await deleteSession(sessionToken);
      }
      
      clearSessionCookie(res);
      res.json({ success: true });
    } catch (error) {
      console.error("Error logging out:", error);
      res.status(500).json({ error: "Failed to logout" });
    }
  });

  // ============================================
  // ACCOUNT DELETION
  // ============================================
  
  app.delete("/api/account", async (req, res) => {
    try {
      const sessionToken = getSessionToken(req);
      if (!sessionToken) return res.status(401).json({ error: "Not authenticated" });
      const session = await getUserFromSession(sessionToken);
      if (!session) return res.status(401).json({ error: "Not authenticated" });
      const user = session.user;

      // Inline-then-cron hybrid. Inserts processor_cleanup_queue row, runs
      // each processor step inline with a 4s timeout, revokes all sessions,
      // clears the in-memory passkey reg challenge, deletes the user row.
      // Failed/timed-out steps stay in the queue for the cron drainer.
      const result = await deleteUserAccount({
        userId: user.id,
        challengeStore,
      });

      // Always clear THIS request's session cookie too (revoke-all already
      // killed the row, this just removes the client-side cookie).
      clearSessionCookie(res);

      res.json({
        success: true,
        processorWarnings: result.processorWarnings,
      });
    } catch (error: any) {
      const code = error?.message;
      if (code === "user_not_found") {
        clearSessionCookie(res);
        return res.status(404).json({ error: "Account not found" });
      }
      if (code === "queue_insert_failed") {
        console.error("[AUTH] Account deletion aborted: queue insert failed");
        return res.status(500).json({ error: "Failed to delete account" });
      }
      if (code === "delete_in_progress") {
        return res.status(409).json({ error: "Account deletion already in progress" });
      }
      console.error("Error deleting account:", error);
      res.status(500).json({ error: "Failed to delete account" });
    }
  });

  // ============================================
  // PASSKEY (WebAuthn) ROUTES
  // ============================================

  const RP_NAME = "StillHere";
  const getRpId = (req: Request): string => {
    const host = req.hostname;
    return host.includes("localhost") ? "localhost" : host;
  };
  const getOrigin = (req: Request): string => {
    return `${req.protocol}://${req.hostname}${req.hostname === "localhost" ? ":5000" : ""}`;
  };

  const challengeStore = new Map<string, { challenge: string; expiresAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of Array.from(challengeStore.entries())) {
      if (now > v.expiresAt) challengeStore.delete(k);
    }
  }, 60_000);

  app.post("/api/auth/passkey/register-options", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const user = (req as any).user;
      const existingPasskeys = await storage.getPasskeysByUserId(userId);

      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: getRpId(req),
        userName: user.phone || user.name || userId,
        userDisplayName: user.name || "StillHere User",
        userID: new TextEncoder().encode(userId),
        attestationType: "none",
        excludeCredentials: existingPasskeys.map((pk) => ({
          id: pk.credentialId,
          transports: pk.transports ? (JSON.parse(pk.transports) as AuthenticatorTransport[]) : undefined,
        })),
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "preferred",
        },
      });

      challengeStore.set(`reg:${userId}`, {
        challenge: options.challenge,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      res.json(options);
    } catch (error) {
      console.error("Error generating passkey registration options:", error);
      res.status(500).json({ error: "Failed to generate options" });
    }
  });

  app.post("/api/auth/passkey/register-verify", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const stored = challengeStore.get(`reg:${userId}`);
      if (!stored) return res.status(400).json({ error: "No challenge found. Please try again." });
      challengeStore.delete(`reg:${userId}`);

      const verification = await verifyRegistrationResponse({
        response: req.body,
        expectedChallenge: stored.challenge,
        expectedOrigin: getOrigin(req),
        expectedRPID: getRpId(req),
      });

      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ error: "Verification failed" });
      }

      const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

      await storage.createPasskey({
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: req.body.response?.transports ? JSON.stringify(req.body.response.transports) : undefined,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
      });

      console.log(`[AUTH] Passkey registered for user ${userId}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Error verifying passkey registration:", error);
      res.status(500).json({ error: "Failed to verify registration" });
    }
  });

  app.post("/api/auth/passkey/auth-options", authLimiter, async (req, res) => {
    try {
      const options = await generateAuthenticationOptions({
        rpID: getRpId(req),
        userVerification: "preferred",
      });

      const txnId = randomBytes(32).toString("hex");
      challengeStore.set(`auth:${txnId}`, {
        challenge: options.challenge,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      res.cookie("__passkey_txn", txnId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 5 * 60 * 1000,
        path: "/",
      });

      res.json(options);
    } catch (error) {
      console.error("Error generating passkey auth options:", error);
      res.status(500).json({ error: "Failed to generate options" });
    }
  });

  app.post("/api/auth/passkey/auth-verify", authLimiter, async (req, res) => {
    try {
      const txnId = req.cookies?.["__passkey_txn"];
      if (!txnId) return res.status(400).json({ error: "Session expired. Please try again." });

      const stored = challengeStore.get(`auth:${txnId}`);
      if (!stored) return res.status(400).json({ error: "Challenge expired. Please try again." });
      challengeStore.delete(`auth:${txnId}`);
      res.clearCookie("__passkey_txn", { path: "/" });

      const credentialId = req.body.id;
      const passkey = await storage.getPasskeyByCredentialId(credentialId);
      if (!passkey) return res.status(400).json({ error: "Passkey not found" });

      const verification = await verifyAuthenticationResponse({
        response: req.body,
        expectedChallenge: stored.challenge,
        expectedOrigin: getOrigin(req),
        expectedRPID: getRpId(req),
        credential: {
          id: passkey.credentialId,
          publicKey: Buffer.from(passkey.publicKey, "base64url"),
          counter: passkey.counter,
          transports: passkey.transports ? (JSON.parse(passkey.transports) as AuthenticatorTransport[]) : undefined,
        },
      });

      if (!verification.verified) {
        return res.status(401).json({ error: "Authentication failed" });
      }

      await storage.updatePasskeyCounter(passkey.credentialId, verification.authenticationInfo.newCounter);

      const user = await storage.getUser(passkey.userId);
      if (!user) return res.status(401).json({ error: "User not found" });

      const sessionToken = randomBytes(32).toString("hex");
      const expiresAt = addDays(new Date(), 30);

      await db.insert(authSessions).values({
        userId: user.id,
        token: sessionToken,
        expiresAt,
      });

      setSessionCookie(res, sessionToken);

      const needsSetup = !user.name || user.name.trim() === "";

      console.log(`[AUTH] Passkey login for user ***${(user.phone || user.id).slice(-4)}`);

      res.json({
        success: true,
        userId: user.id,
        isNewUser: false,
        needsSetup,
      });
    } catch (error) {
      console.error("Error verifying passkey auth:", error);
      res.status(500).json({ error: "Failed to verify authentication" });
    }
  });

  app.get("/api/auth/passkeys", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const pks = await storage.getPasskeysByUserId(userId);
      res.json(pks.map((pk) => ({
        id: pk.id,
        deviceType: pk.deviceType,
        backedUp: pk.backedUp,
        createdAt: pk.createdAt,
      })));
    } catch (error) {
      console.error("Error listing passkeys:", error);
      res.status(500).json({ error: "Failed to list passkeys" });
    }
  });

  app.delete("/api/auth/passkeys/:id", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      await storage.deletePasskey(req.params.id, userId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting passkey:", error);
      res.status(500).json({ error: "Failed to delete passkey" });
    }
  });

  // ============================================
  // USER SETUP (requires auth)
  // ============================================
  
  // Update user profile (name setup)
  app.post("/api/setup", async (req, res) => {
    try {
      const userId = getUserId(req);
      
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      
      const { name } = req.body;
      
      if (!name || typeof name !== "string" || name.trim() === "") {
        return res.status(400).json({ error: "Name is required" });
      }
      
      const cleanName = name
        .replace(/[\x00-\x1F\x7F]/g, "")
        .trim()
        .slice(0, 80);
      
      if (cleanName === "") {
        return res.status(400).json({ error: "Name is required" });
      }
      
      // Update user name
      const { eq } = await import("drizzle-orm");
      const [updatedUser] = await db
        .update(users)
        .set({ name: cleanName })
        .where(eq(users.id, userId))
        .returning();
      
      console.log(`[AUTH] User setup complete for ***${(updatedUser.phone || updatedUser.id).slice(-4)}`);
      
      res.json({ success: true, user: updatedUser });
    } catch (error) {
      console.error("Error setting up user:", error);
      res.status(500).json({ error: "Failed to setup user" });
    }
  });

  // ============================================
  // PROTECTED ROUTES (require auth)
  // ============================================

  app.post("/api/heartbeat", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const { lat, lng, acc, batt, chg, net, tz } = req.body || {};

      // Compute server-side tracking policy. If native tracking is NOT
      // allowed, strip lat/lng/acc from this heartbeat — even if the client
      // sent them. Server is authoritative; the client cooperates as a first
      // line of defense, but we never trust it.
      const policy = await getTrackingPolicyForUser(userId);
      let safeLat = typeof lat === "number" ? lat : undefined;
      let safeLng = typeof lng === "number" ? lng : undefined;
      let safeAcc = typeof acc === "number" ? acc : undefined;
      if (!policy.nativeTrackingAllowed && (safeLat !== undefined || safeLng !== undefined)) {
        console.warn(`[TRACKING_POLICY] heartbeat location stripped userId=${userId} reason=${policy.reason}`);
        safeLat = undefined;
        safeLng = undefined;
        safeAcc = undefined;
      }

      await storage.recordHeartbeat(
        userId,
        safeLat,
        safeLng,
        safeAcc,
        typeof batt === "number" ? batt : undefined,
        typeof chg === "boolean" ? chg : undefined,
        typeof net === "string" ? net : undefined,
      );
      if (safeLat !== undefined && safeLng !== undefined) {
        evaluateGeofenceTransitions(userId, safeLat, safeLng).catch((err: any) => {
          console.error(`[GEOFENCE] heartbeat evaluation failed for user=${userId}:`, err?.message || err);
        });
      }
      let user = await storage.getUser(userId);
      if (typeof tz === "string" && tz.includes("/") && user && user.timezone !== tz) {
        await storage.updateUser(userId, { timezone: tz });
        user = { ...user, timezone: tz };
      }
      if (user?.safetyState === "quiet") {
        const openIncident = await storage.getOpenIncident(userId);
        if (openIncident) {
          console.log(`[HEARTBEAT] User ${userId} resumed with open incident  -  routing through resolveCheckin`);
          await resolveCheckin(userId, "app");
        } else {
          await storage.updateSafetyState(userId, "active", "Heartbeat resumed");
          console.log(`[HEARTBEAT] Safety state restored for ${userId}: quiet → active (no incident)`);
          notifyRecovery(userId, user.name, "user", undefined, "heartbeat").catch((err) => {
            console.error(`[HEARTBEAT] notifyRecovery failed for ${userId}:`, err?.message || err);
          });
        }
      }
      res.json({ ok: true });
    } catch (error) {
      console.error("Error recording heartbeat:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/concern/resolve", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const openIncident = await storage.getOpenIncident(userId);
      if (user.safetyState !== "concern" && user.safetyState !== "quiet" && !openIncident) {
        console.log(`[RESOLVE] Concern resolve skipped for user=${userId}: safetyState=${user.safetyState}, no open incident`);
        return res.json({ success: true, alreadySafe: true });
      }

      const result = await resolveCheckin(userId, "app");
      console.log(`[RESOLVE] Concern self-resolve: user=${userId}, hadIncident=${result.hadIncident}`);

      res.json({ success: true });
    } catch (error) {
      console.error("Error resolving concern:", error);
      res.status(500).json({ error: "Failed to resolve concern" });
    }
  });

  app.post("/api/concern/resolve-watcher/:userId", async (req, res) => {
    try {
      const watcherId = getUserId(req);
      if (!watcherId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const targetUserId = req.params.userId;
      const linkedContacts = await storage.getContactsLinkedToUser(targetUserId);
      const isWatcher = linkedContacts.some(c => c.linkedUserId === watcherId);
      if (!isWatcher) return res.status(403).json({ error: "Not authorized" });

      const user = await storage.getUser(targetUserId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const openIncident = await storage.getOpenIncident(targetUserId);
      if (user.safetyState !== "concern" && user.safetyState !== "quiet" && !openIncident) {
        console.log(`[RESOLVE] Watcher resolve skipped for user=${targetUserId}: safetyState=${user.safetyState}, no open incident`);
        return res.json({ success: true, alreadySafe: true });
      }

      const watcher = await storage.getUser(watcherId);
      const result = await resolveCheckin(targetUserId, "app", {
        resolvedBy: "watcher",
        resolverName: watcher?.name || undefined,
      });
      console.log(`[RESOLVE] Watcher resolve: user=${targetUserId} marked safe by watcher=${watcherId}, hadIncident=${result.hadIncident}`);

      emitToUser(targetUserId, "concern:resolved", {
        userId: targetUserId,
        resolvedBy: "watcher",
        resolvedByName: watcher?.name,
        resolvedAt: new Date().toISOString(),
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error resolving concern as watcher:", error);
      res.status(500).json({ error: "Failed to resolve concern" });
    }
  });

  app.get("/api/concern/timeline/:userId", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const targetUserId = req.params.userId;
      const isSelf = currentUserId === targetUserId;
      if (!isSelf) {
        const linkedContacts = await storage.getContactsLinkedToUser(targetUserId);
        const isWatcher = linkedContacts.some(c => c.linkedUserId === currentUserId);
        if (!isWatcher) return res.status(403).json({ error: "Not authorized" });
      }

      const user = await storage.getUser(targetUserId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const timeline: { type: string; time: string; detail: string }[] = [];

      if (user.safetyStateChangedAt) {
        timeline.push({
          type: "state_change",
          time: user.safetyStateChangedAt.toISOString(),
          detail: user.safetyState === "concern"
            ? "Concern triggered. No heartbeat received"
            : user.safetyState === "quiet"
              ? "Went quiet. Waiting for response"
              : `Status: ${user.safetyState}. ${user.safetyStateReason || ""}`,
        });
      }

      const reminderTimeline = await storage.getReminderTimeline(targetUserId);
      for (const entry of reminderTimeline) {
        timeline.push(entry);
      }

      const openIncident = await storage.getOpenIncident(targetUserId);
      if (openIncident) {
        timeline.push({
          type: "incident",
          time: openIncident.startedAt.toISOString(),
          detail: openIncident.reason === "sos"
            ? "SOS alert triggered"
            : "Missed check-in alert triggered",
        });
      }

      timeline.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

      res.json({
        userId: targetUserId,
        userName: user.name,
        safetyState: user.safetyState,
        safetyStateReason: user.safetyStateReason,
        safetyStateChangedAt: user.safetyStateChangedAt,
        lastHeartbeatAt: user.lastHeartbeatAt,
        timeline,
      });
    } catch (error) {
      console.error("Error fetching concern timeline:", error);
      res.status(500).json({ error: "Failed to fetch concern timeline" });
    }
  });

  // Get user status
  app.get("/api/status", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const status = await storage.getUserStatus(userId);
      res.json(status);
    } catch (error) {
      console.error("Error getting status:", error);
      res.status(500).json({ error: "Failed to get status" });
    }
  });

  // Check in
  app.post("/api/checkin", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const method = req.body?.method === "auto" ? "auto" : "button";
      let location: { lat?: number; lng?: number; timezone?: string } = {};
      if (req.body?.lat != null && req.body?.lng != null) {
        const lat = parseFloat(req.body.lat);
        const lng = parseFloat(req.body.lng);
        if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
          location.lat = lat;
          location.lng = lng;
        }
      }
      if (req.body?.timezone && typeof req.body.timezone === "string" && req.body.timezone.length <= 100) {
        location.timezone = req.body.timezone;
      }
      const hasLocation = location.lat != null || location.timezone;
      const checkin = await storage.createCheckin(userId, method, hasLocation ? location as any : undefined);
      
      // Reset reminder state when user checks in
      await storage.resetReminderState(userId);

      const user = await storage.getUser(userId);
      if (user && (user.safetyState === "concern" || user.safetyState === "quiet")) {
        console.log(`[CHECKIN] User user=${userId} checked in while safetyState=${user.safetyState}  -  routing through resolveCheckin`);
        await resolveCheckin(userId, "app", { skipCreateCheckin: true });
      } else {
        const openIncident = await storage.getOpenIncident(userId);
        if (openIncident) {
          console.log(`[CHECKIN] User user=${userId} checked in with open incident (state=${user?.safetyState})  -  routing through resolveCheckin`);
          await resolveCheckin(userId, "app", { skipCreateCheckin: true });
        }
      }
      
      res.json({ success: true, checkin });
    } catch (error) {
      console.error("Error checking in:", error);
      res.status(500).json({ error: "Failed to check in" });
    }
  });

  // SOS - immediate incident (supports both cookie auth and bearer token for watch)
  app.post("/api/sos", async (req, res) => {
    try {
      let userId = getUserId(req);
      if (!userId) {
        const bearerToken = req.headers["authorization"]?.replace("Bearer ", "");
        if (bearerToken) {
          const result = await getUserFromSession(bearerToken);
          if (result) userId = result.userId;
        }
      }
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }

      // STEP 1 - synchronous in-flight lock. This runs to completion before any
      // await yields, so two concurrent SOS taps from the same user cannot both
      // pass this gate. Without this, a TOCTOU race on getOpenIncident lets 3
      // rapid presses each create their own incident and each fire emails/SMS.
      const nowMs = Date.now();
      const inFlightAt = sosInFlightByUser.get(userId);
      if (inFlightAt && nowMs - inFlightAt < SOS_INFLIGHT_TTL_MS) {
        // A SOS from this user is already in flight or was just processed.
        // Look up the existing incident (best-effort) and return without
        // touching any notification channel. No new incident, no emails,
        // no SMS, no calls.
        const existing = await storage.getOpenIncident(userId).catch(() => undefined);
        if (existing) {
          // Append a timeline entry so the repeat press is on record.
          try {
            const timeline: any[] = (() => {
              try { return JSON.parse(existing.escalationTimeline || "[]"); } catch { return []; }
            })();
            timeline.push({
              type: "sos_repeat_press",
              time: new Date().toISOString(),
              detail: "SOS button pressed again",
            });
            await storage.updateIncident(existing.id, {
              escalationTimeline: JSON.stringify(timeline),
            });
          } catch (e) {
            console.error("[SOS] Failed to log repeat press to timeline:", e);
          }
        }
        console.log(`[SOS] Suppressed duplicate press for user=${userId} (in-flight lock, ${nowMs - inFlightAt}ms after first press)`);
        return res.json({
          success: true,
          incident: existing || null,
          alreadyActive: true,
          deduped: true,
          message: "Help request already active. We are still contacting your Safety Circle.",
        });
      }
      // Claim the lock NOW, before any await. This is the critical line.
      sosInFlightByUser.set(userId, nowMs);
      // Auto-expire so a future legitimate SOS isn't blocked.
      setTimeout(() => {
        const v = sosInFlightByUser.get(userId);
        if (v === nowMs) sosInFlightByUser.delete(userId);
      }, SOS_INFLIGHT_TTL_MS).unref?.();

      // STEP 2 - DB-level dedup as a backstop (covers the case where the in-memory
      // lock has expired but an incident from a prior press is still open).
      const existingIncident = await storage.getOpenIncident(userId);
      if (existingIncident) {
        // If the prior incident has had no escalation activity for a long time
        // it is almost certainly stuck open from a past session that never got
        // resolved. Without this, every future SOS press for this user would
        // be silently swallowed as a "duplicate" and no contact would ever be
        // notified. Auto-resolve the stale one and fall through to create a
        // fresh incident so this press actually pages the Safety Circle.
        const lastTouchedMs = existingIncident.lastContactNotifiedAt
          ? new Date(existingIncident.lastContactNotifiedAt).getTime()
          : new Date(existingIncident.startedAt).getTime();
        const stalenessMs = Date.now() - lastTouchedMs;
        const STALE_INCIDENT_MS = 30 * 60_000; // 30 minutes
        if (stalenessMs > STALE_INCIDENT_MS) {
          try {
            const timeline: any[] = (() => {
              try { return JSON.parse(existingIncident.escalationTimeline || "[]"); } catch { return []; }
            })();
            timeline.push({
              type: "auto_archived",
              time: new Date().toISOString(),
              detail: `Auto-resolved stale open incident before starting a fresh SOS (${Math.round(stalenessMs / 60_000)} min since last activity)`,
            });
            await storage.updateIncident(existingIncident.id, {
              status: "resolved",
              resolvedAt: new Date(),
              escalationTimeline: JSON.stringify(timeline),
            });
          } catch (e) {
            console.error("[SOS] Failed to auto-resolve stale incident:", e);
          }
          console.log(`[SOS] Auto-archived stale open incident ${existingIncident.id} for user=${userId} (${Math.round(stalenessMs / 60_000)}min stale); proceeding with fresh SOS`);
          // Fall through to the new-incident creation path below.
        } else {
          const ageMs = Date.now() - new Date(existingIncident.startedAt).getTime();
          const COOLDOWN_MS = 60_000;
          if (ageMs >= COOLDOWN_MS) {
            try {
              const timeline: any[] = (() => {
                try { return JSON.parse(existingIncident.escalationTimeline || "[]"); } catch { return []; }
              })();
              timeline.push({
                type: "sos_repeat_press",
                time: new Date().toISOString(),
                detail: "SOS button pressed again",
              });
              await storage.updateIncident(existingIncident.id, {
                escalationTimeline: JSON.stringify(timeline),
              });
            } catch (e) {
              console.error("[SOS] Failed to log repeat press to timeline:", e);
            }
          }
          return res.json({
            success: true,
            incident: existingIncident,
            alreadyActive: true,
            deduped: true,
            cooldownActive: ageMs < COOLDOWN_MS,
            message: ageMs < COOLDOWN_MS
              ? "SOS already active. Your Safety Circle is being contacted right now."
              : "SOS already active. We are still contacting your Safety Circle.",
          });
        }
      }
      
      // Capture moment-of-SOS location from request body if provided
      const sosLat = typeof req.body?.lat === "number" && isFinite(req.body.lat) ? req.body.lat : null;
      const sosLng = typeof req.body?.lng === "number" && isFinite(req.body.lng) ? req.body.lng : null;
      const sosAccuracy = typeof req.body?.accuracy === "number" && isFinite(req.body.accuracy) ? req.body.accuracy : null;
      const hasLocation = sosLat !== null && sosLng !== null;

      // Create SOS incident and set safety state to concern
      let incident = await storage.createIncident(userId, "sos");
      await storage.updateSafetyState(userId, "concern", "SOS triggered");
      emitTrackingPolicyChanged(userId, "sos_open").catch(() => {});

      // Auto-post into family chat with push fan-out (best-effort, never blocks SOS).
      // Done early so family is paged even if downstream contact escalation hits errors.
      const sosUser = await storage.getUser(userId);
      broadcastToFamily(
        userId,
        `${sosUser?.name || "A family member"} triggered SOS. Please check on them right now.`,
        "panic",
        hasLocation ? { lat: sosLat, lng: sosLng, kind: "sos" } : { kind: "sos" },
        {
          title: `SOS: ${sosUser?.name || "Family member"}`,
          body: "SOS triggered. Tap to open the family map.",
          url: "/family",
          tag: "family-sos",
        },
      ).catch(() => {});

      // Snapshot moment-of-SOS location to user record so the emergency page
      // has it immediately. The open SOS incident above grants a real safety
      // purpose, so policy normally allows; only explicit paused/off settings
      // will short-circuit the snapshot.
      if (hasLocation) {
        const sosPolicy = await getTrackingPolicyForUser(userId);
        if (sosPolicy.nativeTrackingAllowed) {
          await db.update(users).set({
            lastLat: sosLat,
            lastLng: sosLng,
            lastLocationAt: new Date(),
          }).where(eq(users.id, userId));
        } else {
          console.log(`[TRACKING_POLICY] SOS lat/lng snapshot stripped (policy deny)`);
        }
      }

      // Get contacts sorted by priority
      const contacts = (await storage.getContacts(userId)).filter(isContactActiveForAlerts);
      const settings = await storage.getSettings(userId);

      // Create location session if allowed, seeded with the moment-of-SOS coordinates
      if (settings?.locationMode === "emergency_only" || settings?.locationMode === "both") {
        await storage.createLocationSession(
          userId,
          "emergency",
          incident.id,
          hasLocation ? { lat: sosLat!, lng: sosLng!, accuracy: sosAccuracy } : undefined,
        );
      }
      
      // Phase 2: incident-scoped tokens, fresh per incident, reused within it.
      const tokens = await storage.getOrMintIncidentTokensForUser(userId, incident.startedAt);
      const user = await storage.getUser(userId);
      const baseUrl = getBaseUrl();
      
      const now = new Date();
      const sortedContacts = [...contacts].sort((a, b) => a.priority - b.priority);
      const firstContact = sortedContacts[0];
      
      if (firstContact) {
        const token = tokens.find(t => t.contact.id === firstContact.id);
        if (token) {
          const link = `${baseUrl}/emergency/${token.token}`;
          console.log(`[SOS] Alerting Contact #${firstContact.priority}`);
          await notifyContact(firstContact, user?.name || "User", link, "sos", sendSosAlert, { incidentId: incident.id, ipAddress: req.ip });
          console.log("[SOS] Alert sent\n");
        }
      }
      
      const sosSettings = await storage.getSettings(userId);
      incident = await storage.updateIncident(incident.id, {
        escalationLevel: 1,
        lastEscalationStep: "contact_1",
        notifiedContactIds: JSON.stringify(firstContact ? [firstContact.id] : []),
        lastContactNotifiedAt: now,
        contact1NotifiedAt: now,
        nextActionAt: addMinutes(now, sosSettings?.escalationMinutes || 20),
      });
      
      notifyConcern(userId, user?.name || "Someone", "sos").catch((err) => {
        console.error(`[SOS] notifyConcern failed for user=${userId}:`, err?.message || err);
      });

      res.json({ success: true, incident });
    } catch (error) {
      console.error("Error sending SOS:", error);
      res.status(500).json({ error: "Failed to send SOS" });
    }
  });

  app.post("/api/resolve-alert", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      
      const openIncident = await storage.getOpenIncident(userId);
      if (!openIncident) {
        return res.status(404).json({ error: "No active alert" });
      }
      
      const result = await resolveCheckin(userId, "app");
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error resolving alert:", error);
      res.status(500).json({ error: "Failed to resolve alert" });
    }
  });

  // Update settings
  app.post("/api/settings", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const { checkinIntervalHours, graceMinutes, locationMode, reminderMode, preferredCheckinTime, timezone, autoCheckin, fallDetection, discreetSos, smsCheckinEnabled, escalationMinutes, allowReports, drivingSafety, speedLimitKmh, autoWellnessCall } = req.body;
      
      if (checkinIntervalHours !== undefined && (typeof checkinIntervalHours !== "number" || checkinIntervalHours < 24 || checkinIntervalHours > 168)) {
        return res.status(400).json({ error: "Checkin interval must be between 24 and 168 hours" });
      }
      if (graceMinutes !== undefined && (typeof graceMinutes !== "number" || graceMinutes < 10 || graceMinutes > 30)) {
        return res.status(400).json({ error: "Grace period must be between 10 and 30 minutes" });
      }
      if (locationMode !== undefined && !["off", "emergency_only", "on_shift_only", "both"].includes(locationMode)) {
        return res.status(400).json({ error: "Invalid location mode" });
      }
      if (reminderMode !== undefined && !["none", "one", "two"].includes(reminderMode)) {
        return res.status(400).json({ error: "Invalid reminder mode" });
      }
      if (autoCheckin !== undefined && typeof autoCheckin !== "boolean") {
        return res.status(400).json({ error: "Auto checkin must be a boolean" });
      }
      if (fallDetection !== undefined && typeof fallDetection !== "boolean") {
        return res.status(400).json({ error: "Fall sensing must be a boolean" });
      }
      if (discreetSos !== undefined && typeof discreetSos !== "boolean") {
        return res.status(400).json({ error: "Discreet SOS must be a boolean" });
      }
      if (smsCheckinEnabled !== undefined && typeof smsCheckinEnabled !== "boolean") {
        return res.status(400).json({ error: "SMS checkin must be a boolean" });
      }
      if (escalationMinutes !== undefined && (typeof escalationMinutes !== "number" || ![5, 10, 15, 20, 30, 45, 60].includes(escalationMinutes))) {
        return res.status(400).json({ error: "Escalation minutes must be 5, 10, 15, 20, 30, 45, or 60" });
      }
      if (allowReports !== undefined && typeof allowReports !== "boolean") {
        return res.status(400).json({ error: "Allow reports must be a boolean" });
      }
      if (drivingSafety !== undefined && typeof drivingSafety !== "boolean") {
        return res.status(400).json({ error: "Driving safety must be a boolean" });
      }
      if (speedLimitKmh !== undefined && (typeof speedLimitKmh !== "number" || speedLimitKmh < 20 || speedLimitKmh > 300)) {
        return res.status(400).json({ error: "Speed limit must be between 20 and 300 km/h" });
      }
      if (autoWellnessCall !== undefined && typeof autoWellnessCall !== "boolean") {
        return res.status(400).json({ error: "Auto wellness call must be a boolean" });
      }
      if (preferredCheckinTime !== undefined && (typeof preferredCheckinTime !== "string" || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(preferredCheckinTime))) {
        return res.status(400).json({ error: "Preferred check-in time must be HH:MM" });
      }
      if (timezone !== undefined) {
        if (typeof timezone !== "string" || timezone.length > 100 || !timezone.includes("/")) {
          return res.status(400).json({ error: "Invalid timezone" });
        }
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
        } catch {
          return res.status(400).json({ error: "Invalid timezone" });
        }
      }
      
      const updates: any = {};
      if (checkinIntervalHours !== undefined) updates.checkinIntervalHours = checkinIntervalHours;
      if (graceMinutes !== undefined) updates.graceMinutes = graceMinutes;
      if (locationMode !== undefined) updates.locationMode = locationMode;
      if (reminderMode !== undefined) updates.reminderMode = reminderMode;
      if (preferredCheckinTime !== undefined) updates.preferredCheckinTime = preferredCheckinTime;
      if (autoCheckin !== undefined) updates.autoCheckin = autoCheckin;
      if (fallDetection !== undefined) updates.fallDetection = fallDetection;
      if (discreetSos !== undefined) updates.discreetSos = discreetSos;
      if (smsCheckinEnabled !== undefined) updates.smsCheckinEnabled = smsCheckinEnabled;
      if (escalationMinutes !== undefined) updates.escalationMinutes = escalationMinutes;
      if (allowReports !== undefined) updates.allowReports = allowReports;
      if (drivingSafety !== undefined) updates.drivingSafety = drivingSafety;
      if (speedLimitKmh !== undefined) updates.speedLimitKmh = speedLimitKmh;
      if (autoWellnessCall !== undefined) updates.autoWellnessCall = autoWellnessCall;
      
      // Update user timezone if provided
      if (timezone) {
        await storage.updateUser(userId, { timezone });
      }
      
      const settings = await storage.updateSettings(userId, updates);
      const policy = await getTrackingPolicyForUser(userId);
      emitTrackingPolicyChanged(userId, "settings_update").catch(() => {});
      res.json({
        success: true,
        settings,
        nativeTrackingAllowed: policy.nativeTrackingAllowed,
        heartbeatAllowed: policy.heartbeatAllowed,
        reason: policy.reason,
      });
    } catch (error) {
      console.error("Error updating settings:", error);
      res.status(500).json({ error: "Failed to update settings" });
    }
  });

  // Pause alerts
  app.post("/api/settings/pause", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const { pauseUntil } = req.body;
      
      const settings = await storage.updateSettings(userId, {
        pauseUntil: pauseUntil ? new Date(pauseUntil) : null,
      });
      const policy = await getTrackingPolicyForUser(userId);
      emitTrackingPolicyChanged(userId, "settings_pause").catch(() => {});
      res.json({
        success: true,
        settings,
        nativeTrackingAllowed: policy.nativeTrackingAllowed,
        heartbeatAllowed: policy.heartbeatAllowed,
        reason: policy.reason,
      });
    } catch (error) {
      console.error("Error pausing alerts:", error);
      res.status(500).json({ error: "Failed to pause alerts" });
    }
  });

  app.post("/api/sharing-mode", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const { mode } = req.body;
      if (!["precise", "area", "presence", "paused"].includes(mode)) {
        return res.status(400).json({ error: "Invalid sharing mode" });
      }
      const user = await storage.updateUser(userId, { sharingMode: mode } as any);
      const policy = await getTrackingPolicyForUser(userId);
      emitTrackingPolicyChanged(userId, "sharing_mode").catch(() => {});
      res.json({
        success: true,
        sharingMode: user.sharingMode,
        nativeTrackingAllowed: policy.nativeTrackingAllowed,
        heartbeatAllowed: policy.heartbeatAllowed,
        reason: policy.reason,
      });
    } catch (error) {
      console.error("Error updating sharing mode:", error);
      res.status(500).json({ error: "Failed to update sharing mode" });
    }
  });

  app.post("/api/sleep-hours", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const { sleepStart, sleepEnd } = req.body;
      if (!sleepStart || !sleepEnd) return res.status(400).json({ error: "sleepStart and sleepEnd required" });
      const user = await storage.updateUser(userId, { sleepStart, sleepEnd } as any);
      res.json({ success: true, sleepStart: user.sleepStart, sleepEnd: user.sleepEnd });
    } catch (error) {
      console.error("Error updating sleep hours:", error);
      res.status(500).json({ error: "Failed to update sleep hours" });
    }
  });

  app.get("/api/my-protection", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      const userContacts = await storage.getContacts(userId);
      const watchers = userContacts.filter(c => !c.softDeletedAt).map(c => ({
        id: c.id,
        name: c.name,
        circleRole: c.circleRole || "primary",
        linkedUserId: c.linkedUserId,
      }));
      const isLearning = user.learningModeUntil ? new Date() < user.learningModeUntil : false;
      const learningDaysLeft = isLearning && user.learningModeUntil
        ? Math.ceil((user.learningModeUntil.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : 0;
      res.json({
        sharingMode: user.sharingMode || "precise",
        watchers,
        sleepStart: user.sleepStart || "22:30",
        sleepEnd: user.sleepEnd || "07:00",
        isLearning,
        learningDaysLeft,
        setupConfirmed: !!user.setupConfirmedAt,
      });
    } catch (error) {
      console.error("Error fetching protection info:", error);
      res.status(500).json({ error: "Failed to fetch protection info" });
    }
  });

  app.get("/api/guardian-view-preview", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      const userSettings = await storage.getSettings(userId);
      const lastCheckin = await storage.getLastCheckin(userId);
      const openIncident = await storage.getOpenIncident(userId);
      const mode = (user.sharingMode as string) || "precise";
      const isConcern = user.safetyState === "concern";
      const hideLocation = (mode === "presence" || mode === "paused") && !isConcern;
      const obfuscateLocation = mode === "area" && !isConcern;

      const obfuscateCoordPreview = (value: number, seed: string): number => {
        let hash = 0;
        for (let i = 0; i < seed.length; i++) {
          hash = ((hash << 5) - hash) + seed.charCodeAt(i);
          hash |= 0;
        }
        const offset = ((hash % 2000) - 1000) / 100000;
        return Math.round((value + offset) * 100) / 100;
      }

      const rawLat = user.lastHeartbeatLat ? Number(user.lastHeartbeatLat) : null;
      const rawLng = user.lastHeartbeatLng ? Number(user.lastHeartbeatLng) : null;

      res.json({
        userName: user.name,
        safetyState: user.safetyState,
        safetyStateReason: user.safetyStateReason,
        sharingMode: mode,
        lastCheckinAt: lastCheckin?.createdAt || null,
        hasOpenIncident: !!openIncident,
        lastHeartbeatAt: user.lastHeartbeatAt || null,
        lastHeartbeatLat: hideLocation ? null : obfuscateLocation && rawLat != null ? obfuscateCoordPreview(rawLat, userId + "lat") : (rawLat ?? null),
        lastHeartbeatLng: hideLocation ? null : obfuscateLocation && rawLng != null ? obfuscateCoordPreview(rawLng, userId + "lng") : (rawLng ?? null),
        batteryLevel: user.batteryLevel ?? null,
        batteryCharging: user.batteryCharging ?? null,
        networkType: user.networkType ?? null,
      });
    } catch (error) {
      console.error("Error fetching guardian view preview:", error);
      res.status(500).json({ error: "Failed to fetch guardian view" });
    }
  });

  app.post("/api/contacts/:contactId/role", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const contactId = String(req.params.contactId);
      const { role } = req.body;
      if (!["primary", "backup", "support"].includes(role)) {
        return res.status(400).json({ error: "Invalid role" });
      }
      const contact = await storage.getContact(contactId);
      if (!contact || contact.userId !== userId) {
        return res.status(404).json({ error: "Contact not found" });
      }
      const [updated] = await db.update(contacts).set({ circleRole: role }).where(eq(contacts.id, contactId)).returning();
      res.json({ success: true, contact: updated });
    } catch (error) {
      console.error("Error updating contact role:", error);
      res.status(500).json({ error: "Failed to update role" });
    }
  });

  app.post("/api/incidents/:incidentId/claim", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const { incidentId } = req.params;
      const incident = await db.select().from(incidents).where(eq(incidents.id, incidentId)).limit(1);
      if (!incident.length) return res.status(404).json({ error: "Incident not found" });
      if (incident[0].status === "resolved") return res.status(400).json({ error: "Already resolved" });
      if (incident[0].claimedByContactId) return res.status(400).json({ error: "Already claimed" });

      const linkedContacts = await db.select().from(contacts).where(
        and(
          eq(contacts.userId, incident[0].userId),
          eq(contacts.linkedUserId, userId),
          eq(contacts.watcherConsentStatus, "accepted"),
          isNull(contacts.softDeletedAt),
        )
      );
      if (!linkedContacts.length) return res.status(403).json({ error: "Not authorized" });

      const [updated] = await db.update(incidents).set({
        claimedByContactId: linkedContacts[0].id,
        claimedAt: new Date(),
      }).where(eq(incidents.id, incidentId)).returning();

      const claimer = await storage.getUser(userId);
      const otherWatchers = await storage.getContactsLinkedToUser(incident[0].userId);
      for (const wc of otherWatchers) {
        if (wc.linkedUserId && wc.linkedUserId !== userId) {
          await sendPushNotification(wc.linkedUserId, {
            title: "Being handled",
            body: `${claimer?.name || "Someone"} is handling this now. No action needed from you.`,
            url: "/watched",
            tag: `claim-${incidentId}`,
          });
        }
      }
      const { emitToUser } = await import("./socket");
      emitToUser(incident[0].userId, "incident:claimed", { incidentId, claimedBy: claimer?.name });
      for (const wc of otherWatchers) {
        if (wc.linkedUserId) emitToUser(wc.linkedUserId, "incident:claimed", { incidentId, claimedBy: claimer?.name });
      }

      console.log(`[CLAIM] Incident ${incidentId} claimed by user=${userId}`);
      res.json({ success: true, incident: updated });
    } catch (error) {
      console.error("Error claiming incident:", error);
      res.status(500).json({ error: "Failed to claim incident" });
    }
  });

  app.post("/api/safety-drill", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      // Per-user (2/h, 5/d) and per-IP (4/h) drill limit, plus a 30-minute
      // per-user cooldown. Enforced via the outbound policy so it survives
      // restarts and applies across all process replicas.
      const policy = await import("./outbound-policy");
      const drillDecision = await policy.enforceSendPolicy({
        channel: "push",
        purpose: "safety_drill",
        destination: `user:${userId}`,
        userId,
        ipAddress: req.ip,
        dedupeKey: `drill:${userId}:${Math.floor(Date.now() / (30 * 60 * 1000))}`,
      });
      if (!drillDecision.allowed) {
        return res.status(429).json({
          error: "You ran a drill recently. Please wait a bit before running another.",
          reason: drillDecision.reason,
          retryAfterSeconds: drillDecision.retryAfterSeconds,
        });
      }

      const existingOpen = await storage.getOpenIncident(userId);
      if (existingOpen && !existingOpen.isDrill) {
        return res.status(400).json({ error: "Your Safety Circle is currently responding to an active alert. Please wait until it's resolved before running a test." });
      }
      if (existingOpen && existingOpen.isDrill) {
        await db.update(incidents).set({ status: "resolved", resolvedAt: new Date() }).where(eq(incidents.id, existingOpen.id));
      }

      const [drill] = await db.insert(incidents).values({
        userId,
        status: "open",
        reason: "test",
        isDrill: true,
        startedAt: new Date(),
      }).returning();

      const watcherContacts = await storage.getContactsLinkedToUser(userId);
      for (const wc of watcherContacts) {
        if (wc.linkedUserId && wc.linkedUserId !== userId) {
          await sendPushNotification(wc.linkedUserId, {
            title: `[StillHere TEST] ${user.name} is testing their Safety Circle`,
            body: `This is a drill, not a real alert. ${user.name} wants to make sure you're ready. Tap to confirm you've got their back.`,
            url: `/watched?drill=${drill.id}`,
            tag: `drill-${drill.id}`,
          }, { purpose: "safety_drill", incidentId: drill.id, dedupeKey: `drill:${drill.id}:${wc.linkedUserId}` });
        }
      }

      setTimeout(async () => {
        try {
          const current = await db.select().from(incidents).where(eq(incidents.id, drill.id)).limit(1);
          if (current.length && current[0].status === "open") {
            await db.update(incidents).set({ status: "resolved", resolvedAt: new Date() }).where(eq(incidents.id, drill.id));
            const acknowledged = current[0].drillAcknowledgedByContactId != null;
            for (const wc of watcherContacts) {
              if (wc.linkedUserId && wc.linkedUserId !== userId) {
                await sendPushNotification(wc.linkedUserId, {
                  title: "Safety Circle ready",
                  body: `You're all set. If ${user.name} ever needs you, we'll guide you just like this.`,
                  url: "/watched",
                  tag: `drill-done-${drill.id}`,
                });
              }
            }
            await sendPushNotification(userId, {
              title: "Your Safety Circle is ready",
              body: acknowledged
                ? "Your Safety Circle is ready. If you ever need them, they'll know exactly what to do."
                : "Your Safety Circle has been tested. If you ever need them, they'll know exactly what to do.",
              url: "/",
              tag: `drill-done-${drill.id}`,
            });
          }
        } catch (err) {
          console.error("[DRILL] Auto-resolve error:", err);
        }
      }, 60000);

      console.log(`[DRILL] Safety drill started by user=${userId}, incidentId=${drill.id}`);
      res.json({ success: true, drillId: drill.id });
    } catch (error) {
      console.error("Error starting safety drill:", error);
      res.status(500).json({ error: "Failed to start drill" });
    }
  });

  app.post("/api/safety-drill/:drillId/acknowledge", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const drillId = req.params.drillId;

      const ackResult = await db.transaction(async (tx) => {
        const lockResult = await tx.execute(sql`SELECT id, user_id, status, is_drill, started_at, drill_responses, drill_acknowledged_by_contact_id FROM incidents WHERE id = ${drillId} FOR UPDATE`);
        const locked: any = (lockResult as any).rows?.[0];
        if (!locked || !locked.is_drill) return { error: { status: 404, body: { error: "This safety test is no longer available." } } };
        if (locked.status !== "open") return { error: { status: 400, body: { error: "This safety test has already finished." } } };

        const contactList = await storage.getContacts(locked.user_id);
        const watcherContact = contactList.find(c => c.linkedUserId === userId);
        if (!watcherContact || watcherContact.watcherConsentStatus !== "accepted") {
          return { error: { status: 403, body: { error: "Not an accepted watcher for this user" } } };
        }

        let responses: Array<{ contactId: string; contactName: string; role: string; respondedAt: string; responseTimeMs: number }> = [];
        try {
          const parsed = JSON.parse(locked.drill_responses || "[]");
          responses = Array.isArray(parsed)
            ? parsed.filter((r: any) => r && typeof r === "object" && typeof r.contactId === "string")
            : [];
        } catch {
          responses = [];
        }
        if (responses.some(r => r.contactId === watcherContact.id)) {
          return { error: { status: 400, body: { error: "You've already confirmed for this drill.", alreadyAcknowledged: true } } };
        }

        const respondedAt = new Date();
        const startedAtMs = locked.started_at ? new Date(locked.started_at).getTime() : respondedAt.getTime();
        responses.push({
          contactId: watcherContact.id,
          contactName: watcherContact.name,
          role: (watcherContact.circleRole as string) || "primary",
          respondedAt: respondedAt.toISOString(),
          responseTimeMs: Math.max(0, respondedAt.getTime() - startedAtMs),
        });

        const updates: any = { drillResponses: JSON.stringify(responses) };
        if (!locked.drill_acknowledged_by_contact_id) {
          updates.drillAcknowledgedAt = respondedAt;
          updates.drillAcknowledgedByContactId = watcherContact.id;
        }
        await tx.update(incidents).set(updates).where(eq(incidents.id, drillId));
        return { ok: { drillUserId: locked.user_id as string, watcherContact, responses, respondedAt } };
      });

      if ("error" in ackResult && ackResult.error) {
        return res.status(ackResult.error.status).json(ackResult.error.body);
      }
      const okResult = (ackResult as any).ok;
      const drill = { id: drillId, userId: okResult.drillUserId };
      const watcherContact = okResult.watcherContact;
      const responses = okResult.responses;
      const respondedAt: Date = okResult.respondedAt;
      const watcherUser = await storage.getUser(userId);
      const watcherName = watcherUser?.name || watcherContact.name;

      await sendPushNotification(drill.userId, {
        title: "Guardian ready",
        body: `${watcherName} confirmed they're ready. Your Safety Circle is prepared.`,
        url: `/safety-circle/drill?id=${drillId}`,
        tag: `drill-ack-${drillId}`,
      });

      const io = (req as any).io;
      if (io) {
        io.to(`user:${drill.userId}`).emit("drill:acknowledged", {
          drillId,
          acknowledgedBy: watcherName,
          acknowledgedAt: respondedAt.toISOString(),
          responseCount: responses.length,
        });
      }

      console.log(`[DRILL] Acknowledged by ${userId} for drill ${drillId} (response ${responses.length})`);
      res.json({ success: true, responseCount: responses.length });
    } catch (error) {
      console.error("Error acknowledging drill:", error);
      res.status(500).json({ error: "Failed to acknowledge drill" });
    }
  });

  app.get("/api/safety-drill/:drillId", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const drillId = req.params.drillId;
      const [drill] = await db.select().from(incidents).where(eq(incidents.id, drillId)).limit(1);
      if (!drill || !drill.isDrill) return res.status(404).json({ error: "Drill not found" });

      const isOwner = drill.userId === userId;
      let isLinkedWatcher = false;
      if (!isOwner) {
        const contactList = await storage.getContacts(drill.userId);
        isLinkedWatcher = contactList.some(c => c.linkedUserId === userId && c.watcherConsentStatus === "accepted");
      }
      if (!isOwner && !isLinkedWatcher) return res.status(403).json({ error: "Forbidden" });

      let responses: Array<{ contactId: string; contactName: string; role: string; respondedAt: string; responseTimeMs: number }> = [];
      try {
        const parsed = JSON.parse(drill.drillResponses || "[]");
        responses = Array.isArray(parsed) ? parsed.filter(r => r && typeof r === "object" && r.contactId) : [];
      } catch { responses = [] }

      const allContacts = await storage.getContacts(drill.userId);
      const watchersWithLink = allContacts.filter(c => c.linkedUserId && c.watcherConsentStatus === "accepted");

      const guardians = watchersWithLink.map(c => {
        const r = responses.find(x => x.contactId === c.id);
        return {
          contactId: c.id,
          name: c.name,
          role: c.circleRole,
          responded: !!r,
          respondedAt: r?.respondedAt || null,
          responseTimeMs: r?.responseTimeMs || null,
        };
      });

      res.json({
        drillId: drill.id,
        status: drill.status,
        startedAt: drill.startedAt,
        resolvedAt: drill.resolvedAt,
        guardians,
        totalGuardians: watchersWithLink.length,
        respondedCount: responses.length,
      });
    } catch (error) {
      console.error("Error fetching drill:", error);
      res.status(500).json({ error: "Failed to fetch drill" });
    }
  });

  // Rotate every watcher link (panic button for the user).
  // Revokes all live tokens across all purposes and mints fresh standing tokens.
  app.post("/api/safety-circle/rotate-tokens", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const fresh = await storage.rotateAllStandingTokensForUser(userId);
      console.log(`[SECURITY] User ${userId} rotated all watcher tokens. ${fresh.length} fresh standing tokens minted.`);
      res.json({ success: true, rotated: fresh.length });
    } catch (error) {
      console.error("Error rotating watcher tokens:", error);
      res.status(500).json({ error: "Failed to rotate watcher links" });
    }
  });

  app.get("/api/safety-circle/readiness", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const contactList = await storage.getContacts(userId);
      const now = Date.now();

      // Pull recent drill acks (last 30 days) so we can credit guardians who confirmed
      // a drill even if they haven't sent a heartbeat. Drill acks are the strongest
      // signal that a guardian is reachable and responsive.
      const drillCutoff = new Date(now - 30 * 24 * 60 * 60 * 1000);
      const recentDrills = await db
        .select({ drillResponses: incidents.drillResponses })
        .from(incidents)
        .where(and(eq(incidents.userId, userId), eq(incidents.isDrill, true), gte(incidents.startedAt, drillCutoff)));
      const lastAckByContact = new Map<string, number>();
      for (const d of recentDrills) {
        try {
          const responses = JSON.parse(d.drillResponses || "[]");
          if (Array.isArray(responses)) {
            for (const r of responses) {
              if (r && typeof r === "object" && typeof r.contactId === "string" && typeof r.respondedAt === "string") {
                const t = Date.parse(r.respondedAt);
                if (!isNaN(t)) {
                  const prev = lastAckByContact.get(r.contactId) || 0;
                  if (t > prev) lastAckByContact.set(r.contactId, t);
                }
              }
            }
          }
        } catch { /* ignore malformed JSON */ }
      }

      const guardians = await Promise.all(contactList.map(async (c) => {
        let lastActiveAt: string | null = null;
        let readiness: "ready" | "idle" | "needs_attention" | "unknown" = "unknown";
        let lastActiveSource: "heartbeat" | "drill" | null = null;

        if (c.linkedUserId) {
          const linkedUser = await storage.getUser(c.linkedUserId);
          const heartbeatMs = linkedUser?.lastHeartbeatAt ? new Date(linkedUser.lastHeartbeatAt).getTime() : 0;
          const drillAckMs = lastAckByContact.get(c.id) || 0;
          const mostRecent = Math.max(heartbeatMs, drillAckMs);

          if (mostRecent > 0) {
            lastActiveAt = new Date(mostRecent).toISOString();
            lastActiveSource = drillAckMs >= heartbeatMs ? "drill" : "heartbeat";
            const ageMs = now - mostRecent;
            if (ageMs < 24 * 60 * 60 * 1000) readiness = "ready";
            else if (ageMs < 7 * 24 * 60 * 60 * 1000) readiness = "idle";
            else readiness = "needs_attention";
          }
        }
        return {
          id: c.id,
          name: c.name,
          phone: c.phone,
          role: (c.circleRole as string) || "primary",
          linked: !!c.linkedUserId,
          readiness,
          lastActiveAt,
          lastActiveSource,
        };
      }));
      const ready = guardians.filter(g => g.readiness === "ready").length;
      res.json({
        guardians,
        totalCount: guardians.length,
        readyCount: ready,
      });
    } catch (error) {
      console.error("Error fetching circle readiness:", error);
      res.status(500).json({ error: "Failed to fetch readiness" });
    }
  });

  app.get("/api/heartbeat/recommended-interval", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      const battery = user.batteryLevel ?? 100;
      const charging = user.batteryCharging ?? false;
      let intervalMs = 60000;
      let reason = "normal";
      if (battery < 10 && !charging) {
        intervalMs = 300000;
        reason = "critical_battery";
      } else if (battery < 30 && !charging) {
        intervalMs = 120000;
        reason = "low_battery";
      } else if (charging) {
        intervalMs = 60000;
        reason = "charging";
      }
      res.json({ intervalMs, reason });
    } catch (error) {
      res.status(500).json({ error: "Failed to get interval" });
    }
  });

  // Save contacts (supports both legacy 2-contact format and new array format)
  app.post("/api/contacts", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }

      const contactLimit = await storage.getContactLimit(userId);

      // New array format: { contacts: [{ name, phone, priority }] }
      if (req.body.contacts && Array.isArray(req.body.contacts)) {
        const contactsList = req.body.contacts as { name: string; phone: string; email?: string | null; priority: number }[];
        
        if (contactsList.length === 0) {
          return res.status(400).json({ error: "At least one contact is required" });
        }
        if (contactsList.length > contactLimit) {
          return res.status(403).json({ error: `Your trial has ended. Choose a monthly or yearly plan to add more than ${contactLimit} contacts.`, contactLimit });
        }
        for (const c of contactsList) {
          if (!c.name?.trim() || !c.phone?.trim()) {
            return res.status(400).json({ error: "Each contact must have a name and phone number" });
          }
        }

        const ownerUser = await storage.getUser(userId);
        const previousContacts = await storage.getContacts(userId);
        const previousByPriority = new Map(previousContacts.map((c) => [c.priority, c]));
        // Guard: a contact cannot be the user's own phone (would cause an infinite loopback on emergency dial)
        const ownerPhoneNorm = ownerUser?.phone ? normalizePhone(ownerUser.phone) : null;
        if (ownerPhoneNorm) {
          for (const c of contactsList) {
            if (normalizePhone(c.phone) === ownerPhoneNorm) {
              return res.status(400).json({ error: "You can't add your own phone number as an emergency contact. Please enter someone else's number, the person we should call to check on you." });
            }
          }
        }
        const savedContacts = await storage.saveContactsList(userId, contactsList.map((c, i) => ({
          name: c.name.trim(),
          phone: normalizePhone(c.phone),
          email: isValidEmail(c.email) ? c.email!.trim() : null,
          priority: c.priority || (i + 1),
        })));
        const tokens = await storage.getContactTokensForUser(userId);
        const shouldNotifyRequest = (contact: typeof savedContacts[number]) => {
          const previous = previousByPriority.get(contact.priority);
          if (!previous) return true;
          if (normalizePhone(previous.phone) !== normalizePhone(contact.phone)) return true;
          if (contact.watcherConsentStatus !== "pending") return false;
          const requestedAt = previous.watcherConsentRequestedAt ? new Date(previous.watcherConsentRequestedAt).getTime() : 0;
          return !requestedAt || Date.now() - requestedAt > 30 * 60 * 1000;
        };

        for (const contact of savedContacts) {
          const normalizedContactPhone = normalizePhone(contact.phone);
          const linkedUser = await storage.getUserByPhone(normalizedContactPhone);
          if (linkedUser && linkedUser.id !== userId) {
            if (isAcceptedWatcherLink(contact, linkedUser.id)) {
              console.log(`[GUARDIAN] Accepted watcher link already exists for contact=${contact.id}`);
              continue;
            }
            const roleLabel = contact.priority === 1 ? "Primary" : contact.priority === 2 ? "Backup" : "Support";
            if (shouldNotifyRequest(contact)) {
              await sendPushNotification(linkedUser.id, {
                title: "Safety Circle request",
                body: `${ownerUser?.name || "Someone"} asked you to be their ${roleLabel} Safety Circle contact. Open StillHere to accept or decline.`,
                url: "/watched/list",
                tag: `guardian-request-${contact.id}`,
              });
              await db.update(contacts)
                .set({ watcherConsentRequestedAt: new Date() })
                .where(eq(contacts.id, contact.id));
              console.log(`[GUARDIAN] Consent request sent to linkedUser=${linkedUser.id} (${roleLabel}) for owner=${userId}`);
            }
          } else {
            await storage.linkContactToUser(contact.id, null);
            if (shouldNotifyRequest(contact)) {
              const token = tokens.find((t) => t.contact.id === contact.id);
              if (token) {
                const link = `${getBaseUrl()}/emergency/${token.token}`;
                const requestSms = await sendSafetyCircleRequest(normalizedContactPhone, ownerUser?.name || "Someone", link, {
                  userId,
                  dedupeKey: `watcher_request:${userId}:${contact.id}:${Math.floor(Date.now() / (30 * 60 * 1000))}`,
                });
                if (requestSms.success) {
                  await db.update(contacts)
                    .set({ watcherConsentRequestedAt: new Date() })
                    .where(eq(contacts.id, contact.id));
                  console.log(`[GUARDIAN] SMS request link sent to contact=${contact.id} for owner=${userId}`);
                } else {
                  console.warn(`[GUARDIAN] SMS request link failed for contact=${contact.id}: ${requestSms.error || "unknown"}`);
                }
              }
            }
          }
        }

        if (!ownerUser?.setupConfirmedAt && savedContacts.length > 0) {
          await db.update(users).set({ setupConfirmedAt: new Date() }).where(eq(users.id, userId));
          const primaryContact = savedContacts[0];
          await sendPushNotification(userId, {
            title: "Safety Circle ready",
            body: `${primaryContact.name} is now part of your Safety Circle. You're all set.`,
            url: "/",
            tag: "setup-confirmed",
          });
          console.log(`[SETUP] Confirmation sent to user=${userId}`);
        }

        const updatedContacts = await storage.getContacts(userId);

        if (tokens.length > 0) {
          console.log(`[CONTACTS] ${tokens.length} contact token(s) generated`);
        }

        return res.json({ success: true, contacts: updatedContacts });
      }

      // Legacy 2-contact format
      const { contact1Name, contact1Phone, contact2Name, contact2Phone } = req.body;
      
      if (!contact1Name || !contact1Phone) {
        return res.status(400).json({ error: "Contact 1 is required" });
      }

      // Guard: a contact cannot be the user's own phone (would cause an infinite loopback on emergency dial)
      const legacyOwner = await storage.getUser(userId);
      const legacyOwnerPhoneNorm = legacyOwner?.phone ? normalizePhone(legacyOwner.phone) : null;
      if (legacyOwnerPhoneNorm) {
        if (normalizePhone(contact1Phone) === legacyOwnerPhoneNorm) {
          return res.status(400).json({ error: "You can't add your own phone number as an emergency contact. Please enter someone else's number, the person we should call to check on you." });
        }
        if (contact2Phone && normalizePhone(contact2Phone) === legacyOwnerPhoneNorm) {
          return res.status(400).json({ error: "You can't add your own phone number as an emergency contact. Please enter someone else's number, the person we should call to check on you." });
        }
      }

      const savedContacts = await storage.upsertContacts(userId, {
        contact1: {
          name: contact1Name,
          phone: normalizePhone(contact1Phone),
          priority: 1,
          canViewLocation: true,
        },
        contact2: contact2Name && contact2Phone ? {
          name: contact2Name,
          phone: normalizePhone(contact2Phone),
          priority: 2,
          canViewLocation: true,
        } : undefined,
      });
      
      const tokens = await storage.getContactTokensForUser(userId);
      if (tokens.length > 0) {
        console.log(`[CONTACTS] ${tokens.length} contact token(s) generated`);
      }
      
      res.json({ success: true, contacts: savedContacts });
    } catch (error) {
      console.error("Error saving contacts:", error);
      res.status(500).json({ error: "Failed to save contacts" });
    }
  });

  // Run test
  app.post("/api/test", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }

      // Per-user / per-IP test broadcast limit (Category-A). Enforced via the
      // outbound policy so it survives restarts and applies across all
      // process replicas. Uses a synthetic "user-test-broadcast" destination
      // (the user themselves) so the per-destination cooldown blocks rapid
      // re-fires from the same user without affecting per-contact dedupe.
      const policy = await import("./outbound-policy");
      const broadcastDecision = await policy.enforceSendPolicy({
        channel: "sms",
        purpose: "test_broadcast",
        destination: `user:${userId}`,
        userId,
        ipAddress: req.ip,
        dedupeKey: `test_broadcast:${userId}:${Math.floor(Date.now() / (10 * 60 * 1000))}`,
      });
      if (!broadcastDecision.allowed) {
        return res.status(429).json({
          error: "You've run the safety test too recently. Please wait before trying again.",
          reason: broadcastDecision.reason,
          retryAfterSeconds: broadcastDecision.retryAfterSeconds,
        });
      }

      // Create test incident
      const incident = await storage.createIncident(userId, "test");

      // Get contacts
      const contacts = (await storage.getContacts(userId)).filter(isContactActiveForAlerts);

      // Get user
      const user = await storage.getUser(userId);

      // Send test SMS to all contacts in parallel. Each individual SMS still
      // flows through enforceSendPolicy with purpose=contact_test, so a
      // single contact whose number was tested 10 minutes ago is auto-skipped.
      console.log("\n[TEST] Sending test notifications...");
      await Promise.all(contacts.map(contact =>
        sendTestMessage(contact.phone, user?.name || "User", {
          userId,
          ipAddress: req.ip,
          dedupeKey: `contact_test:${userId}:${contact.id}`,
        })
      ));
      console.log("[TEST] Notifications sent\n");
      
      // Immediately resolve the test incident
      await storage.updateIncident(incident.id, {
        status: "resolved",
        resolvedAt: new Date(),
      });
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error running test:", error);
      res.status(500).json({ error: "Failed to run test" });
    }
  });

  // ============================================
  // WEARABLE / WATCH ENDPOINTS (token auth via header)
  // ============================================

  app.post("/api/checkin/quick", async (req, res) => {
    try {
      const token = req.headers["authorization"]?.replace("Bearer ", "");
      if (!token) {
        return res.status(401).json({ error: "Missing Authorization header" });
      }
      const result = await getUserFromSession(token);
      if (!result) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }
      let location: { lat?: number; lng?: number; timezone?: string } = {};
      if (req.body?.lat != null && req.body?.lng != null) {
        const lat = parseFloat(req.body.lat);
        const lng = parseFloat(req.body.lng);
        if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
          location.lat = lat;
          location.lng = lng;
        }
      }
      if (req.body?.timezone && typeof req.body.timezone === "string" && req.body.timezone.length <= 100) {
        location.timezone = req.body.timezone;
      }
      const hasLocation = location.lat != null || location.timezone;
      const checkin = await storage.createCheckin(result.userId, "auto", hasLocation ? location as any : undefined);
      await storage.resetReminderState(result.userId);

      const wearUser = await storage.getUser(result.userId);
      if (wearUser && (wearUser.safetyState === "concern" || wearUser.safetyState === "quiet")) {
        await resolveCheckin(result.userId, "app", { skipCreateCheckin: true });
      } else {
        const openInc = await storage.getOpenIncident(result.userId);
        if (openInc) {
          await resolveCheckin(result.userId, "app", { skipCreateCheckin: true });
        }
      }

      res.json({ ok: true, checkinId: checkin.id, at: checkin.createdAt });
    } catch (error) {
      console.error("Error in quick checkin:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.get("/api/status/simple", async (req, res) => {
    try {
      const token = req.headers["authorization"]?.replace("Bearer ", "");
      if (!token) {
        return res.status(401).json({ error: "Missing Authorization header" });
      }
      const result = await getUserFromSession(token);
      if (!result) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }
      const status = await storage.getUserStatus(result.userId);
      const incident = await storage.getOpenIncident(result.userId);
      const isOverdue = status.nextCheckinDue ? new Date() > new Date(status.nextCheckinDue) : false;
      res.json({
        ok: true,
        name: result.user.name,
        lastCheckin: status.lastCheckin?.createdAt || null,
        nextDue: status.nextCheckinDue || null,
        isOverdue,
        hasActiveIncident: !!incident,
      });
    } catch (error) {
      console.error("Error in simple status:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  // ============================================
  // HEART RATE ENDPOINTS (wearable token auth)
  // ============================================

  app.post("/api/heartrate", async (req, res) => {
    try {
      const token = req.headers["authorization"]?.replace("Bearer ", "");
      if (!token) {
        return res.status(401).json({ error: "Missing Authorization header" });
      }
      const result = await getUserFromSession(token);
      if (!result) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      const { readings } = req.body;
      if (!Array.isArray(readings) || readings.length === 0) {
        return res.status(400).json({ error: "readings array required" });
      }
      if (readings.length > 100) {
        return res.status(400).json({ error: "Max 100 readings per request" });
      }

      const validated = [];
      for (const r of readings) {
        const bpm = Number(r.bpm);
        if (!Number.isInteger(bpm) || bpm < 20 || bpm > 300) {
          continue;
        }
        const recordedAt = new Date(r.recordedAt);
        if (isNaN(recordedAt.getTime())) {
          continue;
        }
        const allowedSources = ["watch", "phone", "manual"];
        const source = allowedSources.includes(r.source) ? r.source : "watch";
        validated.push({ bpm, recordedAt, source });
      }

      if (validated.length === 0) {
        return res.status(400).json({ error: "No valid readings" });
      }

      // Heart-rate opt-in gate (Privacy Nutrition Label compliance).
      // - monitoring=false: respond { disabled: true }, persist nothing,
      //   create no alerts. Watch should also bail before calling here, this
      //   is a server-side belt-and-braces.
      // - monitoring=true, alerts=false: persist readings only, never create
      //   `heart_rate_alerts` rows.
      // - monitoring=true, alerts=true: persist readings and create one alert
      //   per (high/low) threshold crossing while no active alert of that
      //   type exists.
      const hrCfg = await storage.getUserHeartRateConfig(result.userId);
      if (!hrCfg.monitoring) {
        return res.json({ ok: true, saved: 0, alert: null, disabled: true });
      }

      const saved = await storage.saveHeartRateReadings(result.userId, validated);

      // Evaluate the WHOLE batch for threshold crossings, not just the
      // newest sample. Watch payloads can include several readings recorded
      // since the last sync, and an earlier high/low spike must still page
      // the Safety Circle. Existing-active-alert dedupe still applies, so
      // one batch creates at most one HIGH and one LOW alert.
      let alert: { alertType: string } | null = null;
      if (hrCfg.alerts) {
        const existing = await storage.getActiveHeartRateAlerts(result.userId);
        let hasHighAlert = existing.some(a => a.alertType === "high");
        let hasLowAlert = existing.some(a => a.alertType === "low");
        for (const r of validated) {
          if (!hasHighAlert && r.bpm > 120) {
            const created = await storage.createHeartRateAlert(result.userId, "high", r.bpm);
            console.log(`[HeartRate] HIGH alert for user (bpm: ${r.bpm})`);
            alert = created;
            hasHighAlert = true;
          } else if (!hasLowAlert && r.bpm < 40) {
            const created = await storage.createHeartRateAlert(result.userId, "low", r.bpm);
            console.log(`[HeartRate] LOW alert for user (bpm: ${r.bpm})`);
            // Don't overwrite a previously created HIGH alert in `alert`,
            // surface whichever was created first in the response.
            if (!alert) alert = created;
            hasLowAlert = true;
          }
          if (hasHighAlert && hasLowAlert) break;
        }
      }

      res.json({ ok: true, saved: saved.length, alert: alert ? alert.alertType : null });
    } catch (error) {
      console.error("Error saving heart rate:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  // Heart-rate opt-in config. Read by both the iPhone Settings screen
  // (cookie-auth) and the Apple Watch (bearer-auth) before requesting
  // HealthKit permissions or starting a workout session. Thresholds are
  // returned alongside so the Watch can display them in the disclosure
  // screen; they are StillHere alert thresholds, not medical thresholds.
  app.get("/api/heartrate/config", async (req, res) => {
    try {
      let userId = getUserId(req);
      if (!userId) {
        const token = req.headers["authorization"]?.replace("Bearer ", "");
        if (token) {
          const result = await getUserFromSession(token);
          if (result) userId = result.userId;
        }
      }
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const cfg = await storage.getUserHeartRateConfig(userId);
      res.json({
        monitoring: cfg.monitoring,
        alerts: cfg.alerts,
        highBpm: 120,
        lowBpm: 40,
      });
    } catch (error) {
      console.error("Error reading heart-rate config:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.post("/api/heartrate/config", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const { monitoring, alerts } = req.body ?? {};
      if (monitoring !== undefined && typeof monitoring !== "boolean") {
        return res.status(400).json({ error: "monitoring must be a boolean" });
      }
      if (alerts !== undefined && typeof alerts !== "boolean") {
        return res.status(400).json({ error: "alerts must be a boolean" });
      }
      // Cannot enable alerts without monitoring. We refuse the request rather
      // than silently flipping monitoring on, so the UI must surface both
      // toggles to the user.
      if (alerts === true && monitoring === false) {
        return res.status(400).json({ error: "Cannot enable alerts while monitoring is off" });
      }
      const cfg = await storage.setUserHeartRateConfig(userId, { monitoring, alerts });
      res.json({
        success: true,
        monitoring: cfg.monitoring,
        alerts: cfg.alerts,
        highBpm: 120,
        lowBpm: 40,
      });
    } catch (error) {
      console.error("Error updating heart-rate config:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.get("/api/heartrate/latest", async (req, res) => {
    try {
      const token = req.headers["authorization"]?.replace("Bearer ", "");
      if (!token) {
        return res.status(401).json({ error: "Missing Authorization header" });
      }
      const result = await getUserFromSession(token);
      if (!result) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      const latest = await storage.getLatestHeartRate(result.userId);
      const alerts = await storage.getActiveHeartRateAlerts(result.userId);

      res.json({
        ok: true,
        heartRate: latest ? { bpm: latest.bpm, recordedAt: latest.recordedAt, source: latest.source } : null,
        alerts: alerts.map(a => ({ id: a.id, type: a.alertType, bpm: a.bpm, createdAt: a.createdAt })),
      });
    } catch (error) {
      console.error("Error getting heart rate:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.get("/api/heartrate/history", async (req, res) => {
    try {
      const token = req.headers["authorization"]?.replace("Bearer ", "");
      if (!token) {
        return res.status(401).json({ error: "Missing Authorization header" });
      }
      const result = await getUserFromSession(token);
      if (!result) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      const rawHours = Number(req.query.hours) || 24;
      const hours = Math.max(1, Math.min(rawHours, 168));
      const history = await storage.getHeartRateHistory(result.userId, hours);

      const limitedHistory = history.slice(0, 500);

      res.json({
        ok: true,
        readings: limitedHistory.map(r => ({ bpm: r.bpm, recordedAt: r.recordedAt, source: r.source })),
        count: limitedHistory.length,
        total: history.length,
      });
    } catch (error) {
      console.error("Error getting heart rate history:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  // ============================================
  // PUBLIC ROUTES (no auth required)
  // ============================================

  const emergencyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
  });

  // Contact page - get data
  // Hygiene headers prevent caching and search indexing of any watcher token URL.
  const applyEmergencyHygiene = (res: any) => {
    res.setHeader("Cache-Control", "no-store, private, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    res.setHeader("Referrer-Policy", "no-referrer");
  };

  app.get("/api/emergency/:token", emergencyLimiter, async (req, res) => {
    applyEmergencyHygiene(res);
    try {
      const token = req.params.token as string;
      const data = await storage.getContactPageData(token);
      
      if (!data) {
        return res.status(404).json({ error: "Invalid or expired link" });
      }
      
      const coords = getContactPageWeatherCoords(data);
      const weather = coords ? await getWeatherSummary(coords.lat, coords.lng) : null;
      res.json({ ...data, weather });
    } catch (error) {
      console.error("Error getting contact page data:", error);
      res.status(500).json({ error: "Failed to get data" });
    }
  });

  // Contact takes responsibility
  app.post("/api/emergency/:token/handle", emergencyLimiter, async (req, res) => {
    applyEmergencyHygiene(res);
    try {
      const token = req.params.token as string;
      const data = await storage.getContactPageData(token);
      
      if (!data) {
        return res.status(404).json({ error: "Invalid or expired link" });
      }

      // Resolution-receipt links cannot trigger any action.
      if (data.mode === "allclear") {
        return res.status(403).json({ error: "This link is read-only" });
      }
      
      if (!data.incident || data.incident.status === "resolved") {
        return res.status(400).json({ error: "No active incident" });
      }
      
      // Update incident
      const incident = await storage.updateIncident(data.incident.id, {
        status: "paused",
        handledByContactId: data.contact.id,
        nextActionAt: addMinutes(new Date(), 45),
      });
      
      console.log(`[INCIDENT] Contact handling incident for user`);
      
      // User will see in-app banner that contact responded (no SMS needed)
      
      res.json({ success: true, incident });
    } catch (error) {
      console.error("Error handling incident:", error);
      res.status(500).json({ error: "Failed to handle incident" });
    }
  });

  // Contact escalates (manual escalation - "I can't help")
  app.post("/api/emergency/:token/escalate", emergencyLimiter, async (req, res) => {
    applyEmergencyHygiene(res);
    try {
      const token = req.params.token as string;
      const data = await storage.getContactPageData(token);
      
      if (!data) {
        return res.status(404).json({ error: "Invalid or expired link" });
      }

      if (data.mode === "allclear") {
        return res.status(403).json({ error: "This link is read-only" });
      }
      
      if (!data.incident || data.incident.status === "resolved") {
        return res.status(400).json({ error: "No active incident" });
      }
      
      const now = new Date();
      
      const contacts = (await storage.getContacts(data.user.id)).filter(isContactActiveForAlerts);
      // Phase 2: incident-scoped tokens for the active incident.
      const tokens = await storage.getOrMintIncidentTokensForUser(data.user.id, data.incident.startedAt);
      const baseUrl = getBaseUrl();
      const sortedContacts = [...contacts].sort((a, b) => a.priority - b.priority);
      const firstContact = sortedContacts[0];

      const escalateSettings = await storage.getSettings(data.user.id);
      const incident = await storage.updateIncident(data.incident.id, {
        status: "open",
        handledByContactId: null,
        escalationLevel: 1,
        notifiedContactIds: JSON.stringify(firstContact ? [firstContact.id] : []),
        lastContactNotifiedAt: now,
        allContactsNotifiedAt: null,
        userNotifiedNoResponseAt: null,
        contact1NotifiedAt: now,
        contact2NotifiedAt: null,
        nextActionAt: addMinutes(now, escalateSettings?.escalationMinutes || 20),
      });
      
      console.log(`[INCIDENT] Contact escalated incident for user`);
      
      if (firstContact) {
        const tokenData = tokens.find(t => t.contact.id === firstContact.id);
        if (tokenData) {
          const link = `${baseUrl}/emergency/${tokenData.token}`;
          console.log(`[ESCALATION] Re-notifying Contact #${firstContact.priority}`);
          const reason = data.incident!.reason as "sos" | "missed_checkin";
          const smsFn = reason === "sos" ? sendSosAlert : sendMissedCheckinAlert;
          await notifyContact(firstContact, data.user.name, link, reason, smsFn, { incidentId: data.incident!.id, ipAddress: req.ip });
          console.log("[ESCALATION] Contact re-notified, escalation will continue via cron\n");
        }
      }
      
      res.json({ success: true, incident });
    } catch (error) {
      console.error("Error escalating:", error);
      res.status(500).json({ error: "Failed to escalate" });
    }
  });

  // Location update (requires auth)
  app.post("/api/location/update", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const { lat, lng, accuracy } = req.body;

      const session = await storage.getActiveLocationSession(userId);
      if (!session) {
        return res.status(400).json({ error: "No active location session" });
      }

      // Tracking-policy gate: server is authoritative for coord persistence.
      // The active emergency/safety location session is itself a real safety
      // purpose, so this normally allows; only paused/off states will deny.
      const luPolicy = await getTrackingPolicyForUser(userId);
      if (!luPolicy.nativeTrackingAllowed) {
        console.log(`[TRACKING_POLICY] location/update rejected (no allowed policy)`);
        return res.status(403).json({ error: "Tracking not allowed", policy: luPolicy });
      }

      const updated = await storage.updateLocationSession(session.id, lat, lng, accuracy);
      res.json({ success: true, session: updated });
    } catch (error) {
      console.error("Error updating location:", error);
      res.status(500).json({ error: "Failed to update location" });
    }
  });

  // ============================================
  // PUSH NOTIFICATION ROUTES
  // ============================================

  app.get("/api/push/vapid-key", (req, res) => {
    res.json({ key: getVapidPublicKey(), configured: isPushConfigured() });
  });

  app.post("/api/push/subscribe", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }

      const { subscription } = req.body;
      if (!subscription || !subscription.endpoint || !subscription.keys) {
        return res.status(400).json({ error: "Invalid push subscription" });
      }

      await storage.savePushSubscription(
        userId,
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth
      );

      console.log(`[PUSH] Subscription saved for user ${userId}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving push subscription:", error);
      res.status(500).json({ error: "Failed to save subscription" });
    }
  });

  app.post("/api/push/native-token", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }

      const { token, platform } = req.body || {};
      const normalizedPlatform = String(platform || "").toLowerCase();
      if (normalizedPlatform !== "ios") {
        return res.status(400).json({ error: "Unsupported native push platform" });
      }

      const rawToken = String(token || "").trim();
      if (!/^[a-fA-F0-9]{32,}$/.test(rawToken)) {
        return res.status(400).json({ error: "Invalid native push token" });
      }

      await storage.savePushSubscription(
        userId,
        `apns://${rawToken}`,
        "native",
        "ios",
      );

      console.log(`[PUSH] Native iOS notification token saved for user ${userId}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving native push token:", error);
      res.status(500).json({ error: "Failed to save native push token" });
    }
  });

  app.post("/api/push/unsubscribe", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }

      const { endpoint } = req.body;
      if (!endpoint) {
        return res.status(400).json({ error: "Endpoint is required" });
      }

      await storage.deletePushSubscriptionForUser(userId, endpoint);
      console.log(`[PUSH] Subscription removed for user ${userId}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Error removing push subscription:", error);
      res.status(500).json({ error: "Failed to remove subscription" });
    }
  });

  // ============================================
  // VOIP TOKEN REGISTRATION
  // ============================================

  app.post("/api/voip-token", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const { token, platform } = req.body;
      if (!token || !platform || !["ios", "android"].includes(platform)) {
        return res.status(400).json({ error: "Invalid token or platform" });
      }
      await storage.saveVoipToken(userId, token, platform);
      console.log(`[VOIP] Token registered for ${userId} (${platform})`);
      res.json({ success: true });
    } catch (error) {
      console.error("[VOIP] Token registration error:", error);
      res.status(500).json({ error: "Failed to register token" });
    }
  });

  app.delete("/api/voip-token", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const { token } = req.body;
      if (!token) {
        return res.status(400).json({ error: "Token required" });
      }
      await storage.deleteVoipToken(userId, token);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete token" });
    }
  });

  // ============================================
  // TURN CREDENTIALS FOR VIDEO CALLS
  // ============================================

  app.get("/api/turn-credentials", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const iceServers = await getTurnCredentials();
      console.log(`[TURN] Serving ${iceServers.length} ICE servers to ${userId}: ${iceServers.map((s: any) => typeof s.urls === 'string' ? s.urls.split('?')[0] : s.urls?.[0]?.split('?')[0]).join(', ')}`);
      res.json({ iceServers });
    } catch (error) {
      console.error("Error fetching TURN credentials:", error);
      res.json({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ],
      });
    }
  });

  // ============================================
  // WATCHER & MESSAGING ROUTES
  // ============================================

  // Throttle the alert/system endpoints separately from regular chat
  // (10 SOS broadcasts per 5 min, 60 system messages per 5 min  -  generous
  // for legit safety use, restrictive enough to prevent spam abuse).
  // Defined here so all messaging routes below can reference them.
  const sosLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many SOS attempts. Please wait before trying again." },
  });
  const systemMessageLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many safety messages. Please wait before sending more." },
  });

  // Per-user dedupe window for SOS broadcasts: a single user cannot fire a
  // fresh SOS more than once every 60 seconds.
  const SOS_DEDUPE_MS = 60 * 1000;
  const recentSosByUser = new Map<string, { at: number; sentCount: number }>();

  // Presence: returns whether the target user is online (active socket OR
  // recent heartbeat within last 2 min) plus a last-seen timestamp.
  // Used by the chat header to show "Active now" / "Last seen 5m ago".
  app.get("/api/users/:userId/presence", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const targetUserId = req.params.userId;
      // Auth: must share a Safety Circle relationship
      if (currentUserId !== targetUserId) {
        const myContacts = await storage.getContacts(currentUserId);
        const theirContacts = await storage.getContacts(targetUserId);
        const hasRelationship =
        myContacts.some((c) => isAcceptedWatcherLink(c, targetUserId)) ||
        theirContacts.some((c) => isAcceptedWatcherLink(c, currentUserId));
        if (!hasRelationship) return res.status(403).json({ error: "Not authorized" });
      }

      const { isUserOnline } = await import("./socket");
      const target = await storage.getUser(targetUserId);
      if (!target) return res.status(404).json({ error: "User not found" });

      const socketOnline = isUserOnline(targetUserId);
      const lastHeartbeat = target.lastHeartbeatAt ? new Date(target.lastHeartbeatAt) : null;
      const heartbeatRecent = lastHeartbeat ? Date.now() - lastHeartbeat.getTime() < 2 * 60 * 1000 : false;

      res.json({
        online: socketOnline || heartbeatRecent,
        lastSeenAt: lastHeartbeat ? lastHeartbeat.toISOString() : null,
      });
    } catch (error) {
      console.error("Error getting presence:", error);
      res.status(500).json({ error: "Failed to get presence" });
    }
  });

  // Atomic "Share live location with this person" action: starts a real live
  // location session for the requested duration AND posts a structured system
  // message into the conversation so the recipient sees a beautiful card with
  // live status + Open-in-Maps + countdown  -  not a raw URL.
  app.post("/api/messages/:userId/share-location", systemMessageLimiter, async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const receiverId = String(req.params.userId);
      const { lat, lng, accuracy, durationMinutes } = req.body || {};

      // Sharing location with yourself is meaningless and would be confusing,
      // so reject it cleanly rather than letting a self-row through.
      if (receiverId === currentUserId) {
        return res.status(400).json({ error: "Cannot share location with yourself" });
      }
      if (typeof lat !== "number" || typeof lng !== "number" || isNaN(lat) || isNaN(lng)) {
        return res.status(400).json({ error: "lat and lng are required and must be numbers" });
      }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return res.status(400).json({ error: "lat/lng out of range" });
      }
      const duration = Math.min(Math.max(parseInt(String(durationMinutes ?? 30), 10) || 30, 5), 240);

      const myContacts = await storage.getContacts(currentUserId);
      const theirContacts = await storage.getContacts(receiverId);
      const hasRelationship =
        myContacts.some((c) => isAcceptedWatcherLink(c, receiverId)) ||
        theirContacts.some((c) => isAcceptedWatcherLink(c, currentUserId));
      if (!hasRelationship) {
        return res.status(403).json({ error: "Not authorized to share location with this user" });
      }

      // Tracking-policy gate: tapping "share live location" in chat is still
      // an explicit foreground action, but if the user has turned sharing
      // OFF or PAUSED, we honor that preference and refuse.
      const csPolicy = await getTrackingPolicyForUser(currentUserId);
      if (!csPolicy.nativeTrackingAllowed) {
        console.log(`[TRACKING_POLICY] chat share-location rejected (no allowed policy)`);
        return res.status(403).json({
          error: "Sharing is paused or location is off. Update your sharing settings to share.",
          policy: csPolicy,
        });
      }

      // Reuse the existing live-location infrastructure so the recipient can
      // open the standard /watched live view and see real updates.
      const expiresAt = new Date(Date.now() + duration * 60 * 1000);
      let share: any = null;
      let liveSessionFailed = false;
      try {
        share = await storage.startLiveLocationShare(currentUserId, expiresAt);
        // Seed the share with the current location so the watcher sees a pin immediately
        await storage.updateLiveLocation(
          share.id,
          currentUserId,
          lat,
          lng,
          typeof accuracy === "number" ? accuracy : 0,
          0,
          0,
          "stationary",
        );
      } catch (err: any) {
        console.error("[SHARE-LOC] live-location session creation failed:", err?.message || err);
        liveSessionFailed = true;
        // Continue  -  we still post a message card with the snapshot location,
        // but mark it as stopped + fallback so the UI doesn't pretend it's live.
      }

      const sender = await storage.getUser(currentUserId);
      const senderName = sender?.name || "Someone";
      // If the live session failed, mark the card as stopped/fallback so the
      // recipient sees a static location snapshot, not a fake pulsing "Live" badge.
      const meta: Record<string, any> = {
        kind: "live_location" as const,
        lat,
        lng,
        accuracy: typeof accuracy === "number" ? accuracy : null,
        shareId: share?.id || null,
        expiresAt: liveSessionFailed ? new Date(0).toISOString() : expiresAt.toISOString(),
        durationMinutes: duration,
        ...(liveSessionFailed ? { stopped: true, fallback: true } : {}),
      };

      const msg = await storage.saveMessage(
        currentUserId,
        receiverId,
        liveSessionFailed
          ? `${senderName} shared a snapshot of their location.`
          : `${senderName} is sharing their live location for ${duration} minutes.`,
        { messageType: "system_info", meta },
      );

      const { emitToUser } = await import("./socket");
      emitToUser(receiverId, "message:new", { ...msg, senderName });
      emitToUser(currentUserId, "message:sent", msg);

      res.json(msg);
    } catch (error) {
      console.error("Error sharing live location in chat:", error);
      res.status(500).json({ error: "Failed to share live location" });
    }
  });

  app.get("/api/users/:userId/profile", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const targetUserId = req.params.userId;
      if (currentUserId === targetUserId) {
        const user = await storage.getUser(targetUserId);
        if (!user) return res.status(404).json({ error: "User not found" });
        return res.json({ id: user.id, name: user.name });
      }
      const myContacts = await storage.getContacts(currentUserId);
      const hasAsContact = myContacts.some(c => isAcceptedWatcherLink(c, targetUserId));
      if (!hasAsContact) {
        const theirContacts = await storage.getContacts(targetUserId);
        const isContactOf = theirContacts.some(c => isAcceptedWatcherLink(c, currentUserId));
        if (!isContactOf) {
          return res.status(403).json({ error: "Not authorized" });
        }
      }
      const user = await storage.getUser(targetUserId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({ id: user.id, name: user.name });
    } catch (error) {
      console.error("Error fetching user profile:", error);
      res.status(500).json({ error: "Failed to fetch user profile" });
    }
  });

  app.get("/api/conversations", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const conversations = await storage.getConversations(userId);
      res.json(conversations);
    } catch (error) {
      console.error("Error getting conversations:", error);
      res.status(500).json({ error: "Failed to get conversations" });
    }
  });

  app.post("/api/users/public-key", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const { publicKey } = req.body;
      if (!publicKey || typeof publicKey !== "string" || publicKey.length > 2000) {
        return res.status(400).json({ error: "Invalid public key" });
      }
      await storage.updateUser(userId, { publicKey } as any);
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving public key:", error);
      res.status(500).json({ error: "Failed to save public key" });
    }
  });

  app.get("/api/messages/unread/count", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const count = await storage.getUnreadCount(userId);
      res.json({ count });
    } catch (error) {
      console.error("Error getting unread count:", error);
      res.status(500).json({ error: "Failed to get unread count" });
    }
  });

  app.get("/api/watched-users", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const watched = await storage.getWatchedUsers(userId);
      const enriched = await Promise.all(watched.map(async (item: any) => {
        const coords = getWatchedUserWeatherCoords(item);
        const weather = coords ? await getWeatherSummary(coords.lat, coords.lng) : null;
        return { ...item, weather };
      }));
      res.json(enriched);
    } catch (error) {
      console.error("Error fetching watched users:", error);
      res.status(500).json({ error: "Failed to fetch watched users" });
    }
  });

  app.post("/api/watched-users/:contactId/opt-out", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const contactId = String(req.params.contactId);
      const contact = await storage.getContact(contactId);
      if (!contact) {
        return res.status(404).json({ error: "Contact not found" });
      }
      if (contact.linkedUserId !== userId) {
        return res.status(403).json({ error: "Not authorized" });
      }
      if (contact.softDeletedAt) {
        return res.status(400).json({ error: "Already removed" });
      }
      const updated = await storage.softDeleteContact(contactId, "watcher");
      const owner = await storage.getUser(contact.userId);
      const watcher = await storage.getUser(userId);
      if (owner) {
        const { emitToUser } = await import("./socket");
        emitToUser(contact.userId, "contact:opted-out", {
          contactId,
          contactName: watcher?.name || contact.name,
        });
        await sendPushNotification(contact.userId, {
          title: "Emergency Contact Update",
          body: `${watcher?.name || contact.name} has removed themselves as your emergency contact. We recommend adding a replacement to keep your safety network active.`,
          url: "/settings",
          tag: "contact-opted-out",
        });
      }
      res.json({ success: true, contact: updated });
    } catch (error) {
      console.error("Error opting out:", error);
      res.status(500).json({ error: "Failed to opt out" });
    }
  });

  app.get("/api/watched-users/removed", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const removed = await storage.getSoftDeletedContactsByWatcher(userId);
      res.json(removed);
    } catch (error) {
      console.error("Error fetching removed contacts:", error);
      res.status(500).json({ error: "Failed to fetch removed contacts" });
    }
  });

  app.post("/api/watched-users/:contactId/restore", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const contactId = String(req.params.contactId);
      const contact = await storage.getContact(contactId);
      if (!contact) {
        return res.status(404).json({ error: "Contact not found" });
      }
      if (contact.linkedUserId !== userId) {
        return res.status(403).json({ error: "Not authorized" });
      }
      if (!contact.softDeletedAt) {
        return res.status(400).json({ error: "Contact is not removed" });
      }
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      if (contact.softDeletedAt < thirtyDaysAgo) {
        return res.status(410).json({ error: "Removal has expired and cannot be reversed" });
      }
      const updated = await storage.restoreContact(contactId);
      res.json({ success: true, contact: updated });
    } catch (error) {
      console.error("Error restoring contact:", error);
      res.status(500).json({ error: "Failed to restore" });
    }
  });

  app.get("/api/contacts/removed", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const removed = await storage.getSoftDeletedContacts(userId);
      res.json(removed);
    } catch (error) {
      console.error("Error fetching removed contacts:", error);
      res.status(500).json({ error: "Failed to fetch removed contacts" });
    }
  });

  app.post("/api/contacts/:contactId/pause", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const contactId = String(req.params.contactId);
      const contact = await storage.getContact(contactId);
      if (!contact || contact.userId !== userId || contact.softDeletedAt) {
        return res.status(404).json({ error: "Contact not found" });
      }
      const rawPauseUntil = req.body?.pauseUntil;
      const pauseUntil = rawPauseUntil ? new Date(rawPauseUntil) : null;
      if (pauseUntil && (!Number.isFinite(pauseUntil.getTime()) || pauseUntil.getTime() <= Date.now())) {
        return res.status(400).json({ error: "Pause time must be in the future" });
      }
      const updated = await storage.pauseContact(contactId, pauseUntil, "owner");
      res.json({ success: true, contact: updated });
    } catch (error) {
      console.error("Error pausing contact:", error);
      res.status(500).json({ error: "Failed to update contact pause" });
    }
  });

  const removeContactForOwner = async (req: Request, res: Response) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const contactId = String(req.params.contactId);
      const contact = await storage.getContact(contactId);
      if (!contact || contact.userId !== userId || contact.softDeletedAt) {
        return res.status(404).json({ error: "Contact not found" });
      }
      const updated = await storage.softDeleteContact(contactId, "owner");
      if (contact.linkedUserId) {
        await sendPushNotification(contact.linkedUserId, {
          title: "Safety Circle update",
          body: "You were removed from a StillHere Safety Circle.",
          url: "/watched/list",
          tag: `contact-removed-${contactId}`,
        }).catch(() => {});
      }
      res.json({ success: true, contact: updated });
    } catch (error) {
      console.error("Error removing contact:", error);
      res.status(500).json({ error: "Failed to remove contact" });
    }
  };

  app.post("/api/contacts/:contactId/remove", removeContactForOwner);
  app.delete("/api/contacts/:contactId", removeContactForOwner);

  app.post("/api/contacts/:contactId/resend-request", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const contactId = String(req.params.contactId);
      const contact = await storage.getContact(contactId);
      if (!contact || contact.userId !== userId || contact.softDeletedAt) {
        return res.status(404).json({ error: "Contact not found" });
      }
      if (contact.pausedUntil && new Date(contact.pausedUntil).getTime() > Date.now()) {
        return res.status(409).json({ error: "This contact is paused. Resume them before sending a new request link." });
      }

      const ownerUser = await storage.getUser(userId);
      const normalizedContactPhone = normalizePhone(contact.phone);
      let token = (await storage.getContactTokensForUser(userId)).find((t) => t.contact.id === contact.id)?.token;
      if (!token) {
        const fresh = await storage.generateToken(contact.id, { ttlHours: 24, purpose: "standing" });
        token = fresh.token;
      }
      const link = `${getBaseUrl()}/emergency/${token}`;
      const linkedUser = await storage.getUserByPhone(normalizedContactPhone);

      if (linkedUser && linkedUser.id !== userId) {
        await sendPushNotification(linkedUser.id, {
          title: "Safety Circle request",
          body: `${ownerUser?.name || "Someone"} asked you to be their StillHere Safety Circle contact. Open StillHere to accept or decline.`,
          url: "/watched/list",
          tag: `guardian-request-resend-${contact.id}`,
        }).catch(() => {});
      }

      const smsResult = await sendSafetyCircleRequest(normalizedContactPhone, ownerUser?.name || "Someone", link, {
        userId,
        dedupeKey: `watcher_request_resend:${userId}:${contact.id}:${Math.floor(Date.now() / (10 * 60 * 1000))}`,
      });
      if (!smsResult.success) {
        return res.status(502).json({ error: smsResult.error || "SMS could not be sent" });
      }

      await db.update(contacts)
        .set({
          watcherConsentStatus: "pending",
          watcherConsentRequestedAt: new Date(),
          watcherConsentDeclinedAt: null,
        })
        .where(eq(contacts.id, contact.id));
      res.json({ success: true });
    } catch (error) {
      console.error("Error resending contact request:", error);
      res.status(500).json({ error: "Failed to resend request link" });
    }
  });

  app.post("/api/contacts/:contactId/restore", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const { contactId } = req.params;
      const contact = await storage.getContact(contactId);
      if (!contact) {
        return res.status(404).json({ error: "Contact not found" });
      }
      if (contact.userId !== userId) {
        return res.status(403).json({ error: "Not authorized" });
      }
      if (!contact.softDeletedAt) {
        return res.status(400).json({ error: "Contact is not removed" });
      }
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      if (contact.softDeletedAt < thirtyDaysAgo) {
        return res.status(410).json({ error: "Removal has expired and cannot be reversed" });
      }
      const activeContacts = await storage.getContacts(userId);
      const contactLimit = await storage.getContactLimit(userId);
      if (activeContacts.length >= contactLimit) {
        return res.status(409).json({ error: "Your trial has ended. Choose a monthly or yearly plan to restore more contacts." });
      }
      const priorityConflict = activeContacts.find(c => c.priority === contact.priority);
      if (priorityConflict) {
        const nextPriority = activeContacts.length + 1;
        contact.priority = nextPriority;
      }
      const updated = await storage.restoreContact(contactId);
      res.json({ success: true, contact: updated });
    } catch (error) {
      console.error("Error restoring contact:", error);
      res.status(500).json({ error: "Failed to restore" });
    }
  });

  app.get("/api/messages/:userId", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const otherUserId = req.params.userId;
      const msgs = await storage.getMessages(currentUserId, otherUserId);
      res.json(msgs);
    } catch (error) {
      console.error("Error fetching messages:", error);
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  });

  // Broadcast a system_alert message to every member of the user's Safety Circle.
  // Used by the in-chat "Trigger SOS" quick action  -  also triggers the standard
  // SOS incident pipeline if one is not already open. MUST be registered before
  // POST /api/messages/:userId so Express does not match "sos" as a userId param.
  app.post("/api/messages/sos", sosLimiter, async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }

      // Dedupe: if this user fired an SOS within the last 60s, do not re-broadcast.
      const recent = recentSosByUser.get(userId);
      if (recent && Date.now() - recent.at < SOS_DEDUPE_MS) {
        return res.json({
          success: true,
          sentCount: recent.sentCount,
          deduped: true,
          retryAfterMs: SOS_DEDUPE_MS - (Date.now() - recent.at),
        });
      }

      const user = await storage.getUser(userId);
      const userName = user?.name || "Someone";

      // Broadcast a system_alert to every linked Safety Circle member
      const contacts = await storage.getContacts(userId);
      const linked = contacts.filter((c) => c.linkedUserId);
      const alertContent = `${userName} triggered an SOS. They need help right now.`;
      const meta = { kind: "sos", triggeredAt: new Date().toISOString() };

      const { emitToUser } = await import("./socket");
      const created: any[] = [];
      for (const contact of linked) {
        try {
          const msg = await storage.saveMessage(userId, contact.linkedUserId!, alertContent, {
            messageType: "system_alert",
            meta,
          });
          emitToUser(contact.linkedUserId!, "message:new", { ...msg, senderName: userName });
          emitToUser(userId, "message:sent", msg);
          created.push(msg);
        } catch (err: any) {
          console.error(`[SOS-MSG] Failed for contact ${contact.id}:`, err?.message || err);
        }
      }

      recentSosByUser.set(userId, { at: Date.now(), sentCount: created.length });

      // Trigger the standard SOS incident flow (idempotent  -  will no-op if already open).
      // Wrapped so any failure here cannot lose the broadcast result.
      try {
        const existingIncident = await storage.getOpenIncident(userId);
        if (!existingIncident) {
          await storage.createIncident(userId, "sos");
          await storage.updateSafetyState(userId, "concern", "SOS triggered from messages");
          emitTrackingPolicyChanged(userId, "sos_msg_open").catch(() => {});
          notifyConcern(userId, userName, "sos").catch(() => {});
        }
      } catch (err: any) {
        console.error("[SOS-MSG] Incident creation failed:", err?.message || err);
      }

      res.json({ success: true, sentCount: created.length });
    } catch (error) {
      console.error("Error broadcasting SOS message:", error);
      res.status(500).json({ error: "Failed to broadcast SOS" });
    }
  });

  app.post("/api/messages/:userId", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const { content } = req.body;
      if (!content?.trim()) {
        return res.status(400).json({ error: "Message content is required" });
      }
      const receiverId = req.params.userId;

      const myContacts = await storage.getContacts(currentUserId);
      const theirContacts = await storage.getContacts(receiverId);
      const hasRelationship = myContacts.some(c => isAcceptedWatcherLink(c, receiverId)) ||
                               theirContacts.some(c => isAcceptedWatcherLink(c, currentUserId));
      if (!hasRelationship) {
        return res.status(403).json({ error: "Not authorized to message this user" });
      }

      const msg = await storage.saveMessage(currentUserId, receiverId, content.trim());

      const { emitToUser, isUserOnline } = await import("./socket");
      const sender = await storage.getUser(currentUserId);
      emitToUser(receiverId, "message:new", { ...msg, senderName: sender?.name || "Someone" });

      if (!isUserOnline(receiverId)) {
        const pushBody = content.substring(0, 100);
        await sendPushNotification(receiverId, {
          title: `Message from ${sender?.name || "Someone"}`,
          body: pushBody,
          url: `/chat/${currentUserId}`,
          tag: "new-message",
        });
      }

      res.json(msg);
    } catch (error) {
      console.error("Error sending message:", error);
      res.status(500).json({ error: "Failed to send message" });
    }
  });

  // Post a system_safe or system_info message into a conversation.
  // Either party in the Safety Circle relationship may post these.
  // system_alert may NOT be created via this endpoint  -  those only come from the
  // SOS pipeline above so they cannot be spoofed by chat actions.
  app.post("/api/messages/:userId/system", systemMessageLimiter, async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const receiverId = String(req.params.userId);
      const { type, content, meta } = req.body || {};

      if (type !== "system_safe" && type !== "system_info") {
        return res.status(400).json({ error: "Invalid system message type" });
      }
      if (!content || typeof content !== "string" || !content.trim() || content.length > 500) {
        return res.status(400).json({ error: "Invalid content" });
      }

      const myContacts = await storage.getContacts(currentUserId);
      const theirContacts = await storage.getContacts(receiverId);
      const hasRelationship =
        myContacts.some((c) => isAcceptedWatcherLink(c, receiverId)) ||
        theirContacts.some((c) => isAcceptedWatcherLink(c, currentUserId));
      if (!hasRelationship) {
        return res.status(403).json({ error: "Not authorized to message this user" });
      }

      const msg = await storage.saveMessage(currentUserId, receiverId, content.trim(), {
        messageType: type,
        meta: meta && typeof meta === "object" ? meta : undefined,
      });

      const { emitToUser } = await import("./socket");
      const sender = await storage.getUser(currentUserId);
      emitToUser(receiverId, "message:new", { ...msg, senderName: sender?.name || "Someone" });
      emitToUser(currentUserId, "message:sent", msg);

      res.json(msg);
    } catch (error) {
      console.error("Error posting system message:", error);
      res.status(500).json({ error: "Failed to post system message" });
    }
  });

  app.post("/api/messages/:userId/read", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const senderId = req.params.userId;
      await storage.markMessagesRead(senderId, currentUserId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error marking messages read:", error);
      res.status(500).json({ error: "Failed to mark messages read" });
    }
  });

  // ============================================
  // DRIVING SAFETY ENDPOINTS
  // ============================================

  const isValidLat = (v: any) => typeof v === "number" && v >= -90 && v <= 90;
  const isValidLng = (v: any) => typeof v === "number" && v >= -180 && v <= 180;
  const isValidSpeed = (v: any) => typeof v === "number" && v >= 0 && v <= 500;
  const isValidDistance = (v: any) => typeof v === "number" && v >= 0 && v <= 100000;

  app.post("/api/drive/start", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const existing = await storage.getActiveDriveSession(userId);
      if (existing) return res.status(400).json({ error: "Drive session already active", session: existing });

      // Tracking-policy gate: starting a drive triggers native GPS, so we
      // refuse if the user has paused or turned location off. Honoring this
      // up front prevents the moment-of-start coordinates from being persisted.
      const dPolicy = await getTrackingPolicyForUser(userId);
      if (!dPolicy.nativeTrackingAllowed) {
        console.log(`[TRACKING_POLICY] drive/start rejected (no allowed policy)`);
        return res.status(403).json({
          error: "Sharing is paused or location is off. Update your settings to start drive safety.",
          policy: dPolicy,
        });
      }

      const { lat, lng } = req.body || {};
      const validLat = lat !== undefined && isValidLat(lat) ? lat : undefined;
      const validLng = lng !== undefined && isValidLng(lng) ? lng : undefined;
      const session = await storage.createDriveSession(userId, validLat, validLng);
      emitTrackingPolicyChanged(userId, "drive_start").catch(() => {});
      const user = await storage.getUser(userId);
      sendLinkedWatcherPresencePush(
        userId,
        `${user?.name || "Someone"} started Drive Safety`,
        "They are sharing driving status with StillHere.",
        "drive-start",
      ).catch((err) => console.warn("[DRIVE] watcher push failed:", err?.message || err));
      res.json(session);
    } catch (error) {
      console.error("Error starting drive session:", error);
      res.status(500).json({ error: "Failed to start drive session" });
    }
  });

  app.post("/api/drive/end", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const session = await storage.getActiveDriveSession(userId);
      if (!session) return res.status(404).json({ error: "No active drive session" });

      const { maxSpeedKmh, avgSpeedKmh, distanceKm, lat, lng } = req.body || {};
      const updated = await storage.updateDriveSession(session.id, {
        endedAt: new Date(),
        ...(isValidSpeed(maxSpeedKmh) && { maxSpeedKmh }),
        ...(isValidSpeed(avgSpeedKmh) && { avgSpeedKmh }),
        ...(isValidDistance(distanceKm) && { distanceKm }),
        ...(isValidLat(lat) && { endLat: lat }),
        ...(isValidLng(lng) && { endLng: lng }),
      });
      // Emit AFTER endedAt is persisted, so the policy recompute sees the
      // closed drive session and stops native tracking promptly.
      emitTrackingPolicyChanged(userId, "drive_end").catch(() => {});
      res.json(updated);
    } catch (error) {
      console.error("Error ending drive session:", error);
      res.status(500).json({ error: "Failed to end drive session" });
    }
  });

  app.get("/api/drive/active", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const session = await storage.getActiveDriveSession(userId);
      res.json({ session: session || null });
    } catch (error) {
      console.error("Error getting active drive session:", error);
      res.status(500).json({ error: "Failed to get active drive session" });
    }
  });

  app.post("/api/drive/speed", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const { speedKmh, lat, lng, maxSpeedKmh, avgSpeedKmh, distanceKm } = req.body;
      if (!isValidSpeed(speedKmh)) return res.status(400).json({ error: "Valid speed is required" });

      const session = await storage.getActiveDriveSession(userId);
      if (session) {
        const updateData: any = {};
        if (isValidSpeed(maxSpeedKmh)) updateData.maxSpeedKmh = maxSpeedKmh;
        if (isValidSpeed(avgSpeedKmh)) updateData.avgSpeedKmh = avgSpeedKmh;
        if (isValidDistance(distanceKm)) updateData.distanceKm = distanceKm;
        if (Object.keys(updateData).length > 0) {
          await storage.updateDriveSession(session.id, updateData);
        }
      }

      if (session && lat != null && lng != null) {
        // Tracking-policy gate: only persist trip coords if policy allows.
        // The active drive session itself is a real safety purpose, so this
        // will normally allow; only paused/off/denied states will skip.
        const dsPolicy = await getTrackingPolicyForUser(userId);
        if (!dsPolicy.nativeTrackingAllowed) {
          console.log(`[TRACKING_POLICY] drive/speed coord skipped (policy deny)`);
          return res.json({ success: true, locationSkipped: true, policy: dsPolicy });
        }
        const speedMps = speedKmh / 3.6;
        let activity = "stationary";
        if (speedMps >= 11) activity = "driving";
        else if (speedMps >= 8) activity = "cycling";
        else if (speedMps >= 5) activity = "running";
        else if (speedMps >= 0.5) activity = "walking";
        await storage.addTripPoint({
          tripId: session.id,
          tripType: "drive",
          userId,
          lat, lng,
          speed: speedMps,
          activity,
        });
      }

      const userSettings = await storage.getSettings(userId);
      const speedLimit = userSettings?.speedLimitKmh || 120;

      if (speedKmh > speedLimit) {
        const alert = await storage.createSpeedAlert(
          userId,
          session?.id || null,
          speedKmh,
          speedLimit,
          lat,
          lng
        );
        return res.json({ alert, overSpeed: true, speedKmh, speedLimit });
      }

      res.json({ overSpeed: false, speedKmh, speedLimit });
    } catch (error) {
      console.error("Error logging speed:", error);
      res.status(500).json({ error: "Failed to log speed" });
    }
  });

  app.post("/api/drive/crash", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const { lat, lng, speedKmh, impactForce } = req.body;

      const session = await storage.getActiveDriveSession(userId);
      if (session) {
        await storage.updateDriveSession(session.id, {
          crashDetected: true,
          endedAt: new Date(),
          ...(lng !== undefined && { endLng: lng }),
          ...(lat !== undefined && { endLat: lat }),
        });
      }

      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const existingIncident = await storage.getOpenIncident(userId);
      if (existingIncident) {
        return res.json({ incident: existingIncident, message: "Incident already open" });
      }

      const incident = await storage.createIncident(userId, "sos");
      await storage.updateSafetyState(userId, "concern", "Crash detected");
      emitTrackingPolicyChanged(userId, "crash_open").catch(() => {});
      notifyConcern(userId, user.name, "crash_detection").catch((err) => {
        console.error(`[CRASH] notifyConcern failed for user=${userId}:`, err?.message || err);
      });
      // Auto-post into family chat with push fan-out
      broadcastToFamily(
        userId,
        speedKmh
          ? `Possible crash detected for ${user.name} (around ${Math.round(speedKmh)} km/h). Please check on them.`
          : `Possible crash detected for ${user.name}. Please check on them.`,
        "panic",
        lat != null && lng != null ? { lat, lng, kind: "crash" } : { kind: "crash" },
        {
          title: `Possible crash: ${user.name}`,
          body: "A possible vehicle crash was detected. Tap to open the family map.",
          url: "/family",
          tag: "family-crash",
        },
      ).catch(() => {});

      await storage.revokeAllTokensForUser(userId);
      const contactsRaw = (await storage.getContacts(userId)).filter(isContactActiveForAlerts);
      const sortedContacts = contactsRaw.sort((a, b) => a.priority - b.priority);
      const baseUrl = getBaseUrl();

      // Phase 2: incident-scoped tokens. revokeAllTokensForUser above clears
      // the slate, so the helper will mint fresh purpose="incident" tokens
      // for every contact in this loop's first pass.
      const crashTokens = await storage.getOrMintIncidentTokensForUser(userId, incident.startedAt);
      const crashTokenByContact = new Map(crashTokens.map(t => [t.contact.id, t.token]));

      for (const contact of sortedContacts) {
        try {
          const normalizedPhone = normalizePhone(contact.phone);
          const crashToken = crashTokenByContact.get(contact.id);
          if (!crashToken) continue;
          const link = `${baseUrl}/emergency/${crashToken}`;

          const crashMsg = `CRASH ALERT from ${user.name}! A possible vehicle crash has been detected. ${speedKmh ? `Speed at impact: ${Math.round(speedKmh)} km/h. ` : ""}Please check on them immediately: ${link}\n\nLink expires in 24 hours.`;

          if (isTwilioConfigured()) {
            await sendSms(normalizedPhone, crashMsg, {
              purpose: "drive_crash",
              userId: user.id,
              dedupeKey: `crash:${user.id}:${contact.id}`,
            });
          }

          if (contact.email) {
            // Truthful pairing: if the crash payload included fresh GPS, use
            // it with `now`. Otherwise fall back to the user's last stored
            // location AND its actual recorded timestamp — never pair an old
            // coordinate with a "just now" timestamp.
            const hasFreshGps = lat != null && lng != null;
            await sendCrashEmail(
              contact.email,
              user.name,
              link,
              speedKmh,
              {
                lat: hasFreshGps ? lat : (user.lastLat ?? null),
                lng: hasFreshGps ? lng : (user.lastLng ?? null),
                locationAt: hasFreshGps ? new Date() : (user.lastLocationAt ?? null),
                timezone: user.timezone ?? null,
              },
              {
                userId: user.id,
                incidentId: incident.id,
                dedupeKey: `crash_email:${incident.id}:${contact.id}`,
              }
            );
          }

          if (contact.linkedUserId) {
            await sendPushNotification(contact.linkedUserId, {
              title: `Urgent: Possible vehicle crash involving ${user.name}`,
              body: `A possible vehicle crash has been detected for ${user.name}. Open the app to respond immediately.`,
              url: "/watched",
              tag: "crash-alert",
            });
          }
        } catch (err) {
          console.error(`Error notifying contact ${contact.id} about crash:`, err);
        }
      }

      await storage.updateIncident(incident.id, {
        escalationLevel: sortedContacts.length,
        lastEscalationStep: `contact_${sortedContacts.length}`,
        notifiedContactIds: JSON.stringify(sortedContacts.map(c => c.id)),
        lastContactNotifiedAt: new Date(),
        nextActionAt: addMinutes(new Date(), 5),
      });

      res.json({ incident, contactsNotified: sortedContacts.length });
    } catch (error) {
      console.error("Error reporting crash:", error);
      res.status(500).json({ error: "Failed to report crash" });
    }
  });

  app.get("/api/drive/history", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const limit = parseInt(req.query.limit as string) || 20;
      const sessions = await storage.getDriveHistory(userId, Math.min(limit, 50));
      res.json(sessions);
    } catch (error) {
      console.error("Error getting drive history:", error);
      res.status(500).json({ error: "Failed to get drive history" });
    }
  });

  app.get("/api/drive/alerts", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const sessionId = req.query.sessionId as string | undefined;
      const alerts = await storage.getSpeedAlerts(userId, sessionId);
      res.json(alerts);
    } catch (error) {
      console.error("Error getting speed alerts:", error);
      res.status(500).json({ error: "Failed to get speed alerts" });
    }
  });

  app.get("/api/drive/trail/:sessionId", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const session = await storage.getDriveSession(req.params.sessionId);
      if (!session || session.userId !== userId) return res.status(404).json({ error: "Session not found" });
      const points = await storage.getTripPoints(req.params.sessionId, "drive");
      res.json(points);
    } catch (error) {
      res.status(500).json({ error: "Failed to get drive trail" });
    }
  });

  // ============================================
  // DRIVING REPORT
  // ============================================
  app.get("/api/drive/report", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const periodParam = (req.query.period as string) || "week";
      const report = await buildDriveReport(userId, periodParam);
      res.json(report);
    } catch (error) {
      console.error("Error generating drive report:", error);
      res.status(500).json({ error: "Failed to generate drive report" });
    }
  });

  app.get("/api/drive/report/:userId", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const targetUserId = req.params.userId;
      if (currentUserId !== targetUserId) {
        const canView = await checkWatcherPermission(currentUserId, targetUserId);
        if (!canView) return res.status(403).json({ error: "Not authorized" });
        const canViewLocation = await checkWatcherLocationPermission(currentUserId, targetUserId);
        const watchedSettings = await storage.getSettings(targetUserId);
        if (watchedSettings && !watchedSettings.allowReports) {
          return res.status(403).json({ error: "User has disabled report sharing" });
        }
        const periodParam = (req.query.period as string) || "week";
        const report = await buildDriveReport(targetUserId, periodParam, { includeLocation: canViewLocation });
        return res.json(report);
      }
      const periodParam = (req.query.period as string) || "week";
      const report = await buildDriveReport(targetUserId, periodParam, { includeLocation: true });
      res.json(report);
    } catch (error) {
      console.error("Error generating drive report:", error);
      res.status(500).json({ error: "Failed to generate drive report" });
    }
  });

  app.get("/api/drive/trail-public/:sessionId", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const session = await storage.getDriveSession(req.params.sessionId);
      if (!session) return res.status(404).json({ error: "Session not found" });
      if (session.userId !== currentUserId) {
        const canView = await checkWatcherLocationPermission(currentUserId, session.userId);
        if (!canView) return res.status(403).json({ error: "Not authorized" });
        const watchedSettings = await storage.getSettings(session.userId);
        if (watchedSettings && !watchedSettings.allowReports) {
          return res.status(403).json({ error: "User has disabled report sharing" });
        }
      }
      const points = await storage.getTripPoints(req.params.sessionId, "drive");
      res.json(points);
    } catch (error) {
      res.status(500).json({ error: "Failed to get drive trail" });
    }
  });

  async function buildDriveReport(userId: string, periodParam: string, options?: { includeLocation?: boolean }) {
    const now = new Date();
    let from: Date;
    switch (periodParam) {
      case "day": from = new Date(now.getTime() - 86400000); break;
      case "fortnight": from = new Date(now.getTime() - 14 * 86400000); break;
      case "month": from = new Date(now.getTime() - 30 * 86400000); break;
      case "week":
      default: from = new Date(now.getTime() - 7 * 86400000); break;
    }

    const user = await storage.getUser(userId);
    if (!user) throw new Error("User not found");

    const allSessions = await storage.getDriveHistory(userId, 500);
    const sessions = allSessions.filter(s => new Date(s.startedAt) >= from);
    const allAlerts = await storage.getSpeedAlerts(userId);
    const sessionIds = new Set(sessions.map(s => s.id));
    const alerts = allAlerts.filter(a => a.sessionId && sessionIds.has(a.sessionId));

    const totalDrives = sessions.length;
    const totalDistanceKm = sessions.reduce((sum, s) => sum + (s.distanceKm || 0), 0);
    const topSpeedKmh = sessions.length > 0 ? Math.max(...sessions.map(s => s.maxSpeedKmh || 0)) : 0;
    const avgSpeedKmh = sessions.length > 0
      ? sessions.reduce((sum, s) => sum + (s.avgSpeedKmh || 0), 0) / sessions.length
      : 0;
    const totalDriveTimeMs = sessions.reduce((sum, s) => {
      if (!s.endedAt) return sum;
      return sum + (new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime());
    }, 0);
    const crashCount = sessions.filter(s => s.crashDetected).length;
    const speedingCount = alerts.length;

    const { format: fmtDate } = await import("date-fns");

    const includeLocation = options?.includeLocation !== false;
    const driveDetails = sessions.map(s => {
      const sessionAlerts = alerts.filter(a => a.sessionId === s.id);
      const durationMs = s.endedAt
        ? new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()
        : 0;
      return {
        id: s.id,
        date: fmtDate(new Date(s.startedAt), "MMM d, yyyy"),
        startTime: fmtDate(new Date(s.startedAt), "h:mm a"),
        endTime: s.endedAt ? fmtDate(new Date(s.endedAt), "h:mm a") : null,
        durationMinutes: Math.round(durationMs / 60000),
        distanceKm: s.distanceKm || 0,
        maxSpeedKmh: s.maxSpeedKmh || 0,
        avgSpeedKmh: s.avgSpeedKmh || 0,
        crashDetected: s.crashDetected || false,
        speedAlerts: sessionAlerts.length,
        startLat: includeLocation ? s.startLat : null,
        startLng: includeLocation ? s.startLng : null,
        endLat: includeLocation ? s.endLat : null,
        endLng: includeLocation ? s.endLng : null,
      };
    });

    return {
      userName: user.name,
      periodStart: fmtDate(from, "yyyy-MM-dd"),
      periodEnd: fmtDate(now, "yyyy-MM-dd"),
      totalDrives,
      totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
      topSpeedKmh: Math.round(topSpeedKmh),
      avgSpeedKmh: Math.round(avgSpeedKmh),
      totalDriveTimeMinutes: Math.round(totalDriveTimeMs / 60000),
      crashCount,
      speedingCount,
      drives: driveDetails,
    };
  }

  // ============================================
  // ERROR TRACKING
  // ============================================
  app.post("/api/errors/report", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { type, message, stack, url, metadata } = req.body;
      if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "Error message is required" });
      }
      const userAgent = req.headers["user-agent"] || undefined;
      const report = await storage.createErrorReport({
        userId: userId || undefined,
        type: typeof type === "string" ? type : "error",
        message,
        stack: typeof stack === "string" ? stack : undefined,
        url: typeof url === "string" ? url : undefined,
        userAgent,
        metadata: typeof metadata === "string" ? metadata : metadata ? JSON.stringify(metadata) : undefined,
      });
      res.json({ id: report.id });
    } catch (error) {
      console.error("Error saving error report:", error);
      res.status(500).json({ error: "Failed to save error report" });
    }
  });

  app.get("/api/errors", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const limit = parseInt(req.query.limit as string) || 50;
      const resolved = req.query.resolved === "true" ? true : req.query.resolved === "false" ? false : undefined;
      const reports = await storage.getErrorReports(Math.min(limit, 100), resolved, userId);
      res.json(reports);
    } catch (error) {
      console.error("Error getting error reports:", error);
      res.status(500).json({ error: "Failed to get error reports" });
    }
  });

  app.get("/api/errors/stats", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const stats = await storage.getErrorReportStats(userId);
      res.json(stats);
    } catch (error) {
      console.error("Error getting error stats:", error);
      res.status(500).json({ error: "Failed to get error stats" });
    }
  });

  app.post("/api/errors/:id/resolve", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(req.params.id)) {
        return res.status(400).json({ error: "Invalid error report ID" });
      }
      const resolved = await storage.resolveErrorReport(req.params.id, userId);
      if (!resolved) return res.status(404).json({ error: "Error report not found" });
      res.json({ success: true });
    } catch (error) {
      console.error("Error resolving error report:", error);
      res.status(500).json({ error: "Failed to resolve error report" });
    }
  });

  // ============================================
  // APP RATINGS
  // ============================================
  app.post("/api/ratings", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const { rating, comment, appVersion } = req.body;
      if (typeof rating !== "number" || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
        return res.status(400).json({ error: "Rating must be an integer between 1 and 5" });
      }
      if (comment && typeof comment !== "string") {
        return res.status(400).json({ error: "Comment must be a string" });
      }
      const result = await storage.createAppRating(
        userId,
        rating,
        typeof comment === "string" ? comment.slice(0, 1000) : undefined,
        typeof appVersion === "string" ? appVersion : undefined,
      );
      res.json(result);
    } catch (error) {
      console.error("Error submitting rating:", error);
      res.status(500).json({ error: "Failed to submit rating" });
    }
  });

  app.get("/api/ratings/mine", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const rating = await storage.getUserRating(userId);
      res.json(rating || null);
    } catch (error) {
      console.error("Error getting user rating:", error);
      res.status(500).json({ error: "Failed to get rating" });
    }
  });

  app.get("/api/ratings", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const limit = parseInt(req.query.limit as string) || 50;
      const ratings = await storage.getAppRatings(Math.min(limit, 100));
      const sanitized = ratings.map(r => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt,
        isOwn: r.userId === userId,
        userName: r.userId === userId ? r.userName : undefined,
      }));
      res.json(sanitized);
    } catch (error) {
      console.error("Error getting ratings:", error);
      res.status(500).json({ error: "Failed to get ratings" });
    }
  });

  app.get("/api/ratings/stats", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const stats = await storage.getAppRatingStats();
      res.json(stats);
    } catch (error) {
      console.error("Error getting rating stats:", error);
      res.status(500).json({ error: "Failed to get rating stats" });
    }
  });

  // ============================================
  // SMS CHECK-IN WEBHOOK (Twilio incoming)
  // ============================================
  app.post("/api/sms/incoming", verifyTwilioSignature, async (req, res) => {
    try {
      const from = req.body?.From || req.body?.from;
      const body = (req.body?.Body || req.body?.body || "").trim().toLowerCase();
      
      if (!from) {
        return res.status(400).send("<Response></Response>");
      }
      
      const normalized = normalizePhone(from);

      // SMS opt-out / opt-in keywords. We check these FIRST, before any user
      // lookup, because the sender may be a contact (not a registered user)
      // who only ever receives alerts. Both users and contacts get tracked.
      // Case- and punctuation-insensitive (Twilio sends raw text).
      const cleaned = body.replace(/[^a-z]/g, "");
      const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
      const START_WORDS = new Set(["start", "unstop"]);
      const isStopWord = STOP_WORDS.has(cleaned);
      const isStartWord = START_WORDS.has(cleaned);

      if (isStopWord || isStartWord) {
        try {
          const result = await storage.setSmsOptOutByPhone(normalized, isStopWord);
          console.log(`[SMS-OPTOUT] ${isStopWord ? "OPT_OUT" : "OPT_IN"} for ***${normalized.slice(-4)} (users=${result.usersUpdated} contacts=${result.contactsUpdated})`);
        } catch (err: any) {
          console.error(`[SMS-OPTOUT] failed to update opt-out state:`, err?.message || err);
        }
        // Twilio's carrier-level STOP also intercepts further sends, so we
        // intentionally return an empty TwiML response: Twilio will append
        // its own compliance reply for STOP. For START we send a brief ack.
        if (isStartWord) {
          return res.type("text/xml").send('<Response><Message>You are re-subscribed to StillHere safety messages. Reply STOP to opt out at any time.</Message></Response>');
        }
        return res.type("text/xml").send('<Response></Response>');
      }

      const user = await storage.getUserByPhone(normalized);
      
      if (!user) {
        console.log(`[SMS-CHECKIN] Unknown phone: ***${normalized.slice(-4)}`);
        return res.type("text/xml").send('<Response><Message>This number is not registered with StillHere.</Message></Response>');
      }

      const userSettings = await storage.getSettings(user.id);

      const negatives = ["no", "n", "nope", "not ok", "not okay", "not safe", "unsafe", "need help", "help me", "emergency"];
      const isNegative = negatives.some(a => body === a || body.includes(a));

      if (isNegative || body === "help" || body === "sos") {
        let incident = await storage.getOpenIncident(user.id);
        const now = new Date();
        if (incident) {
          incident = await storage.updateIncident(incident.id, {
            reason: "sos",
            status: "open",
            handledByContactId: null,
          });
        } else {
          incident = await storage.createIncident(user.id, "sos");
        }

        await storage.updateSafetyState(user.id, "concern", isNegative ? "User replied NO to SMS check-in. Needs help." : "User requested help by SMS.");
        emitTrackingPolicyChanged(user.id, isNegative ? "sms_no_help" : "sms_help").catch(() => {});

        const allContacts = await storage.getContacts(user.id);
        const sorted = [...allContacts].sort((a, b) => a.priority - b.priority);
        const tokens = await storage.getOrMintIncidentTokensForUser(user.id, incident.startedAt);
        const baseUrl = getBaseUrl();
        const notifiedIds: string[] = [];

        for (const contact of sorted) {
          const tok = tokens.find(t => t.contact.id === contact.id);
          if (!tok) continue;
          const link = `${baseUrl}/emergency/${tok.token}`;
          try {
            await notifyContact(contact, user.name, link, "sos", sendSosAlert, { incidentId: incident.id, ipAddress: req.ip });
            notifiedIds.push(contact.id);
          } catch (err: any) {
            console.error(`[SMS-CHECKIN] Help escalation failed for contact=${contact.id}:`, err?.message || err);
          }
        }

        let existingTimeline: any[] = [];
        try { existingTimeline = JSON.parse(incident.escalationTimeline || "[]"); } catch {}
        existingTimeline.push({
          type: isNegative ? "sms_help" : "sms_sos",
          time: now.toISOString(),
          detail: isNegative ? `User replied NO to SMS check-in. Notified ${notifiedIds.length} contact(s)` : `User requested help by SMS. Notified ${notifiedIds.length} contact(s)`,
        });

        await storage.updateIncident(incident.id, {
          escalationLevel: notifiedIds.length,
          lastEscalationStep: `contact_${Math.max(1, notifiedIds.length)}`,
          notifiedContactIds: JSON.stringify(notifiedIds),
          lastContactNotifiedAt: now,
          contact1NotifiedAt: notifiedIds.length > 0 ? now : null,
          contact2NotifiedAt: notifiedIds.length > 1 ? now : null,
          allContactsNotifiedAt: notifiedIds.length >= sorted.length && sorted.length > 0 ? now : null,
          nextActionAt: addMinutes(now, userSettings?.escalationMinutes || 20),
          escalationTimeline: JSON.stringify(existingTimeline),
        });

        notifyConcern(user.id, user.name, "sos").catch((err) => {
          console.error(`[SMS-CHECKIN] notifyConcern failed:`, err?.message || err);
        });

        const reply = notifiedIds.length > 0
          ? "StillHere: We hear you. We are contacting your Safety Circle now. If this is life-threatening, call emergency services now."
          : "StillHere: We hear you. No Safety Circle contacts are available on your account. If this is life-threatening, call emergency services now.";
        return res.type("text/xml").send(`<Response><Message>${escapeXml(reply)}</Message></Response>`);
      }

      const affirmatives = ["yes", "ok", "y", "yep", "yeah", "im ok", "i'm ok", "safe", "good", "fine", "here", "alive", "checkin", "check in"];
      const isCheckin = affirmatives.some(a => body === a || body.includes(a));
      
      if (isCheckin) {
        const [safeWalkAwaitingResponse] = await db.select().from(safeWalks)
          .where(and(
            eq(safeWalks.userId, user.id),
            inArray(safeWalks.status, ["active", "overdue", "escalated"]),
          ))
          .orderBy(desc(safeWalks.startedAt))
          .limit(1);

        if (safeWalkAwaitingResponse) {
          await storage.updateSafeWalk(safeWalkAwaitingResponse.id, {
            status: "arrived",
            resolvedAt: new Date(),
          });
          emitTrackingPolicyChanged(user.id, "safe_walk_sms_arrived").catch(() => {});

          const openIncident = await storage.getOpenIncident(user.id);
          if (openIncident) {
            await resolveCheckin(user.id, "sms");
          }

          return res.type("text/xml").send(`<Response><Message>${escapeXml(`StillHere Confirmation\n\nHi ${user.name}, your Safe Walk has been marked arrived safely. Thank you for confirming.`)}</Message></Response>`);
        }

        const result = await resolveCheckin(user.id, "sms");
        
        const contacts = await storage.getContacts(user.id);
        const contactNames = contacts.map(c => c.name).join(", ");
        const hasContacts = contacts.length > 0;
        
        console.log(`[SMS-CHECKIN] Checkin recorded for user ***${normalized.slice(-4)}`);
        
        let replyMsg = `StillHere Confirmation\n\nHi ${escapeXml(user.name)}, your safety checkin has been recorded successfully.`;
        if (result.hadIncident && hasContacts) {
          replyMsg += `\n\nWe attempted to let your emergency contact${contacts.length > 1 ? "s" : ""} (${escapeXml(contactNames)}) know that you are safe. The alert has been resolved.`;
        } else if (result.hadIncident) {
          replyMsg += `\n\nThe alert has been resolved.`;
        }
        replyMsg += `\n\nThank you for checking in. Stay safe.`;
        
        return res.type("text/xml").send(`<Response><Message>${replyMsg}</Message></Response>`);
      }
      
      return res.type("text/xml").send('<Response><Message>Reply YES to check in, or NO if you need help. StillHere is part of your safety loop.</Message></Response>');
    } catch (error) {
      console.error("Error in SMS incoming webhook:", error);
      res.type("text/xml").send('<Response><Message>Something went wrong. Please try again.</Message></Response>');
    }
  });

  // Twilio delivery status callback. With Advanced Opt-Out enabled on a
  // Messaging Service, Twilio accepts an outbound SMS synchronously (returns
  // a SID) and only later marks the message as `failed` with `ErrorCode=21610`
  // when the carrier-level STOP registry rejects it. Without this webhook,
  // our DB never learns about the opt-out and we keep wasting Twilio quota
  // on every escalation. When we see `failed` + 21610 here, we back-sync the
  // opt-out flag so the next attempt is short-circuited at our gate.
  app.post("/api/sms/status", verifyTwilioSignature, async (req, res) => {
    try {
      const messageStatus = String(req.body?.MessageStatus || req.body?.messageStatus || "");
      const errorCodeRaw = req.body?.ErrorCode || req.body?.errorCode || null;
      const errorCode = errorCodeRaw ? parseInt(String(errorCodeRaw), 10) : 0;
      const to = req.body?.To || req.body?.to;
      const messageSid = String(req.body?.MessageSid || req.body?.messageSid || "");

      if (!to || !messageSid) {
        return res.status(200).send("ok");
      }

      const toStr = String(to);
      const masked = `***${toStr.slice(-4)}`;
      const isFailed = messageStatus === "failed" || messageStatus === "undelivered";
      const isOptedOutCode = errorCode === 21610;

      // 1. Always persist the latest status for this message (upsert by sid).
      try {
        await storage.recordSmsDelivery({
          messageSid,
          toLast4: toStr.slice(-4),
          status: messageStatus || "unknown",
          errorCode: errorCode ? String(errorCode) : null,
          errorMessage: req.body?.ErrorMessage || req.body?.errorMessage || null,
        });
      } catch (err: any) {
        console.warn(`[SMS-STATUS] Failed to persist delivery log for ${masked}:`, err?.message || err);
      }

      // 2. Carrier-level opt-out back-sync.
      if (isFailed && isOptedOutCode) {
        try {
          const result = await storage.setSmsOptOutByPhone(normalizePhone(toStr), true);
          console.log(`[SMS-STATUS] Carrier opt-out for ${masked} (sid=${messageSid}, code=21610), back-synced (users=${result.usersUpdated} contacts=${result.contactsUpdated})`);
        } catch (err: any) {
          console.error(`[SMS-STATUS] Failed to back-sync opt-out for ${masked}:`, err?.message || err);
        }
      } else if (isFailed) {
        console.warn(`[SMS-STATUS] Delivery failed for ${masked} (sid=${messageSid}, status=${messageStatus}, code=${errorCode})`);
      }

      // 3. If a watcher's alert SMS failed during an active incident, accelerate
      // escalation: set nextActionAt = now so the cron escalates within ~2 min
      // instead of waiting the full escalationMinutes window.
      if (isFailed) {
        try {
          const accelerated = await storage.accelerateEscalationForFailedSms(normalizePhone(toStr));
          if (accelerated > 0) {
            console.log(`[SMS-STATUS] Failed delivery to ${masked} during ${accelerated} active incident(s); escalation accelerated.`);
          }
        } catch (err: any) {
          console.warn(`[SMS-STATUS] Failed to accelerate escalation for ${masked}:`, err?.message || err);
        }
      }

      res.status(200).send("ok");
    } catch (error) {
      console.error("Error in SMS status webhook:", error);
      res.status(200).send("ok");
    }
  });

  // ============================================
  // GOOGLE MAPS API PROXY ENDPOINTS
  // ============================================

  app.get("/api/maps/config", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const key = process.env.GOOGLE_MAPS_API_KEY;
      if (!key) return res.status(500).json({ error: "Maps not configured" });
      res.json({ apiKey: key });
    } catch (error) {
      res.status(500).json({ error: "Failed to load maps config" });
    }
  });

  // Static map proxy  -  keeps the Google API key off the client and lets us
  // serve a small map preview image inside the in-chat Live Location card.
  app.get("/api/maps/static-map", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const lat = parseFloat(String(req.query.lat ?? ""));
      const lng = parseFloat(String(req.query.lng ?? ""));
      if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return res.status(400).json({ error: "Valid lat and lng required" });
      }
      const key = process.env.GOOGLE_MAPS_API_KEY;
      if (!key) return res.status(500).json({ error: "Maps not configured" });
      const width = Math.min(Math.max(parseInt(String(req.query.w ?? "640"), 10) || 640, 100), 800);
      const height = Math.min(Math.max(parseInt(String(req.query.h ?? "240"), 10) || 240, 80), 400);
      const zoom = Math.min(Math.max(parseInt(String(req.query.zoom ?? "15"), 10) || 15, 1), 20);
      const scale = 2; // retina-quality
      const url =
        `https://maps.googleapis.com/maps/api/staticmap` +
        `?center=${lat},${lng}` +
        `&zoom=${zoom}` +
        `&size=${width}x${height}` +
        `&scale=${scale}` +
        `&maptype=roadmap` +
        `&markers=color:0x4F8FF7%7C${lat},${lng}` +
        `&key=${key}`;
      const upstream = await fetch(url);
      if (!upstream.ok) {
        return res.status(502).json({ error: "Map provider error" });
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "image/png");
      // Location data is sensitive  -  keep this in the user's browser only,
      // never in shared/proxy caches.
      res.setHeader("Cache-Control", "private, max-age=300");
      res.send(buf);
    } catch (err) {
      console.error("Static map proxy error:", err);
      res.status(500).json({ error: "Failed to load static map" });
    }
  });

  // Public, signed static-map endpoint used by safety alert emails. Email
  // recipients are unauthenticated (just an inbox), so we sign the params with
  // SESSION_SECRET to prevent strangers from using us as a free Google Maps
  // proxy. Image-only response, never reveals the API key.
  app.get("/api/email/static-map", async (req, res) => {
    try {
      const lat = parseFloat(String(req.query.lat ?? ""));
      const lng = parseFloat(String(req.query.lng ?? ""));
      const sig = String(req.query.sig ?? "");
      if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return res.status(400).send("Invalid coordinates");
      }
      const secret = process.env.SESSION_SECRET;
      if (!secret) return res.status(500).send("Not configured");
      const expected = crypto.createHmac("sha256", secret)
        .update(`map:${lat.toFixed(5)}:${lng.toFixed(5)}`)
        .digest("hex").slice(0, 32);
      if (sig !== expected) return res.status(403).send("Invalid signature");
      const key = process.env.GOOGLE_MAPS_API_KEY;
      if (!key) return res.status(500).send("Maps not configured");
      const url =
        `https://maps.googleapis.com/maps/api/staticmap` +
        `?center=${lat},${lng}` +
        `&zoom=15&size=560x240&scale=2&maptype=roadmap` +
        `&markers=color:0xdc2626%7C${lat},${lng}` +
        `&key=${key}`;
      const upstream = await fetch(url);
      if (!upstream.ok) return res.status(502).send("Map unavailable");
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "image/png");
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.send(buf);
    } catch (err) {
      console.error("[EMAIL-MAP] proxy error:", err);
      res.status(500).send("Map error");
    }
  });

  app.get("/api/maps/geocode", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const { lat, lng } = req.query;
      if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });
      const key = process.env.GOOGLE_MAPS_API_KEY;
      if (!key) return res.status(500).json({ error: "Maps not configured" });
      const response = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}&result_type=street_address|route|locality`
      );
      const data = await response.json();
      if (data.status === "OK" && data.results?.length > 0) {
        const result = data.results[0];
        const components = result.address_components || [];
        const streetNumber = components.find((c: any) => c.types.includes("street_number"))?.short_name || "";
        const route = components.find((c: any) => c.types.includes("route"))?.short_name || "";
        const locality = components.find((c: any) => c.types.includes("locality"))?.long_name || "";
        const suburb = components.find((c: any) => c.types.includes("sublocality_level_1") || c.types.includes("sublocality"))?.long_name || "";
        const shortAddress = streetNumber && route ? `${streetNumber} ${route}` : route || suburb || locality || result.formatted_address;
        res.json({
          formatted: result.formatted_address,
          short: shortAddress,
          locality: locality || suburb,
          placeId: result.place_id,
        });
      } else {
        res.json({ formatted: null, short: null, locality: null, placeId: null });
      }
    } catch (error) {
      console.error("Geocoding error:", error);
      res.status(500).json({ error: "Geocoding failed" });
    }
  });

  app.get("/api/maps/nearby-emergency", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const { lat, lng } = req.query;
      if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });
      const key = process.env.GOOGLE_MAPS_API_KEY;
      if (!key) return res.status(500).json({ error: "Maps not configured" });

      const types = ["hospital", "police", "fire_station"];
      const results: { name: string; lat: number; lng: number; type: string }[] = [];

      await Promise.all(types.map(async (type) => {
        try {
          const response = await fetch(
            `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=5000&type=${type}&key=${key}`
          );
          const data = await response.json();
          if (data.results) {
            data.results.slice(0, 5).forEach((place: any) => {
              results.push({
                name: place.name,
                lat: place.geometry.location.lat,
                lng: place.geometry.location.lng,
                type,
              });
            });
          }
        } catch (err: any) {
          console.error(`[PLACES] Nearby places fetch failed for type:`, err?.message || err);
        }
      }));

      res.json(results);
    } catch (error) {
      console.error("Nearby emergency places error:", error);
      res.status(500).json({ error: "Failed to fetch nearby places" });
    }
  });

  app.post("/api/maps/snap-to-road", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const { points } = req.body;
      if (!Array.isArray(points) || points.length < 2) return res.status(400).json({ error: "At least 2 points required" });
      const key = process.env.GOOGLE_MAPS_API_KEY;
      if (!key) return res.status(500).json({ error: "Maps not configured" });

      const maxPerRequest = 100;
      const snappedPoints: { lat: number; lng: number }[] = [];

      for (let i = 0; i < points.length; i += maxPerRequest) {
        const batch = points.slice(i, i + maxPerRequest);
        const path = batch.map((p: any) => `${p.lat},${p.lng}`).join("|");
        const response = await fetch(
          `https://roads.googleapis.com/v1/snapToRoads?path=${path}&interpolate=true&key=${key}`
        );
        const data = await response.json();
        if (data.snappedPoints) {
          for (const sp of data.snappedPoints) {
            snappedPoints.push({ lat: sp.location.latitude, lng: sp.location.longitude });
          }
        }
      }

      res.json({ snappedPoints });
    } catch (error) {
      console.error("Snap to road error:", error);
      res.status(500).json({ error: "Snap to road failed" });
    }
  });

  app.get("/api/places/autocomplete", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const { input, lat, lng } = req.query;
      if (!input || typeof input !== "string" || input.length < 2) {
        return res.json({ predictions: [] });
      }

      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) return res.status(500).json({ error: "Google Maps not configured" });

      const body: any = {
        input,
        languageCode: req.headers["accept-language"]?.split(",")[0]?.split("-")[0] || "en",
      };
      if (lat && lng) {
        body.locationBias = {
          circle: {
            center: { latitude: parseFloat(lat as string), longitude: parseFloat(lng as string) },
            radius: 50000.0,
          },
        };
      }

      const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
        },
        body: JSON.stringify(body),
      });
      const data = await response.json();

      if (data.error) {
        console.error("[PLACES] Autocomplete error:", data.error.message);
        return res.json({ predictions: [] });
      }

      const predictions = (data.suggestions || [])
        .filter((s: any) => s.placePrediction)
        .map((s: any) => {
          const p = s.placePrediction;
          return {
            placeId: p.placeId || p.place?.split("/").pop() || "",
            name: p.structuredFormat?.mainText?.text || p.text?.text?.split(",")[0] || "",
            subtitle: p.structuredFormat?.secondaryText?.text || "",
            description: p.text?.text || "",
          };
        });

      res.json({ predictions });
    } catch (err) {
      console.error("[PLACES] Autocomplete failed:", err);
      res.json({ predictions: [] });
    }
  });

  app.get("/api/places/details", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const { placeId } = req.query;
      if (!placeId || typeof placeId !== "string") {
        return res.status(400).json({ error: "placeId required" });
      }

      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) return res.status(500).json({ error: "Google Maps not configured" });

      const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
        headers: {
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "displayName,formattedAddress,location",
        },
      });
      const data = await response.json();

      if (data.error || !data.location) {
        console.error("[PLACES] Details error:", data.error?.message);
        return res.status(404).json({ error: "Place not found" });
      }

      res.json({
        lat: data.location.latitude,
        lng: data.location.longitude,
        name: data.displayName?.text || "",
        address: data.formattedAddress || "",
      });
    } catch (err) {
      console.error("[PLACES] Details failed:", err);
      res.status(500).json({ error: "Failed to get place details" });
    }
  });

  app.get("/api/places/directions", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const { originLat, originLng, destLat, destLng } = req.query;
      if (!originLat || !originLng || !destLat || !destLng) {
        return res.status(400).json({ error: "Origin and destination coordinates required" });
      }

      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) return res.status(500).json({ error: "Google Maps not configured" });

      const travelModes = [
        { key: "walk", mode: "WALK" },
        { key: "bike", mode: "BICYCLE" },
        { key: "transit", mode: "TRANSIT" },
        { key: "drive", mode: "DRIVE" },
      ];

      const results: Record<string, { min: number; km: number } | null> = {};

      await Promise.all(travelModes.map(async ({ key, mode }) => {
        try {
          const body: any = {
            origin: { location: { latLng: { latitude: parseFloat(originLat as string), longitude: parseFloat(originLng as string) } } },
            destination: { location: { latLng: { latitude: parseFloat(destLat as string), longitude: parseFloat(destLng as string) } } },
            travelMode: mode,
          };

          const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Goog-Api-Key": apiKey,
              "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline",
            },
            body: JSON.stringify(body),
          });
          const data = await response.json();

          if (data.routes?.length > 0) {
            const route = data.routes[0];
            const durationSec = parseInt(route.duration?.replace("s", "") || "0");
            results[key] = {
              min: Math.max(1, Math.ceil(durationSec / 60)),
              km: Math.round((route.distanceMeters || 0) / 100) / 10,
              polyline: route.polyline?.encodedPolyline || null,
            } as any;
          } else {
            results[key] = null;
          }
        } catch {
          results[key] = null;
        }
      }));

      res.json(results);
    } catch (err) {
      console.error("[PLACES] Directions failed:", err);
      res.status(500).json({ error: "Failed to get directions" });
    }
  });

  // ============================================
  // GEOFENCE ENDPOINTS
  // ============================================
  app.get("/api/geofences", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const fences = await storage.getGeofences(userId);
      res.json(fences);
    } catch (error) {
      console.error("Error getting geofences:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.get("/api/geofences/for/:userId", async (req, res) => {
    try {
      const requesterId = getUserId(req);
      if (!requesterId) return res.status(401).json({ error: "Not authenticated" });
      const targetUserId = req.params.userId;
      const canViewLocation = requesterId === targetUserId
        ? true
        : await checkWatcherLocationPermission(requesterId, targetUserId);
      if (!canViewLocation) {
        return res.status(403).json({ error: "Not authorized" });
      }
      const fences = await storage.getGeofences(targetUserId);
      res.json(fences);
    } catch (error) {
      res.status(500).json({ error: "Failed" });
    }
  });

  app.post("/api/geofences", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const { name, lat, lng, radiusMeters, type } = req.body;
      const cleanName = typeof name === "string" ? name.trim().slice(0, 80) : "";
      const cleanLat = typeof lat === "number" ? lat : Number(lat);
      const cleanLng = typeof lng === "number" ? lng : Number(lng);
      const cleanRadius = Math.max(50, Math.min(1000, Number(radiusMeters) || 200));
      const cleanType = ["home", "work", "custom"].includes(type) ? type : "custom";
      if (!cleanName || !Number.isFinite(cleanLat) || !Number.isFinite(cleanLng)) {
        return res.status(400).json({ error: "name, lat, and lng are required" });
      }
      if (cleanLat < -90 || cleanLat > 90 || cleanLng < -180 || cleanLng > 180) {
        return res.status(400).json({ error: "lat/lng out of range" });
      }
      const fence = await storage.createGeofence(userId, {
        name: cleanName,
        lat: cleanLat,
        lng: cleanLng,
        radiusMeters: cleanRadius,
        type: cleanType,
      });
      res.json(fence);
    } catch (error) {
      console.error("Error creating geofence:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.put("/api/geofences/:id", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const updates: any = {};
      if (typeof req.body?.name === "string") {
        const cleanName = req.body.name.trim().slice(0, 80);
        if (!cleanName) return res.status(400).json({ error: "name is required" });
        updates.name = cleanName;
      }
      if (req.body?.radiusMeters !== undefined) {
        updates.radiusMeters = Math.max(50, Math.min(1000, Number(req.body.radiusMeters) || 200));
      }
      if (req.body?.type !== undefined) {
        if (!["home", "work", "custom"].includes(req.body.type)) return res.status(400).json({ error: "Invalid type" });
        updates.type = req.body.type;
      }
      if (req.body?.active !== undefined) {
        if (typeof req.body.active !== "boolean") return res.status(400).json({ error: "active must be boolean" });
        updates.active = req.body.active;
      }
      const fence = await storage.updateGeofence(req.params.id as string, userId, updates);
      res.json(fence);
    } catch (error) {
      console.error("Error updating geofence:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.delete("/api/geofences/:id", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      await storage.deleteGeofence(req.params.id as string, userId);
      res.json({ ok: true });
    } catch (error) {
      console.error("Error deleting geofence:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  const geofenceState = new Map<string, Map<string, boolean>>();
  // Expose to module-scope helpers (e.g. purgePlaceFromGeofenceState) without
  // making it global.
  geofenceStateRef = geofenceState;

  async function evaluateGeofenceTransitions(userId: string, lat: number, lng: number): Promise<{
    zones: Array<{ id: string; name: string; type: string; inside: boolean; distanceMeters: number }>;
    newDepartures: string[];
    placeArrivals: string[];
    placeDepartures: string[];
  }> {
      const fences = await storage.getGeofences(userId);
      const activeFences = fences.filter(f => f.active);
      const results = activeFences.map(fence => {
        const distance = haversineDistance(lat, lng, fence.lat, fence.lng);
        return {
          id: fence.id,
          name: fence.name,
          type: fence.type,
          inside: distance <= fence.radiusMeters,
          distanceMeters: Math.round(distance),
        };
      });

      if (!geofenceState.has(userId)) {
        geofenceState.set(userId, new Map());
      }
      const userState = geofenceState.get(userId)!;

      const newDepartures: typeof results = [];
      const newArrivals: typeof results = [];
      for (const r of results) {
        const wasInside = userState.get(r.id);
        if (wasInside === true && !r.inside) newDepartures.push(r);
        if (wasInside === false && r.inside) newArrivals.push(r);
        userState.set(r.id, r.inside);
      }

      if (newDepartures.length > 0) {
        const user = await storage.getUser(userId);
        const allContacts = await storage.getContacts(userId);
        for (const zone of newDepartures) {
          for (const contact of allContacts) {
            if (contact.linkedUserId && isAcceptedWatcherLink(contact, contact.linkedUserId)) {
              const body = `${user?.name || "Someone"} left ${zone.name}. Open StillHere for current status.`;
              sendPushNotification(contact.linkedUserId, {
                title: "Saved place alert",
                body,
                url: "/watched",
                tag: `geofence-${zone.id}`,
              }, {
                purpose: "geofence",
                dedupeKey: `geofence_push:${zone.id}:${contact.linkedUserId}:${Math.floor(Date.now() / 300000)}`,
              }).catch((err: any) => {
                console.error(`[GEOFENCE] Push to contact=${contact.id} about zone=${zone.id} failed:`, err?.message || err);
              });
              storage.saveMessage(userId, contact.linkedUserId, body, {
                messageType: "system_alert",
                meta: { kind: "geofence_departure", place: zone.name },
              }).catch((err: any) => {
                console.error(`[GEOFENCE] In-app message to contact=${contact.id} about zone=${zone.id} failed:`, err?.message || err);
              });
            }
            if (contact.email) {
              try {
                await sendGeofenceEmail(contact.email, user?.name || "User", zone.name, {
                  lat,
                  lng,
                  locationAt: new Date(),
                  timezone: user?.timezone ?? null,
                }, {
                  userId,
                  dedupeKey: `geofence_email:${zone.id}:${contact.id}:${Math.floor(Date.now() / 300000)}`,
                });
              } catch (err: any) {
                console.error(`[GEOFENCE] Email to contact=${contact.id} about zone=${zone.id} failed:`, err?.message || err);
              }
            }
          }
        }
      }

      // ---- Family Saved Places: detect arrivals/departures and post to family chat ----
      const overview = await storage.getActiveFamilyForUser(userId);
      const placeArrivals: { name: string; icon: string }[] = [];
      const placeDepartures: { name: string; icon: string }[] = [];
      if (overview.family) {
        const places = await storage.getFamilyPlaces(overview.family.id);
        for (const p of places) {
          const key = `place:${p.id}`;
          const dist = haversineDistance(lat, lng, p.lat, p.lng);
          const inside = dist <= p.radiusMeters;
          const wasInside = userState.get(key);
          if (wasInside === true && !inside) placeDepartures.push({ name: p.name, icon: p.icon });
          if (wasInside === false && inside) placeArrivals.push({ name: p.name, icon: p.icon });
          userState.set(key, inside);
        }
        // Hoist family + sender lookups so multiple arrivals/departures don't N+1.
        if (placeArrivals.length > 0 || placeDepartures.length > 0) {
          const user = await storage.getUser(userId);
          const userName = user?.name || "Family member";
          const recipients = await storage.getActiveFamilyUserIds(overview.family.id);
          const prefetched = { familyId: overview.family.id, senderName: userName, recipients };
          for (const a of placeArrivals) {
            broadcastToFamily(userId, `${userName} arrived at ${a.name}.`, "system",
              { kind: "place_arrival", place: a.name }, undefined, prefetched).catch(() => {});
          }
          for (const d of placeDepartures) {
            broadcastToFamily(userId, `${userName} left ${d.name}.`, "system",
              { kind: "place_departure", place: d.name }, undefined, prefetched).catch(() => {});
          }
        }
      }

      return {
        zones: results,
        newDepartures: newDepartures.map(d => d.name),
        placeArrivals: placeArrivals.map(p => p.name),
        placeDepartures: placeDepartures.map(p => p.name),
      };
  }

  app.post("/api/geofences/check", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const { lat, lng } = req.body;
      if (lat == null || lng == null || typeof lat !== "number" || typeof lng !== "number") {
        return res.status(400).json({ error: "lat and lng must be numbers" });
      }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return res.status(400).json({ error: "lat/lng out of range" });
      }

      res.json(await evaluateGeofenceTransitions(userId, lat, lng));
    } catch (error) {
      console.error("Error checking geofences:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  // ============================================
  // LOCATION BREADCRUMBS
  // ============================================
  app.post("/api/location/breadcrumb", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const { lat, lng, accuracy, sessionId } = req.body;
      if (lat == null || lng == null) return res.status(400).json({ error: "lat and lng required" });
      // Tracking-policy gate: do not persist coords when policy denies.
      const policy = await getTrackingPolicyForUser(userId);
      if (!policy.nativeTrackingAllowed) {
        console.log(`[TRACKING_POLICY] breadcrumb rejected for user (no allowed policy)`);
        return res.status(403).json({ error: "Tracking not allowed", policy });
      }
      const breadcrumb = await storage.saveBreadcrumb(userId, sessionId || null, lat, lng, accuracy || null);
      res.json(breadcrumb);
    } catch (error) {
      console.error("Error saving breadcrumb:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.get("/api/location/breadcrumbs/:userId", async (req, res) => {
    try {
      const requesterId = getUserId(req);
      if (!requesterId) return res.status(401).json({ error: "Not authenticated" });
      const targetUserId = req.params.userId as string;
      const canViewLocation = requesterId === targetUserId
        ? true
        : await checkWatcherLocationPermission(requesterId, targetUserId);
      if (!canViewLocation) {
        return res.status(403).json({ error: "Not authorized" });
      }
      const sessionId = req.query.sessionId as string | undefined;
      const breadcrumbs = await storage.getBreadcrumbs(targetUserId, sessionId, 200);
      res.json(breadcrumbs);
    } catch (error) {
      console.error("Error getting breadcrumbs:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  // ============================================
  // LIVE LOCATION SHARING ENDPOINTS
  // ============================================
  app.post("/api/live-location/start", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      // Tracking-policy gate: starting a live share enables continuous GPS,
      // so refuse if user has paused or turned location off.
      const llsPolicy = await getTrackingPolicyForUser(userId);
      if (!llsPolicy.nativeTrackingAllowed) {
        console.log(`[TRACKING_POLICY] live-location/start rejected (no allowed policy)`);
        return res.status(403).json({
          error: "Sharing is paused or location is off. Update your settings to start live sharing.",
          policy: llsPolicy,
        });
      }
      const { durationMinutes } = req.body;
      const expiresAt = durationMinutes ? new Date(Date.now() + durationMinutes * 60 * 1000) : null;
      const share = await storage.startLiveLocationShare(userId, expiresAt);
      emitTrackingPolicyChanged(userId, "live_share_start").catch(() => {});
      res.json(share);
    } catch (error) {
      res.status(500).json({ error: "Failed to start live location sharing" });
    }
  });

  app.post("/api/live-location/stop", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      await storage.stopLiveLocationShare(userId);
      emitTrackingPolicyChanged(userId, "live_share_stop").catch(() => {});
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to stop live location sharing" });
    }
  });

  app.get("/api/live-location/status", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const policy = await getTrackingPolicyForUser(userId);
      const share = await storage.getActiveLiveShare(userId);
      res.json({
        active: policy.active,
        share: share || null,
        nativeTrackingAllowed: policy.nativeTrackingAllowed,
        heartbeatAllowed: policy.heartbeatAllowed,
        sharingMode: policy.sharingMode,
        locationMode: policy.locationMode,
        activePurposes: policy.activePurposes,
        sessions: policy.sessions,
        graceWindowSeconds: policy.graceWindowSeconds,
        reason: policy.reason,
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to get live location status" });
    }
  });

  app.post("/api/live-location/update", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const share = await storage.getActiveLiveShare(userId);
      if (!share) return res.status(400).json({ error: "No active live location session" });

      if (share.expiresAt && new Date() > share.expiresAt) {
        await storage.stopLiveLocationShare(userId);
        return res.status(400).json({ error: "Live location session has expired" });
      }

      // Tracking-policy gate: server is authoritative. If the user has paused,
      // turned location off, or otherwise lost a real safety purpose, refuse
      // the coordinate write and tell the client to stop tracking.
      const policy = await getTrackingPolicyForUser(userId);
      if (!policy.nativeTrackingAllowed) {
        console.log(`[TRACKING_POLICY] live-location/update rejected for user (no allowed policy)`);
        return res.status(403).json({ error: "Tracking not allowed", policy });
      }

      const { lat, lng, accuracy, speed, heading, activity } = req.body;
      if (lat == null || lng == null) return res.status(400).json({ error: "lat and lng are required" });

      const detectedActivity = activity || detectActivityFromSpeed(speed);
      const point = await storage.updateLiveLocation(
        share.id, userId, lat, lng,
        accuracy ?? null, speed ?? null, heading ?? null, detectedActivity
      );
      const geofenceResultPromise = evaluateGeofenceTransitions(userId, lat, lng).catch((err: any) => {
        console.error(`[GEOFENCE] live-location evaluation failed for user=${userId}:`, err?.message || err);
      });

      emitToUser(userId, "live-location:updated", { lat, lng, speed, heading, activity: detectedActivity });

      const [,,watcherContacts, updatedUser, openIncidentForEmit] = await Promise.all([
        geofenceResultPromise,
        processLocationContext(userId, lat, lng, speed ?? null, detectedActivity).catch((err) => {
          console.error(`[LOCATION] processLocationContext failed for ${userId}:`, err?.message || err);
        }),
        storage.getContactsLinkedToUser(userId),
        storage.getUser(userId),
        storage.getOpenIncident(userId),
      ]);

      const ctx = getUserContext(userId);
      for (const contact of watcherContacts) {
        if (contact.linkedUserId) {
          emitToUser(contact.linkedUserId, "live-location:contact-updated", {
            userId, lat, lng, speed, heading, activity: detectedActivity,
            accuracy, timestamp: point.recordedAt,
            safetyState: updatedUser?.safetyState || null,
            hasSafetyEvent: !!openIncidentForEmit,
            contextLine: ctx.contextLine || null,
          });
        }
      }

      res.json(point);
    } catch (error) {
      res.status(500).json({ error: "Failed to update live location" });
    }
  });

  app.get("/api/context/:userId", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) return res.status(401).json({ error: "Not authenticated" });

      const targetUserId = req.params.userId;
      const isSelf = currentUserId === targetUserId;
      if (!isSelf) {
        const linkedContacts = await storage.getContactsLinkedToUser(targetUserId);
        const isWatcher = linkedContacts.some(c => c.linkedUserId === currentUserId);
        if (!isWatcher) return res.status(403).json({ error: "Not authorized" });
      }

      const ctx = getUserContext(targetUserId);
      const events = await getRecentContextEvents(targetUserId, 20);

      const timeline = events.reverse().map(e => ({
        type: e.type,
        time: e.createdAt.toISOString(),
        placeName: e.placeName,
        detail: formatContextEvent(e.type, e.placeName, e.detail || null),
      }));

      res.json({ ...ctx, timeline });
    } catch (error) {
      res.status(500).json({ error: "Failed to get context" });
    }
  });

  app.get("/api/notification-prefs/:watchedUserId", async (req, res) => {
    try {
      const watcherId = getUserId(req);
      if (!watcherId) return res.status(401).json({ error: "Not authenticated" });
      const watchedUserId = req.params.watchedUserId;

      const linkedContacts = await storage.getContactsLinkedToUser(watchedUserId);
      const isWatcher = linkedContacts.some(c => c.linkedUserId === watcherId);
      if (!isWatcher) return res.status(403).json({ error: "Not authorized" });

      const [pref] = await db.select().from(watcherNotificationPrefs)
        .where(and(
          eq(watcherNotificationPrefs.watcherId, watcherId),
          eq(watcherNotificationPrefs.watchedUserId, watchedUserId),
        ))
        .limit(1);

      res.json({
        arrivalNotifications: pref ? pref.arrivalNotifications : true,
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to get notification preferences" });
    }
  });

  app.put("/api/notification-prefs/:watchedUserId", async (req, res) => {
    try {
      const watcherId = getUserId(req);
      if (!watcherId) return res.status(401).json({ error: "Not authenticated" });
      const watchedUserId = req.params.watchedUserId;

      const linkedContacts = await storage.getContactsLinkedToUser(watchedUserId);
      const isWatcher = linkedContacts.some(c => c.linkedUserId === watcherId);
      if (!isWatcher) return res.status(403).json({ error: "Not authorized" });

      const { arrivalNotifications } = req.body;

      if (typeof arrivalNotifications !== "boolean") {
        return res.status(400).json({ error: "arrivalNotifications must be boolean" });
      }

      const [existing] = await db.select().from(watcherNotificationPrefs)
        .where(and(
          eq(watcherNotificationPrefs.watcherId, watcherId),
          eq(watcherNotificationPrefs.watchedUserId, watchedUserId),
        ))
        .limit(1);

      if (existing) {
        await db.update(watcherNotificationPrefs)
          .set({ arrivalNotifications })
          .where(eq(watcherNotificationPrefs.id, existing.id));
      } else {
        await db.insert(watcherNotificationPrefs).values({
          watcherId,
          watchedUserId,
          arrivalNotifications,
        });
      }

      res.json({ success: true, arrivalNotifications });
    } catch (error) {
      res.status(500).json({ error: "Failed to update notification preferences" });
    }
  });

  app.get("/api/live-location/watching", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const shares = await storage.getActiveLiveSharesForWatcher(userId);
      res.json(shares);
    } catch (error) {
      res.status(500).json({ error: "Failed to get watched live locations" });
    }
  });

  app.get("/api/live-location/trail/:userId", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) return res.status(401).json({ error: "Not authenticated" });
      const targetUserId = req.params.userId;

      const canViewLocation = targetUserId === currentUserId
        ? true
        : await checkWatcherLocationPermission(currentUserId, targetUserId);
      if (!canViewLocation) {
        return res.status(403).json({ error: "Not authorized to view this location" });
      }

      const share = await storage.getActiveLiveShare(targetUserId);
      const targetUser = await storage.getUser(targetUserId);

      if (share) {
        const shareWithName = { ...share, userName: targetUser?.name || "Contact" };
        const sinceParam = req.query.since as string | undefined;
        const since = sinceParam ? new Date(sinceParam) : undefined;
        const points = await storage.getLiveLocationPoints(share.id, since, 200);
        return res.json({ active: true, share: shareWithName, points: points.reverse() });
      }

      // Cascading fallback: emergency location_session (e.g. SOS) first, then
      // a recent users.lastLat snapshot when there is an open incident. This
      // mirrors what the home /watching feed shows so a watcher who sees the
      // person on the home map can always tap in and see them on the detail
      // page too. Historical points are not available because these sources
      // do not write to live_location_points; we return an empty points array.
      const snapshot = await storage.getWatcherVisibleSnapshot(targetUserId);
      if (snapshot) {
        const virtualShare = {
          id: snapshot.virtualId,
          userId: targetUserId,
          active: true,
          expiresAt: snapshot.expiresAt,
          lastLat: snapshot.lat,
          lastLng: snapshot.lng,
          lastAccuracy: snapshot.accuracy,
          lastSpeed: null,
          lastHeading: null,
          lastActivity: null,
          lastUpdatedAt: snapshot.updatedAt,
          createdAt: snapshot.updatedAt,
          userName: targetUser?.name || "Contact",
          source: snapshot.source,
        };
        return res.json({ active: true, share: virtualShare, points: [] });
      }

      return res.json({ active: false, points: [] });
    } catch (error) {
      res.status(500).json({ error: "Failed to get location trail" });
    }
  });

  // ============================================
  // SATELLITE DEVICE ENDPOINTS
  // ============================================
  const allowedSatelliteDeviceTypes = new Set(["garmin_inreach", "spot", "somewear", "zoleo", "other"]);
  const allowedSatelliteActions = new Set(["checkin", "sos"]);

  function normalizeSatelliteCoordinate(value: unknown, min: number, max: number): number | null {
    if (value == null || value === "") return null;
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(num) || num < min || num > max) return null;
    return num;
  }

  app.get("/api/satellite/devices", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const devices = await storage.getSatelliteDevices(userId);
      res.json(devices);
    } catch (error) {
      console.error("Error getting satellite devices:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.post("/api/satellite/register", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const { deviceType, deviceId, name } = req.body;
      const cleanDeviceType = typeof deviceType === "string" ? deviceType.trim() : "";
      const cleanDeviceId = typeof deviceId === "string" ? deviceId.trim() : "";
      const cleanName = typeof name === "string" ? name.trim() : "";
      if (!cleanDeviceType || !cleanDeviceId || !cleanName) {
        return res.status(400).json({ error: "deviceType, deviceId, and name are required" });
      }
      if (!allowedSatelliteDeviceTypes.has(cleanDeviceType)) {
        return res.status(400).json({ error: "Unsupported satellite device type" });
      }
      if (cleanDeviceId.length < 3 || cleanDeviceId.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(cleanDeviceId)) {
        return res.status(400).json({ error: "Device ID must be 3-80 characters and use only letters, numbers, dots, dashes, underscores, or colons" });
      }
      if (cleanName.length > 80) {
        return res.status(400).json({ error: "Device nickname must be 80 characters or fewer" });
      }
      const device = await storage.registerSatelliteDevice(userId, {
        deviceType: cleanDeviceType,
        deviceId: cleanDeviceId,
        name: cleanName,
      });
      res.json(device);
    } catch (error) {
      console.error("Error registering satellite device:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.delete("/api/satellite/devices/:id", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      await storage.deleteSatelliteDevice(req.params.id as string, userId);
      res.json({ ok: true });
    } catch (error) {
      console.error("Error deleting satellite device:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.post("/api/satellite/webhook", async (req, res) => {
    try {
      const expectedSecret = process.env.SATELLITE_WEBHOOK_SECRET;
      if (!expectedSecret) {
        console.error("[SATELLITE] SATELLITE_WEBHOOK_SECRET not configured, rejecting webhook");
        return res.status(503).json({ error: "Webhook not configured" });
      }
      const providedSecret = req.headers["x-satellite-secret"];
      const providedStr = typeof providedSecret === "string" ? providedSecret : "";
      const expectedBuf = Buffer.from(expectedSecret);
      const providedBuf = Buffer.from(providedStr);
      const { timingSafeEqual } = await import("crypto");
      const secretsMatch = providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
      if (!secretsMatch) {
        console.warn("[SATELLITE] Invalid or missing webhook secret");
        return res.status(403).json({ error: "Forbidden" });
      }

      const { deviceId, action, lat, lng } = req.body;
      const cleanDeviceId = typeof deviceId === "string" ? deviceId.trim() : "";
      const cleanAction = typeof action === "string" ? action.trim().toLowerCase() : "";
      if (!cleanDeviceId || !cleanAction) {
        return res.status(400).json({ error: "deviceId and action required" });
      }
      if (!allowedSatelliteActions.has(cleanAction)) {
        return res.status(400).json({ error: "Unknown action. Use 'checkin' or 'sos'" });
      }
      const satLat = normalizeSatelliteCoordinate(lat, -90, 90);
      const satLng = normalizeSatelliteCoordinate(lng, -180, 180);
      if ((lat != null && satLat == null) || (lng != null && satLng == null)) {
        return res.status(400).json({ error: "lat and lng must be valid coordinates" });
      }
      
      const deviceWithUser = await storage.getSatelliteDeviceByDeviceId(cleanDeviceId);
      if (!deviceWithUser) {
        return res.status(404).json({ error: "Device not registered" });
      }
      await storage.recordSatelliteDeviceSeen(deviceWithUser.id);
      
      const user = deviceWithUser.user;
      
      if (cleanAction === "checkin") {
        await storage.createCheckin(user.id, "auto");
        await storage.resetReminderState(user.id);
        if (user.safetyState === "concern" || user.safetyState === "quiet") {
          await resolveCheckin(user.id, "app", { skipCreateCheckin: true });
        } else {
          const openInc = await storage.getOpenIncident(user.id);
          if (openInc) {
            await resolveCheckin(user.id, "app", { skipCreateCheckin: true });
          }
        }
        if (satLat != null && satLng != null) {
          // Even satellite devices respect the user's tracking policy for
          // coordinate persistence. The check-in itself always lands.
          const satPolicy = await getTrackingPolicyForUser(user.id);
          if (satPolicy.nativeTrackingAllowed) {
            const session = await storage.getActiveLocationSession(user.id);
            if (session) {
              await storage.updateLocationSession(session.id, satLat, satLng, 50);
            }
            await storage.saveBreadcrumb(user.id, null, satLat, satLng, 50);
          } else {
            console.log(`[TRACKING_POLICY] satellite checkin coords stripped (policy deny)`);
          }
        }
        console.log(`[SATELLITE] Checkin from device ${deviceWithUser.id} for user ${user.id}`);
        res.json({ ok: true, action: "checkin_recorded" });
      } else if (cleanAction === "sos") {
        const existing = await storage.getOpenIncident(user.id);
        if (!existing) {
          const incident = await storage.createIncident(user.id, "sos");
          const allContacts = await storage.getContacts(user.id);
          const sorted = [...allContacts].sort((a, b) => a.priority - b.priority);
          // Phase 2: incident-scoped token for this brand-new incident.
          const tokens = await storage.getOrMintIncidentTokensForUser(user.id, incident.startedAt);
          const baseUrl = getBaseUrl();
          const first = sorted[0];
          if (first) {
            const tok = tokens.find(t => t.contact.id === first.id);
            if (tok) {
              const link = `${baseUrl}/emergency/${tok.token}`;
              await notifyContact(first, user.name, link, "sos", sendSosAlert, { incidentId: incident.id, ipAddress: req.ip });
            }
          }
          const userSettings = await storage.getSettings(user.id);
          await storage.updateIncident(incident.id, {
            escalationLevel: 1,
            lastEscalationStep: "contact_1",
            notifiedContactIds: JSON.stringify(first ? [first.id] : []),
            lastContactNotifiedAt: new Date(),
            contact1NotifiedAt: new Date(),
            nextActionAt: addMinutes(new Date(), userSettings?.escalationMinutes || 20),
          });
        }
        if (satLat != null && satLng != null) {
          // After createIncident above, the open SOS counts as a real safety
          // purpose, so policy will normally allow. We still re-check to honor
          // explicit paused/off settings.
          const satSosPolicy = await getTrackingPolicyForUser(user.id);
          if (satSosPolicy.nativeTrackingAllowed) {
            await storage.saveBreadcrumb(user.id, null, satLat, satLng, 50);
          } else {
            console.log(`[TRACKING_POLICY] satellite SOS coords stripped (policy deny)`);
          }
        }
        console.log(`[SATELLITE] SOS from device ${deviceWithUser.id} for user ${user.id}`);
        res.json({ ok: true, action: "sos_triggered" });
      } else {
        res.status(400).json({ error: "Unknown action. Use 'checkin' or 'sos'" });
      }
    } catch (error) {
      console.error("Error in satellite webhook:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  // ============================================
  // REPORT ENDPOINTS
  // ============================================

  app.get("/api/watched-users/:userId/daily", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const watchedUserId = req.params.userId;
      const canView = await checkWatcherPermission(currentUserId, watchedUserId);
      if (!canView) {
        return res.status(403).json({ error: "Not authorized" });
      }
      const watchedSettings = await storage.getSettings(watchedUserId);
      if (watchedSettings && !watchedSettings.allowReports) {
        return res.status(403).json({ error: "User has disabled report sharing" });
      }
      const daily = await storage.getDailyStatus(currentUserId, watchedUserId);
      res.json(daily);
    } catch (error) {
      console.error("Error fetching daily status:", error);
      res.status(500).json({ error: "Failed to fetch daily status" });
    }
  });

  app.get("/api/reports/weekly", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      // Accept the same period vocabulary as R4 watcher report and R5 drive
      // report so all surfaces use one mental model. Default = week.
      const periodParam = (req.query.period as string) || "week";
      const now = new Date();
      let from: Date;
      switch (periodParam) {
        case "day": from = new Date(now.getTime() - 86400000); break;
        case "fortnight": from = new Date(now.getTime() - 14 * 86400000); break;
        case "month": from = new Date(now.getTime() - 30 * 86400000); break;
        case "week":
        default: from = new Date(now.getTime() - 7 * 86400000); break;
      }
      // Local alias kept for readability; the rest of this handler still
      // refers to "week" because the response shape and timeline copy
      // ("This Week") were the original product framing. The window itself
      // honors `from`, so day/fortnight/month all aggregate correctly.
      const weekAgo = from;

      const weekIncidents = await db
        .select()
        .from(incidents)
        .where(and(eq(incidents.userId, userId), gte(incidents.startedAt, weekAgo)))
        .orderBy(desc(incidents.startedAt));

      const weekCheckins = await db
        .select()
        .from(checkins)
        .where(and(eq(checkins.userId, userId), gte(checkins.createdAt, weekAgo)))
        .orderBy(desc(checkins.createdAt));

      const weekContext = await db
        .select()
        .from(contextEvents)
        .where(and(eq(contextEvents.userId, userId), gte(contextEvents.createdAt, weekAgo)))
        .orderBy(desc(contextEvents.createdAt));
      const safetyActivity = await buildSafetyActivityTimeline(userId, weekAgo, now);

      const reasonMap: Record<string, string> = {
        missed_checkin: "Missed check-in",
        sos: "SOS alert triggered",
        test: "Test alert",
        crash_detected: "Crash detected",
        safety_timer: "Safety timer expired",
        safe_walk: "Late arrival detected",
      };

      const methodMap: Record<string, string> = {
        button: "Confirmed safe in app",
        app: "Confirmed safe in app",
        sms: "Confirmed safe by SMS",
        auto: "Resolved automatically",
        call: "Confirmed safe by phone call",
        voice: "Confirmed safe by phone call",
      };

      const contextMap: Record<string, (name: string) => string> = {
        dwell_start: (name: string) => `Arrived at ${name || "a location"}`,
        dwell_end: (name: string) => `Left ${name || "a location"}`,
        trip_start: () => "Started a trip",
        trip_end: () => "Finished a trip",
      };

      type TimelineEntry = { text: string; baseText: string; time: string; rawTime: Date; category: "incident" | "checkin" | "context"; count: number };
      const rawTimeline: TimelineEntry[] = [];

      for (const inc of weekIncidents) {
        const reasonText = reasonMap[inc.reason] || inc.reason;
        let resolutionText = "";

        if (inc.status === "resolved" && inc.resolvedAt) {
          const lastCheckin = weekCheckins.find(
            (c) => c.createdAt && Math.abs(c.createdAt.getTime() - inc.resolvedAt!.getTime()) < 60000
          );
          if (lastCheckin) {
            resolutionText = `. ${methodMap[lastCheckin.method] || "Confirmed safe"}`;
          } else {
            resolutionText = ". Resolved shortly after";
          }
        } else if (inc.status === "open") {
          resolutionText = ". Awaiting response";
        }

        const entryText = `${reasonText}${resolutionText}`;
        rawTimeline.push({
          text: entryText,
          baseText: entryText,
          time: formatReportTime(inc.startedAt),
          rawTime: inc.startedAt,
          category: "incident",
          count: 1,
        });

        for (const entry of parseEscalationTimeline(inc.escalationTimeline)) {
          const entryTime = new Date(entry.time);
          if (entryTime < weekAgo || Number.isNaN(entryTime.getTime())) continue;
          rawTimeline.push({
            text: entry.detail,
            baseText: `${entry.type}:${entry.detail}`,
            time: formatReportTime(entryTime),
            rawTime: entryTime,
            category: "incident",
            count: 1,
          });
        }
      }

      for (const ctx of weekContext) {
        const formatter = contextMap[ctx.type];
        if (formatter) {
          const ctxText = formatter(ctx.placeName || "");
          rawTimeline.push({
            text: ctxText,
            baseText: ctxText,
            time: formatReportTime(ctx.createdAt),
            rawTime: ctx.createdAt,
            category: "context",
            count: 1,
          });
        }
      }

      rawTimeline.sort((a, b) => b.rawTime.getTime() - a.rawTime.getTime());

      const deduped: TimelineEntry[] = [];
      for (const entry of rawTimeline) {
        const existing = deduped.find(
          (d) =>
            d.baseText === entry.baseText &&
            Math.abs(d.rawTime.getTime() - entry.rawTime.getTime()) < 60 * 60 * 1000
        );
        if (existing) {
          existing.count++;
          existing.text = `${existing.baseText} (${existing.count} times)`;
        } else {
          deduped.push({ ...entry });
        }
      }

      const selfUser = await storage.getUser(userId);
      const totalIncidents = weekIncidents.length;
      const unresolvedIncidents = weekIncidents.filter((i) => i.status !== "resolved" && !i.isDrill);
      const slowResolutions = weekIncidents.filter((i) => {
        if (!i.resolvedAt) return false;
        return i.resolvedAt.getTime() - i.startedAt.getTime() > 30 * 60 * 1000;
      });
      const lastHbMs = selfUser?.lastHeartbeatAt ? new Date(selfUser.lastHeartbeatAt).getTime() : 0;
      const heartbeatAgeMs = lastHbMs ? now.getTime() - lastHbMs : Infinity;
      const heartbeatStale = heartbeatAgeMs > 4 * 60 * 60 * 1000;
      const safetyConcernNow = selfUser?.safetyState === "concern";
      const accountAgeMs = selfUser?.createdAt ? now.getTime() - new Date(selfUser.createdAt).getTime() : 0;
      const expectedCheckins = accountAgeMs > 3 * 24 * 60 * 60 * 1000;
      const zeroCheckinsWhenExpected = expectedCheckins && weekCheckins.length === 0;
      const currentlyOff = unresolvedIncidents.length > 0 || safetyConcernNow || heartbeatStale || zeroCheckinsWhenExpected;

      let summaryTone: "good" | "mixed" | "concern";
      let summary: string;

      if (currentlyOff) {
        summaryTone = "concern";
        if (unresolvedIncidents.length > 0) {
          summary =
            "There's an alert that hasn't been resolved yet this week. Your contacts were notified through the configured channels. Tap I'm OK as soon as you can so they know you're safe.";
        } else if (safetyConcernNow || heartbeatStale) {
          summary =
            "Your phone hasn't checked in for a while, so your safety status couldn't be confirmed right now. Open the app and tap I'm OK to let your Safety Circle know you're alright.";
        } else {
          summary =
            "There were no check-ins logged this week. Your Safety Circle hasn't heard from you. Open the app and tap I'm OK so they know you're safe.";
        }
      } else if (totalIncidents === 0) {
        summaryTone = "good";
        summary =
          "Everything looked steady this week. Check-ins were consistent and no concerns were raised. Keep it up. This is what a steady week looks like.";
      } else if (totalIncidents <= 2 && unresolvedIncidents.length === 0 && slowResolutions.length === 0) {
        summaryTone = "mixed";
        summary =
          "There were a few moments this week where we checked in a little closer. Each time, everything turned out okay. The system flagged moments worth checking and your contacts were notified as configured.";
      } else {
        summaryTone = "concern";
        summary =
          "This week had a few moments that needed attention. While everything was eventually resolved, it took a bit longer than usual in some cases. Your safety network was contacted as configured.";
      }

      const timeline = deduped.map(({ text, time }) => ({ text, time }));
      for (const entry of safetyActivity) {
        timeline.push({ text: entry.detail, time: formatReportTime(new Date(entry.time)) });
      }
      timeline.sort((a, b) => reportTimeSortValue(b.time) - reportTimeSortValue(a.time));

      res.json({
        summaryTone,
        summary,
        timeline,
        // weekStart / weekEnd kept for backward compatibility with older
        // clients. periodStart / periodEnd / period are the new canonical
        // fields the client renders against once it knows about them.
        weekStart: weekAgo.toISOString(),
        weekEnd: now.toISOString(),
        periodStart: weekAgo.toISOString(),
        periodEnd: now.toISOString(),
        period: periodParam === "day" || periodParam === "fortnight" || periodParam === "month" ? periodParam : "week",
        totalCheckins: weekCheckins.length,
      });
    } catch (error) {
      console.error("Error generating weekly report:", error);
      res.status(500).json({ error: "Failed to generate report" });
    }
  });

  app.get("/api/reports/preferences", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const prefs = await storage.getReportPreferences(userId);
      res.json(prefs);
    } catch (error) {
      console.error("Error fetching report preferences:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.put("/api/reports/preferences/:watchedUserId", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const watchedUserId = req.params.watchedUserId;
      const canView = await checkWatcherPermission(currentUserId, watchedUserId);
      if (!canView) {
        return res.status(403).json({ error: "Not authorized" });
      }
      const { frequency, enabled, email } = req.body;
      if (frequency && !["daily", "weekly", "fortnightly", "monthly"].includes(frequency)) {
        return res.status(400).json({ error: "Invalid frequency" });
      }
      const pref = await storage.upsertReportPreference({
        watcherId: currentUserId,
        watchedUserId,
        frequency: frequency || "weekly",
        enabled: enabled !== false,
        email: email || null,
      });
      res.json(pref);
    } catch (error) {
      console.error("Error updating report preference:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.get("/api/reports/:watchedUserId/weekly", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const watchedUserId = req.params.watchedUserId;
      const canView = await checkWatcherPermission(currentUserId, watchedUserId);
      if (!canView) return res.status(403).json({ error: "Not authorized" });
      const watchedSettings = await storage.getSettings(watchedUserId);
      if (watchedSettings && !watchedSettings.allowReports) {
        return res.status(403).json({ error: "User has disabled report sharing" });
      }

      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const weekIncidents = await db.select().from(incidents)
        .where(and(eq(incidents.userId, watchedUserId), gte(incidents.startedAt, weekAgo)))
        .orderBy(desc(incidents.startedAt));

      const weekCheckins = await db.select().from(checkins)
        .where(and(eq(checkins.userId, watchedUserId), gte(checkins.createdAt, weekAgo)))
        .orderBy(desc(checkins.createdAt));

      const weekContext = await db.select().from(contextEvents)
        .where(and(eq(contextEvents.userId, watchedUserId), gte(contextEvents.createdAt, weekAgo)))
        .orderBy(desc(contextEvents.createdAt));
      const safetyActivity = await buildSafetyActivityTimeline(watchedUserId, weekAgo, now);

      const reasonMap: Record<string, string> = {
        missed_checkin: "Missed check-in",
        sos: "SOS alert triggered",
        test: "Test alert",
        crash_detected: "Crash detected",
        safety_timer: "Safety timer expired",
        safe_walk: "Late arrival detected",
      };
      const methodMap: Record<string, string> = {
        button: "Confirmed safe in app",
        app: "Confirmed safe in app",
        sms: "Confirmed safe by SMS",
        auto: "Resolved automatically",
        call: "Confirmed safe by phone call",
        voice: "Confirmed safe by phone call",
      };
      const contextMap: Record<string, (name: string) => string> = {
        dwell_start: (name: string) => `Arrived at ${name || "a location"}`,
        dwell_end: (name: string) => `Left ${name || "a location"}`,
        trip_start: () => "Started a trip",
        trip_end: () => "Finished a trip",
      };

      type TimelineEntry = { text: string; baseText: string; time: string; rawTime: Date; category: string; count: number };
      const rawTimeline: TimelineEntry[] = [];

      for (const inc of weekIncidents) {
        const reasonText = reasonMap[inc.reason] || inc.reason;
        let resolutionText = "";
        if (inc.status === "resolved" && inc.resolvedAt) {
          const lastCheckin = weekCheckins.find(
            (c) => c.createdAt && Math.abs(c.createdAt.getTime() - inc.resolvedAt!.getTime()) < 60000
          );
          resolutionText = lastCheckin
            ? `. ${methodMap[lastCheckin.method] || "Confirmed safe"}`
            : ". Resolved shortly after";
        } else if (inc.status === "open") {
          resolutionText = ". Awaiting response";
        }
        const entryText = `${reasonText}${resolutionText}`;
        rawTimeline.push({ text: entryText, baseText: entryText, time: formatReportTime(inc.startedAt), rawTime: inc.startedAt, category: "incident", count: 1 });
        for (const entry of parseEscalationTimeline(inc.escalationTimeline)) {
          const entryTime = new Date(entry.time);
          if (entryTime < weekAgo || Number.isNaN(entryTime.getTime())) continue;
          rawTimeline.push({
            text: entry.detail,
            baseText: `${entry.type}:${entry.detail}`,
            time: formatReportTime(entryTime),
            rawTime: entryTime,
            category: "incident",
            count: 1,
          });
        }
      }

      for (const ctx of weekContext) {
        const formatter = contextMap[ctx.type];
        if (formatter) {
          const ctxText = formatter(ctx.placeName || "");
          rawTimeline.push({ text: ctxText, baseText: ctxText, time: formatReportTime(ctx.createdAt), rawTime: ctx.createdAt, category: "context", count: 1 });
        }
      }

      rawTimeline.sort((a, b) => b.rawTime.getTime() - a.rawTime.getTime());

      const deduped: TimelineEntry[] = [];
      for (const entry of rawTimeline) {
        const existing = deduped.find(
          (d) => d.baseText === entry.baseText && Math.abs(d.rawTime.getTime() - entry.rawTime.getTime()) < 60 * 60 * 1000
        );
        if (existing) {
          existing.count++;
          existing.text = `${existing.baseText} (${existing.count} times)`;
        } else {
          deduped.push({ ...entry });
        }
      }

      const user = await storage.getUser(watchedUserId);
      const watchedName = user?.name || "They";
      const totalIncidents = weekIncidents.length;
      const unresolvedIncidents = weekIncidents.filter((i) => i.status !== "resolved" && !i.isDrill);
      const slowResolutions = weekIncidents.filter((i) => {
        if (!i.resolvedAt) return false;
        return i.resolvedAt.getTime() - i.startedAt.getTime() > 30 * 60 * 1000;
      });
      const lastHbMs = user?.lastHeartbeatAt ? new Date(user.lastHeartbeatAt).getTime() : 0;
      const heartbeatAgeMs = lastHbMs ? now.getTime() - lastHbMs : Infinity;
      const heartbeatStale = heartbeatAgeMs > 4 * 60 * 60 * 1000;
      const safetyConcernNow = user?.safetyState === "concern";
      const accountAgeMs = user?.createdAt ? now.getTime() - new Date(user.createdAt).getTime() : 0;
      const expectedCheckins = accountAgeMs > 3 * 24 * 60 * 60 * 1000;
      const zeroCheckinsWhenExpected = expectedCheckins && weekCheckins.length === 0;
      const currentlyOff = unresolvedIncidents.length > 0 || safetyConcernNow || heartbeatStale || zeroCheckinsWhenExpected;

      let summaryTone: "good" | "mixed" | "concern";
      let summary: string;
      if (currentlyOff) {
        summaryTone = "concern";
        if (unresolvedIncidents.length > 0) {
          summary = `${watchedName} has an alert that hasn't been resolved yet this week. You were notified through the configured channels. If you haven't already, reach out to make sure they're safe.`;
        } else if (safetyConcernNow || heartbeatStale) {
          summary = `${watchedName}'s phone hasn't checked in for a while, so their safety status couldn't be confirmed right now. It might be worth a quick call or message to make sure they're okay.`;
        } else {
          summary = `${watchedName} hasn't logged any check-ins this week. It might be worth reaching out to see how they're doing.`;
        }
      } else if (totalIncidents === 0) {
        summaryTone = "good";
        summary = "Everything looked steady this week. Check-ins were consistent and no concerns were raised. Keep it up.";
      } else if (totalIncidents <= 2 && unresolvedIncidents.length === 0 && slowResolutions.length === 0) {
        summaryTone = "mixed";
        summary = "There were a few moments this week where we checked in a little closer. Each time, everything turned out okay.";
      } else {
        summaryTone = "concern";
        summary = "This week had a few moments that needed attention. While everything was eventually resolved, it took a bit longer than usual in some cases.";
      }
      res.json({
        summaryTone,
        summary,
        timeline: [
          ...deduped.map(({ text, time }) => ({ text, time })),
          ...safetyActivity.map((entry) => ({ text: entry.detail, time: formatReportTime(new Date(entry.time)) })),
        ].sort((a, b) => reportTimeSortValue(b.time) - reportTimeSortValue(a.time)),
        weekStart: weekAgo.toISOString(),
        weekEnd: now.toISOString(),
        totalCheckins: weekCheckins.length,
        userName: user?.name || "Unknown",
      });
    } catch (error) {
      console.error("Error generating watcher weekly report:", error);
      res.status(500).json({ error: "Failed to generate report" });
    }
  });

  app.get("/api/reports/:watchedUserId", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const watchedUserId = req.params.watchedUserId;
      const canView = await checkWatcherPermission(currentUserId, watchedUserId);
      if (!canView) {
        return res.status(403).json({ error: "Not authorized" });
      }
      const watchedSettings = await storage.getSettings(watchedUserId);
      if (watchedSettings && !watchedSettings.allowReports) {
        return res.status(403).json({ error: "User has disabled report sharing" });
      }

      const periodParam = (req.query.period as string) || "week";
      const now = new Date();
      let from: Date;
      switch (periodParam) {
        case "day": from = new Date(now.getTime() - 86400000); break;
        case "fortnight": from = new Date(now.getTime() - 14 * 86400000); break;
        case "month": from = new Date(now.getTime() - 30 * 86400000); break;
        case "week":
        default: from = new Date(now.getTime() - 7 * 86400000); break;
      }

      const user = await storage.getUser(watchedUserId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const userSettings = await storage.getSettings(watchedUserId);
      const checkinList = await storage.getCheckinHistory(watchedUserId, from, now);
      const incidentList = await storage.getIncidentHistory(watchedUserId, from, now);
      const safetyActivity = await buildSafetyActivityTimeline(watchedUserId, from, now);

      const dayCount = Math.max(1, Math.ceil((now.getTime() - from.getTime()) / 86400000));
      const expectedCheckins = dayCount;
      const missedCheckins = Math.max(0, expectedCheckins - checkinList.length);
      const complianceRate = checkinList.length > 0 ? Math.round((checkinList.length / expectedCheckins) * 100) : 0;

      // Heart-rate section is omitted entirely when the watched user has not
      // opted in to monitoring. This matches the Privacy Nutrition Label
      // promise that we do not collect or report HR data without consent.
      let heartRateSummary = null;
      const hrCfgForReport = await storage.getUserHeartRateConfig(watchedUserId);
      if (hrCfgForReport.monitoring) {
        const hrHistory = await storage.getHeartRateHistory(watchedUserId, dayCount * 24);
        if (hrHistory.length > 0) {
          const bpms = hrHistory.map(r => r.bpm);
          const hrAlerts = hrCfgForReport.alerts
            ? await storage.getActiveHeartRateAlerts(watchedUserId)
            : [];
          heartRateSummary = {
            avgBpm: Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length),
            minBpm: Math.min(...bpms),
            maxBpm: Math.max(...bpms),
            alerts: hrAlerts.length,
          };
        }
      }

      const fallAlerts = incidentList.filter(i => i.reason === "sos").length;

      let drivingSummary = null;
      try {
        const allSessions = await storage.getDriveHistory(watchedUserId, 100);
        const driveSess = allSessions.filter(s => new Date(s.startedAt) >= from);
        if (driveSess.length > 0) {
          const allAlerts = await storage.getSpeedAlerts(watchedUserId);
          const sessIds = new Set(driveSess.map(s => s.id));
          const driveAlerts = allAlerts.filter(a => a.sessionId && sessIds.has(a.sessionId));
          drivingSummary = {
            totalDrives: driveSess.length,
            totalDistanceKm: Math.round(driveSess.reduce((sum, s) => sum + (s.distanceKm || 0), 0) * 10) / 10,
            topSpeedKmh: Math.round(Math.max(...driveSess.map(s => s.maxSpeedKmh || 0))),
            speedingEvents: driveAlerts.length,
            crashEvents: driveSess.filter(s => s.crashDetected).length,
          };
        }
      } catch (err: any) {
        console.error(`[REPORT] Driving stats aggregation failed:`, err?.message || err);
      }

      const { format: fmtDate } = await import("date-fns");

      const report = {
        userName: user.name,
        periodStart: fmtDate(from, "yyyy-MM-dd"),
        periodEnd: fmtDate(now, "yyyy-MM-dd"),
        checkins: checkinList.map(c => ({
          date: fmtDate(c.createdAt, "yyyy-MM-dd"),
          time: fmtDate(c.createdAt, "h:mm a"),
          method: c.method,
        })),
        totalCheckins: checkinList.length,
        missedCheckins,
        complianceRate: Math.min(100, complianceRate),
        safetyTimeline: safetyActivity,
        incidents: incidentList.map(i => ({
          date: fmtDate(i.startedAt, "yyyy-MM-dd"),
          reason: inferIncidentReportReason(i),
          resolved: i.status === "resolved",
          duration: i.resolvedAt
            ? `${Math.round((i.resolvedAt.getTime() - i.startedAt.getTime()) / 60000)} min`
            : null,
          escalationTimeline: parseEscalationTimeline(i.escalationTimeline).map((entry) => ({
            ...entry,
            time: fmtDate(new Date(entry.time), "yyyy-MM-dd h:mm a"),
          })),
        })),
        // Omit `heartRateSummary` entirely (not even the key) when the user
        // has not opted in to monitoring. The frontend treats it as optional.
        ...(heartRateSummary ? { heartRateSummary } : {}),
        drivingSummary,
        locationEnabled: userSettings?.locationMode !== "off",
        fallDetectionEnabled: userSettings?.fallDetection || false,
        fallAlerts,
      };

      res.json(report);
    } catch (error) {
      console.error("Error generating report:", error);
      res.status(500).json({ error: "Failed to generate report" });
    }
  });

  async function getWatcherContact(watcherUserId: string, watchedUserId: string) {
    const linkedContacts = await storage.getContactsLinkedToUser(watcherUserId);
    return linkedContacts.find(c => c.userId === watchedUserId);
  }

  async function checkWatcherPermission(watcherUserId: string, watchedUserId: string): Promise<boolean> {
    return !!(await getWatcherContact(watcherUserId, watchedUserId));
  }

  async function checkWatcherLocationPermission(watcherUserId: string, watchedUserId: string): Promise<boolean> {
    const contact = await getWatcherContact(watcherUserId, watchedUserId);
    return !!contact && contact.canViewLocation !== false;
  }

  // ===== SAFETY TIMER (Dead Man's Switch) =====
  async function getCurrentSafetyTimerForTrail(userId: string) {
    const active = await storage.getActiveSafetyTimer(userId);
    if (active) return active;

    const [latestAttentionTimer] = await db.select().from(safetyTimers)
      .where(and(
        eq(safetyTimers.userId, userId),
        inArray(safetyTimers.status, ["active", "grace_period", "escalated"]),
      ))
      .orderBy(desc(safetyTimers.startedAt))
      .limit(1);

    return latestAttentionTimer;
  }

  async function getCurrentSafeWalkForAttention(userId: string) {
    const active = await storage.getActiveSafeWalk(userId);
    if (active) return active;

    const [latestAttentionWalk] = await db.select().from(safeWalks)
      .where(and(
        eq(safeWalks.userId, userId),
        inArray(safeWalks.status, ["active", "overdue", "escalated"]),
      ))
      .orderBy(desc(safeWalks.startedAt))
      .limit(1);

    return latestAttentionWalk;
  }

  app.post("/api/safety-timer/start", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const { durationMinutes, note } = req.body;
      if (!durationMinutes || durationMinutes < 5 || durationMinutes > 1440) {
        return res.status(400).json({ error: "Duration must be between 5 and 1440 minutes" });
      }
      const existing = await storage.getActiveSafetyTimer(userId);
      if (existing) {
        return res.status(400).json({ error: "You already have an active safety timer" });
      }
      const timer = await storage.createSafetyTimer(userId, durationMinutes, note);
      emitTrackingPolicyChanged(userId, "safety_timer_start").catch(() => {});
      const user = await storage.getUser(userId);
      sendLinkedWatcherPresencePush(
        userId,
        `${user?.name || "Someone"} started a Safety Timer`,
        `StillHere will alert contacts if they do not confirm they are safe in ${durationMinutes} minutes.`,
        "safety-timer-start",
      ).catch((err) => console.warn("[TIMER] watcher push failed:", err?.message || err));
      res.json(timer);
    } catch (error) {
      console.error("Error starting safety timer:", error);
      res.status(500).json({ error: "Failed to start safety timer" });
    }
  });

  app.get("/api/safety-timer/active", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const timer = await storage.getActiveSafetyTimer(userId);
      res.json(timer || null);
    } catch (error) {
      res.status(500).json({ error: "Failed to get active timer" });
    }
  });

  app.get("/api/safety-timer/current", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const active = await storage.getActiveSafetyTimer(userId);
      if (active) return res.json(active);

      const [latest] = await db.select().from(safetyTimers)
        .where(eq(safetyTimers.userId, userId))
        .orderBy(desc(safetyTimers.startedAt))
        .limit(1);

      res.json(latest || null);
    } catch (error) {
      console.error("Error getting current safety timer:", error);
      res.status(500).json({ error: "Failed to get current timer" });
    }
  });

  app.post("/api/safety-timer/cancel", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const timer = await storage.getActiveSafetyTimer(userId);
      if (!timer) return res.status(404).json({ error: "No active timer found" });
      await storage.updateSafetyTimer(timer.id, { status: "safe", resolvedAt: new Date() });
      emitTrackingPolicyChanged(userId, "safety_timer_cancel").catch(() => {});
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to cancel timer" });
    }
  });

  app.post("/api/safety-timer/extend", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const { additionalMinutes } = req.body;
      if (!additionalMinutes || additionalMinutes < 5 || additionalMinutes > 480) {
        return res.status(400).json({ error: "Extension must be between 5 and 480 minutes" });
      }
      const timer = await storage.getActiveSafetyTimer(userId);
      if (!timer) return res.status(404).json({ error: "No active timer found" });
      const newExpiry = new Date(timer.expiresAt.getTime() + additionalMinutes * 60 * 1000);
      const updated = await storage.updateSafetyTimer(timer.id, {
        expiresAt: newExpiry,
        status: "active",
        durationMinutes: timer.durationMinutes + additionalMinutes,
      });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to extend timer" });
    }
  });

  app.post("/api/safety-timer/location", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const { lat, lng, speed, activity } = req.body;
      const timer = await storage.getActiveSafetyTimer(userId);
      if (!timer) return res.status(404).json({ error: "No active timer" });
      const stPolicy = await getTrackingPolicyForUser(userId);
      if (!stPolicy.nativeTrackingAllowed) {
        console.log(`[TRACKING_POLICY] safety-timer/location rejected (no allowed policy)`);
        return res.status(403).json({ error: "Tracking not allowed", policy: stPolicy });
      }
      await storage.updateSafetyTimer(timer.id, {
        lastLat: lat,
        lastLng: lng,
        lastSpeed: speed || null,
        lastActivity: activity || null,
        lastLocationAt: new Date(),
      });
      await storage.addTripPoint({
        tripId: timer.id,
        tripType: "timer",
        userId: userId,
        lat, lng, speed, activity,
      });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to update location" });
    }
  });

  app.get("/api/safety-timer/trail", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const timer = await getCurrentSafetyTimerForTrail(userId);
      if (!timer) return res.json([]);
      const points = await storage.getTripPoints(timer.id, "timer");
      res.json(points);
    } catch (error) {
      res.status(500).json({ error: "Failed to get trail" });
    }
  });

  // ===== SAFE WALK / SAFE RIDE =====
  app.post("/api/safe-walk/start", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const { destinationLat, destinationLng, destinationName, destinationType, expectedMinutes, note, arrivalRadiusMeters } = req.body;
      if (destinationLat == null || destinationLng == null || !expectedMinutes) {
        return res.status(400).json({ error: "Destination and expected time required" });
      }
      const existing = await storage.getActiveSafeWalk(userId);
      if (existing) {
        return res.status(400).json({ error: "You already have an active Safe Walk" });
      }
      const expectedArrivalAt = new Date(Date.now() + expectedMinutes * 60 * 1000);
      const walk = await storage.createSafeWalk(userId, {
        destinationLat,
        destinationLng,
        destinationName,
        destinationType: destinationType || "pin",
        expectedArrivalAt,
        note,
        arrivalRadiusMeters: arrivalRadiusMeters || 200,
      });
      emitTrackingPolicyChanged(userId, "safe_walk_start").catch(() => {});
      const user = await storage.getUser(userId);
      const destLabel = destinationName ? ` to ${destinationName}` : "";
      sendLinkedWatcherPresencePush(
        userId,
        `${user?.name || "Someone"} started Safe Walk`,
        `They are on their way${destLabel}. StillHere will alert contacts if they do not arrive.`,
        "safe-walk-start",
      ).catch((err) => console.warn("[SAFE-WALK] watcher push failed:", err?.message || err));
      res.json(walk);
    } catch (error) {
      console.error("Error starting safe walk:", error);
      res.status(500).json({ error: "Failed to start Safe Walk" });
    }
  });

  app.get("/api/safe-walk/active", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const walk = await storage.getActiveSafeWalk(userId);
      res.json(walk || null);
    } catch (error) {
      res.status(500).json({ error: "Failed to get active walk" });
    }
  });

  app.get("/api/safe-walk/current", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const active = await storage.getActiveSafeWalk(userId);
      if (active) return res.json(active);

      const [latest] = await db.select().from(safeWalks)
        .where(eq(safeWalks.userId, userId))
        .orderBy(desc(safeWalks.startedAt))
        .limit(1);

      res.json(latest || null);
    } catch (error) {
      console.error("Error getting current Safe Walk:", error);
      res.status(500).json({ error: "Failed to get current Safe Walk" });
    }
  });

  app.post("/api/safe-walk/cancel", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const walk = await storage.getActiveSafeWalk(userId);
      if (!walk) return res.status(404).json({ error: "No active Safe Walk" });
      await storage.updateSafeWalk(walk.id, { status: "cancelled", resolvedAt: new Date() });
      emitTrackingPolicyChanged(userId, "safe_walk_cancel").catch(() => {});
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to cancel walk" });
    }
  });

  app.post("/api/safe-walk/arrived", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const walk = await storage.getActiveSafeWalk(userId);
      if (!walk) return res.status(404).json({ error: "No active Safe Walk" });
      await storage.updateSafeWalk(walk.id, { status: "arrived", resolvedAt: new Date() });
      emitTrackingPolicyChanged(userId, "safe_walk_arrived").catch(() => {});
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to mark arrival" });
    }
  });

  app.post("/api/safe-walk/extend", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const { additionalMinutes } = req.body;
      if (!additionalMinutes || additionalMinutes < 5 || additionalMinutes > 480) {
        return res.status(400).json({ error: "Extension must be between 5 and 480 minutes" });
      }
      const walk = await storage.getActiveSafeWalk(userId);
      if (!walk) return res.status(404).json({ error: "No active Safe Walk" });
      const newExpiry = new Date(walk.expectedArrivalAt.getTime() + additionalMinutes * 60 * 1000);
      const updated = await storage.updateSafeWalk(walk.id, {
        expectedArrivalAt: newExpiry,
        status: "active",
      });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to extend walk" });
    }
  });

  app.post("/api/safe-walk/location", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const { lat, lng, speed, activity } = req.body;
      const walk = await storage.getActiveSafeWalk(userId);
      if (!walk) return res.status(404).json({ error: "No active Safe Walk" });
      const swPolicy = await getTrackingPolicyForUser(userId);
      if (!swPolicy.nativeTrackingAllowed) {
        console.log(`[TRACKING_POLICY] safe-walk/location rejected (no allowed policy)`);
        return res.status(403).json({ error: "Tracking not allowed", policy: swPolicy });
      }

      await storage.updateSafeWalk(walk.id, {
        lastLat: lat,
        lastLng: lng,
        lastSpeed: speed || null,
        lastActivity: activity || null,
        lastLocationAt: new Date(),
      });
      await storage.addTripPoint({
        tripId: walk.id,
        tripType: "walk",
        userId: userId,
        lat, lng, speed, activity,
      });

      const distanceToDestination = getDistanceMeters(lat, lng, walk.destinationLat, walk.destinationLng);

      if (distanceToDestination <= walk.arrivalRadiusMeters) {
        await storage.updateSafeWalk(walk.id, { status: "arrived", resolvedAt: new Date() });
        return res.json({ success: true, arrived: true });
      }

      if (speed && speed > 0.5) {
        const distKm = distanceToDestination / 1000;
        const speedKmh = speed * 3.6;
        const etaMinutes = Math.ceil((distKm / speedKmh) * 60 * 1.15);
        const newArrival = new Date(Date.now() + Math.max(5, etaMinutes) * 60000);
        await storage.updateSafeWalk(walk.id, { expectedArrivalAt: newArrival });
      }

      res.json({ success: true, arrived: false, distanceToDestination: Math.round(distanceToDestination) });
    } catch (error) {
      res.status(500).json({ error: "Failed to update location" });
    }
  });

  app.get("/api/safe-walk/trail", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const walk = await getCurrentSafeWalkForAttention(userId);
      if (!walk) return res.json([]);
      const points = await storage.getTripPoints(walk.id, "walk");
      res.json(points);
    } catch (error) {
      res.status(500).json({ error: "Failed to get trail" });
    }
  });

  app.get("/api/safe-walk/watched/:userId", async (req, res) => {
    const watcherId = getUserId(req);
    if (!watcherId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const targetUserId = String(req.params.userId);
      const canViewLocation = await checkWatcherLocationPermission(watcherId, targetUserId);
      if (!canViewLocation) return res.status(403).json({ error: "Not authorized to view this user's safe walk" });

      const walk = await getCurrentSafeWalkForAttention(targetUserId);
      if (!walk) return res.json(null);

      res.json({
        id: walk.id,
        destinationLat: walk.destinationLat,
        destinationLng: walk.destinationLng,
        destinationName: walk.destinationName,
        expectedArrival: walk.expectedArrivalAt,
        status: walk.status,
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to get safe walk" });
    }
  });

  // Helper: Calculate distance between two GPS coordinates in meters
  function getDistanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ===== AUTOMATED WELLNESS CHECK CALL =====
  // Map of country (ISO-2) -> local emergency services number. Used so the
  // wellness call says the right number for the user's actual location, not a
  // hard-coded "911". Falls back to a generic phrase below.
  const EMERGENCY_NUMBERS: Record<string, string> = {
    US: "911", CA: "911", MX: "911",
    GB: "999", IE: "999", KE: "999", HK: "999", SG: "999",
    AU: "000", NZ: "111",
    DE: "112", FR: "112", ES: "112", IT: "112", NL: "112", BE: "112",
    PT: "112", AT: "112", SE: "112", DK: "112", FI: "112", NO: "112",
    CH: "112", PL: "112", CZ: "112", HU: "112", GR: "112", RO: "112",
    IS: "112", LU: "112", EE: "112", LV: "112", LT: "112", BG: "112",
    HR: "112", SK: "112", SI: "112", TR: "112",
    IN: "112", KR: "112", IL: "112",
    JP: "110", CN: "110", TW: "110",
    BR: "190", AR: "911", CL: "133",
    ZA: "10111", AE: "999", SA: "999",
  };

  // Crude timezone -> country fallback for when we have no GPS yet.
  function countryFromTimezone(tz: string | null | undefined): string | null {
    if (!tz) return null;
    if (tz.startsWith("Australia/")) return "AU";
    if (tz === "Pacific/Auckland" || tz === "Pacific/Chatham") return "NZ";
    if (tz === "Europe/London" || tz === "Europe/Belfast") return "GB";
    if (tz === "Europe/Dublin") return "IE";
    if (tz.startsWith("Europe/")) return "DE"; // any EU -> 112
    if (tz === "Asia/Tokyo") return "JP";
    if (tz === "Asia/Shanghai" || tz === "Asia/Hong_Kong") return "CN";
    if (tz === "Asia/Seoul") return "KR";
    if (tz === "Asia/Kolkata" || tz === "Asia/Calcutta") return "IN";
    if (tz === "Asia/Singapore") return "SG";
    if (tz === "Asia/Dubai") return "AE";
    if (tz.startsWith("America/Toronto") || tz.startsWith("America/Vancouver") || tz.startsWith("America/Montreal") || tz.startsWith("America/Halifax") || tz.startsWith("America/Edmonton") || tz.startsWith("America/Winnipeg")) return "CA";
    if (tz.startsWith("America/Mexico")) return "MX";
    if (tz.startsWith("America/Sao_Paulo") || tz.startsWith("America/Bahia") || tz.startsWith("America/Fortaleza")) return "BR";
    if (tz.startsWith("America/")) return "US";
    if (tz === "Africa/Johannesburg") return "ZA";
    return null;
  }

  // Reverse-geocode lat/lng -> ISO country code via Google. Aggressively
  // timed out (1.5s) because this runs on the wellness-call TwiML hot path
  // and we'd rather fall back to timezone than make the user wait on the line.
  async function countryFromLatLng(lat: number, lng: number): Promise<string | null> {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) return null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      const resp = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&result_type=country&key=${key}`,
        { signal: ctrl.signal }
      );
      clearTimeout(timer);
      const data: any = await resp.json();
      const country = data?.results?.[0]?.address_components?.find((c: any) => c.types?.includes("country"));
      return country?.short_name || null;
    } catch {
      return null;
    }
  }

  // Returns the best emergency number we can determine for this user.
  // Priority: GPS reverse-geocode -> timezone heuristic -> "911" default.
  // Also returns a friendly phrase usable in TwiML/SMS.
  async function getEmergencyInfoForUser(user: { id: string; timezone: string; lastHeartbeatLat: number | null; lastHeartbeatLng: number | null }): Promise<{ number: string; phrase: string; country: string | null }> {
    let country: string | null = null;
    if (user.lastHeartbeatLat != null && user.lastHeartbeatLng != null) {
      country = await countryFromLatLng(user.lastHeartbeatLat, user.lastHeartbeatLng);
    }
    if (!country) country = countryFromTimezone(user.timezone);
    const number = (country && EMERGENCY_NUMBERS[country]) || "911";
    const phrase = country
      ? `your local emergency services on ${number}`
      : `your local emergency services, ${number}`;
    return { number, phrase, country };
  }

  // Reusable: wrap text in calm-paced SSML for Polly Joanna Neural.
  // Polly Neural voices sound much more natural than Google Neural2 over the
  // phone, and prosody rate=92% gives a measured, professional pace.
  const calm = (text: string) => `<prosody rate="92%">${text}</prosody>`;

  async function appendWellnessTimeline(userId: string, type: string, detail: string): Promise<void> {
    const incident = await storage.getLatestRealOpenIncident(userId);
    if (!incident || incident.isDrill) return;
    let timeline: any[] = [];
    try { timeline = JSON.parse(incident.escalationTimeline || "[]"); } catch {}
    timeline.push({ type, time: new Date().toISOString(), detail });
    await storage.updateIncident(incident.id, { escalationTimeline: JSON.stringify(timeline) });
  }

  function wellnessStatusRank(status: string | null | undefined): number {
    switch (status) {
      case "safe":
      case "help":
        return 100;
      case "voicemail_left":
        return 60;
      case "no_response":
      case "failed":
        return 40;
      case "answered_human":
        return 30;
      case "placed":
        return 10;
      default:
        return 0;
    }
  }

  async function updateWellnessCallStatusForPhone(phone: string | null, status: string, detail?: string): Promise<void> {
    if (!phone) return;
    const normalizedPhone = phone.startsWith("+") ? phone : `+${phone}`;
    const user = await storage.getUserByPhone(normalizedPhone);
    if (!user) {
      console.error(`[WELLNESS CALL] No user found for callback phone ***${normalizedPhone.slice(-4)}`);
      return;
    }
    const incident = await storage.getLatestRealOpenIncident(user.id);
    if (!incident || incident.isDrill) return;
    if (incident.wellnessCallStatus === "safe" || incident.wellnessCallStatus === "help") return;
    if (wellnessStatusRank(status) < wellnessStatusRank(incident.wellnessCallStatus)) {
      console.log(`[WELLNESS CALL] Keeping existing status ${incident.wellnessCallStatus} over lower-priority ${status} for incident=${incident.id}`);
      return;
    }
    await storage.updateIncident(incident.id, { wellnessCallStatus: status as any });
    if (detail) await appendWellnessTimeline(user.id, `wellness_call_${status}`, detail);
    try {
      const watcherContacts = await storage.getContactsLinkedToUser(user.id);
      for (const c of watcherContacts) {
        if (c.linkedUserId) emitToUser(c.linkedUserId, "watched-users:invalidate", { userId: user.id });
      }
    } catch {}
  }

  app.post("/api/wellness-call/status", verifyTwilioSignature, async (req, res) => {
    try {
      const callStatus = String(req.body.CallStatus || "").toLowerCase();
      const answeredBy = String(req.body.AnsweredBy || "").toLowerCase();
      const to = req.body.To ? String(req.body.To) : null;
      const duration = String(req.body.CallDuration || req.body.Duration || "");
      const durationSeconds = Number.parseInt(duration || "0", 10) || 0;

      if (answeredBy.includes("machine") || answeredBy === "fax") {
        await updateWellnessCallStatusForPhone(to, "voicemail_left", `Wellness call reached voicemail (${answeredBy || "machine"})`);
      } else if (answeredBy === "human") {
        await updateWellnessCallStatusForPhone(to, "answered_human", "Wellness call answered by user");
      } else if (["no-answer", "busy", "failed", "canceled"].includes(callStatus)) {
        await updateWellnessCallStatusForPhone(to, callStatus === "no-answer" ? "no_response" : "failed", `Wellness call ended with status: ${callStatus}`);
      } else if (callStatus === "completed" && durationSeconds === 0) {
        await updateWellnessCallStatusForPhone(to, "no_response", "Wellness call completed with no connected duration");
      } else if (callStatus === "completed" && durationSeconds > 0 && !answeredBy) {
        // Some carriers/Twilio AMD results do not include AnsweredBy on the
        // final callback even when the call rolled to voicemail. If the user
        // pressed 1 or 2, the incident is already terminal and this helper will
        // not override it. Otherwise, treat a connected call with no keypad
        // response as voicemail/no direct contact so watcher screens do not
        // imply the user personally answered.
        await updateWellnessCallStatusForPhone(to, "voicemail_left", "Wellness call connected but received no keypad response; likely voicemail");
      }

      res.type("text/xml").send("<Response></Response>");
    } catch (error) {
      console.error("Error in wellness call status callback:", error);
      res.type("text/xml").send("<Response></Response>");
    }
  });

  app.post("/api/wellness-call/respond", verifyTwilioSignature, async (req, res) => {
    try {
      const answeredBy = String(req.body.AnsweredBy || "").toLowerCase();
      const calledNumber = req.body.To ? String(req.body.To) : null;
      if (answeredBy.includes("machine") || answeredBy === "fax") {
        await updateWellnessCallStatusForPhone(calledNumber, "voicemail_left", `Wellness call reached voicemail (${answeredBy || "machine"})`);
        const twimlVoicemail = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${calm("Hi, this is StillHere calling for your scheduled check-in. We could not reach you directly. Please open StillHere or reply to your check-in message as soon as you can.")}</Say>
  <Hangup/>
</Response>`;
        return res.type("text/xml").send(twimlVoicemail);
      }
      if (answeredBy === "human") {
        await updateWellnessCallStatusForPhone(calledNumber, "answered_human", "Wellness call answered by user");
      }
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="/api/wellness-call/gather" method="POST" timeout="15" actionOnEmptyResult="true">
    <Say voice="Polly.Joanna-Neural">${calm("Hello, this is StillHere. We noticed you missed your safety check-in.")}</Say>
    <Pause length="1"/>
    <Say voice="Polly.Joanna-Neural">${calm("Press 1 if you're okay. Press 2 if you need help.")}</Say>
    <Pause length="3"/>
    <Say voice="Polly.Joanna-Neural">${calm("Take your time. Press 1 if you're safe. Press 2 if you need help.")}</Say>
  </Gather>
  <Say voice="Polly.Joanna-Neural">${calm("No response was received. We will continue the safety flow and attempt to reach your safety circle shortly. Take care.")}</Say>
  <Hangup/>
</Response>`;
      res.type("text/xml").send(twiml);
    } catch (error) {
      console.error("Error in wellness call TwiML:", error);
      res.status(500).send("");
    }
  });

  app.post("/api/wellness-call/gather", verifyTwilioSignature, async (req, res) => {
    try {
      const digits = req.body.Digits;
      const calledNumber = req.body.To;

      const normalizedPhone = calledNumber ? (calledNumber.startsWith("+") ? calledNumber : `+${calledNumber}`) : null;
      const user = normalizedPhone ? await storage.getUserByPhone(normalizedPhone) : null;

      if (digits === "1" && user) {
        // Use the latest real (non-drill) open incident. If wellnessCallStatus
        // already terminal (e.g. duplicate webhook delivery), short-circuit.
        const openIncidentForUser = await storage.getLatestRealOpenIncident(user.id);
        if (openIncidentForUser?.wellnessCallStatus === "safe" || openIncidentForUser?.wellnessCallStatus === "help") {
          console.log(`[WELLNESS CALL] Press 1 received but incident ${openIncidentForUser.id} already terminal (${openIncidentForUser.wellnessCallStatus}). Ignoring duplicate.`);
          const twimlDup = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Joanna-Neural">${calm("Thank you. You are already checked in. Take care.")}</Say><Hangup/></Response>`;
          return res.type("text/xml").send(twimlDup);
        }
        if (openIncidentForUser) {
          await storage.updateIncident(openIncidentForUser.id, { wellnessCallStatus: "safe" });
        }
        const result = await resolveCheckin(user.id, "call");
        console.log(`[WELLNESS CALL] User ***${(user.phone || user.id).slice(-4)} confirmed safe via phone call, hadIncident=${result.hadIncident}`);
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${calm("Wonderful. Thank you for confirming.")}</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna-Neural">${calm("You are now checked in, and we are letting your safety circle know that you are safe.")}</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna-Neural">${calm("Take care, and have a lovely day.")}</Say>
  <Pause length="1"/>
  <Hangup/>
</Response>`;
        return res.type("text/xml").send(twiml);
      }

      if (digits === "2" && user) {
        console.log(`[WELLNESS CALL] User ***${(user.phone || user.id).slice(-4)} pressed 2. SOS triggered via phone call.`);

        // Reuse the latest real (non-drill) open incident if one exists.
        // Never mutate a drill incident into a real SOS. If the only open
        // incident is a drill, create a fresh SOS incident alongside it.
        let incident = await storage.getLatestRealOpenIncident(user.id);

        // Idempotency: if this incident already records wellnessCallStatus
        // "help" (duplicate Twilio webhook delivery), skip the fan-out.
        if (incident?.wellnessCallStatus === "help") {
          console.log(`[WELLNESS CALL] Press 2 received but incident ${incident.id} already marked help. Ignoring duplicate.`);
          const twimlDup = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Joanna-Neural">${calm("We hear you. We are reaching out to your safety circle right now. We are right here with you.")}</Say><Pause length="2"/><Redirect method="POST">/api/wellness-call/comfort?cycle=1</Redirect></Response>`;
          return res.type("text/xml").send(twimlDup);
        }

        if (incident) {
          await storage.updateIncident(incident.id, {
            reason: "sos",
            wellnessCallStatus: "help",
          });
        } else {
          incident = await storage.createIncident(user.id, "sos");
          await storage.updateIncident(incident.id, { wellnessCallStatus: "help" });
        }
        await storage.updateSafetyState(user.id, "concern", "User pressed 2 on wellness call. Needs help.");
        emitTrackingPolicyChanged(user.id, "wellness_call_help").catch(() => {});

        // Fan out to ALL contacts in parallel (SMS + push)  -  the user audibly
        // confirmed they need help, so we don't wait for sequential escalation.
        const sosCont = await storage.getContacts(user.id);
        const sortedSos = [...sosCont].sort((a, b) => a.priority - b.priority);
        // Phase 2: incident-scoped tokens for the active wellness-call incident.
        const sosTokens = await storage.getOrMintIncidentTokensForUser(user.id, incident.startedAt);
        const sosBaseUrl = getBaseUrl();
        const notifiedIds: string[] = [];

        await Promise.all(sortedSos.map(async (contact) => {
          const tok = sosTokens.find(t => t.contact.id === contact.id);
          if (!tok) return;
          const link = `${sosBaseUrl}/emergency/${tok.token}`;
          try {
            await notifyContact(contact, user.name, link, "sos", sendSosAlert, { incidentId: incident.id, ipAddress: req.ip });
            notifiedIds.push(contact.id);
          } catch (err: any) {
            console.error(`[WELLNESS CALL] SOS notify failed for contact ${contact.id}:`, err?.message || err);
          }
        }));

        const now = new Date();
        const existingTimeline: any[] = (() => {
          try { return JSON.parse(incident.escalationTimeline || "[]"); } catch { return []; }
        })();
        existingTimeline.push({
          type: "wellness_call_help",
          time: now.toISOString(),
          detail: `User pressed 2 on wellness call. Notified ${notifiedIds.length} contact(s)`,
        });
        await storage.updateIncident(incident.id, {
          escalationLevel: Math.max(incident.escalationLevel || 0, 1),
          lastEscalationStep: "wellness_call_help",
          notifiedContactIds: JSON.stringify(notifiedIds),
          lastContactNotifiedAt: now,
          contact1NotifiedAt: incident.contact1NotifiedAt || now,
          nextActionAt: addMinutes(now, 5),
          escalationTimeline: JSON.stringify(existingTimeline),
        });

        // Push to all linked watcher accounts in-app
        await notifyConcern(user.id, user.name, "sos").catch((err) => {
          console.error(`[WELLNESS CALL] notifyConcern failed:`, err?.message || err);
        });

        // Real-time socket broadcast so watcher dashboards refresh instantly
        try {
          const watcherContacts = await storage.getContactsLinkedToUser(user.id);
          for (const c of watcherContacts) {
            if (c.linkedUserId) {
              emitToUser(c.linkedUserId, "watched-users:invalidate", { userId: user.id });
            }
          }
        } catch (err: any) {
          console.error(`[WELLNESS CALL] Socket broadcast failed:`, err?.message || err);
        }

        console.log(`[WELLNESS CALL] SOS notified ${notifiedIds.length}/${sortedSos.length} contacts for user=${user.id}`);

        // ----- "We care" wraparound: keep the user supported, don't just hang up -----
        // Resolve the user's local emergency number from their last known
        // location (GPS) with timezone fallback, so we say "999" in the UK,
        // "000" in Australia, "112" in the EU, etc.  -  not just "911".
        const emergency = await getEmergencyInfoForUser(user as any);
        console.log(`[WELLNESS CALL] Local emergency number for user=${user.id}: ${emergency.number} (country=${emergency.country || "unknown"})`);

        // 1. Text the USER themselves so they have a written record of who's coming
        //    and a clear local-emergency prompt, even if they hang up the call.
        if (user.phone) {
          const notifiedNames = sortedSos
            .filter(c => notifiedIds.includes(c.id))
            .map(c => c.name);
          const namesLine = notifiedNames.length > 0
            ? `${notifiedNames.slice(0, 3).join(", ")}${notifiedNames.length > 3 ? ` and ${notifiedNames.length - 3} more` : ""}`
            : "your safety circle";
          const userSmsBody = `StillHere: We hear you. We are attempting to reach ${namesLine}.\n\nIf this is life-threatening, call ${emergency.number} now. StillHere is not an emergency response service.\n\nYou are not alone. Stay safe.`;
          sendSms(user.phone, userSmsBody, {
            purpose: "no_response",
            userId: user.id,
            dedupeKey: `wellness:${user.id}:user_sms`,
          }).catch((err: any) => {
            console.error(`[WELLNESS CALL] User SMS failed:`, err?.message || err);
          });
        }

        // 2. Push the user's own device with a "we're with you" card linking to
        //    the live SOS view (one-tap emergency, primary contact, location share).
        sendPushNotification(user.id, {
          title: "We're with you",
          body: `${notifiedIds.length} contact${notifiedIds.length === 1 ? "" : "s"} alerted. Tap for one-tap ${emergency.number}, contact call, and live location.`,
          tag: "sos-active",
          url: "/",
        }).catch((err: any) => {
          console.error(`[WELLNESS CALL] User push failed:`, err?.message || err);
        });

        // 3. Keep the call alive with a real menu + comfort loop instead of
        //    saying "stay on the line" then hanging up after 3 seconds.
        const primaryName = sortedSos[0]?.name || "your primary contact";
        const safePrimary = escapeXml(primaryName);
        const safeUserName = escapeXml(user.name);
        const safeEmergency = escapeXml(emergency.number);
        const supportIntro = notifiedIds.length > 0
          ? `We hear you, ${safeUserName}. You are not alone. We are reaching out to your safety circle right now.`
          : `We hear you, ${safeUserName}. You are not alone. We are starting your safety flow right now.`;
        const contactAttemptLine = notifiedIds.length > 0
          ? `We are attempting to reach ${notifiedIds.length} ${notifiedIds.length === 1 ? "person" : "people"}, including ${safePrimary}. We are also sending you a text message with their names.`
          : "We do not have a reachable Safety Circle contact on file yet. We are sending you a text message with next steps.";
        const connectPrompt = sortedSos[0]?.phone
          ? `To be connected directly to ${safePrimary} right now, press 1.`
          : "We do not have a contact phone number to connect you to right now.";
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${calm(supportIntro)}</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna-Neural">${calm(contactAttemptLine)}</Say>
  <Pause length="1"/>
  <Gather numDigits="1" action="/api/wellness-call/help-followup" method="POST" timeout="15" actionOnEmptyResult="true">
    <Say voice="Polly.Joanna-Neural">${calm(connectPrompt)}</Say>
    <Pause length="1"/>
    <Say voice="Polly.Joanna-Neural">${calm(`If this is life-threatening, please hang up and dial ${safeEmergency} now. Or, press 0 for guidance.`)}</Say>
    <Pause length="1"/>
    <Say voice="Polly.Joanna-Neural">${calm("Or simply stay on the line. We will stay with you for a few minutes while we keep trying your Safety Circle.")}</Say>
  </Gather>
  <Redirect method="POST">/api/wellness-call/comfort?cycle=1</Redirect>
</Response>`;
        return res.type("text/xml").send(twiml);
      }

      if (user) {
        // Caller didn't press 1 or 2. Record the no-response on the open real
        // incident so the watcher dashboard can show "called, no answer".
        // Never mutate drill incidents from the wellness flow.
        const noResponseIncident = await storage.getLatestRealOpenIncident(user.id);
        if (noResponseIncident && noResponseIncident.wellnessCallStatus !== "safe" && noResponseIncident.wellnessCallStatus !== "help") {
          await updateWellnessCallStatusForPhone(calledNumber, "no_response", "Wellness call ended without keypad response");
          try {
            const watcherContacts = await storage.getContactsLinkedToUser(user.id);
            for (const c of watcherContacts) {
              if (c.linkedUserId) {
                emitToUser(c.linkedUserId, "watched-users:invalidate", { userId: user.id });
              }
            }
          } catch {}
        }
      }
      if (!user && normalizedPhone) {
        console.error(`[WELLNESS CALL] No user found for phone ${normalizedPhone.slice(-4)}`);
      }

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Joanna-Neural">${calm("We didn't receive a response. We will attempt to reach your safety circle shortly. Take care.")}</Say><Hangup/></Response>`;
      res.type("text/xml").send(twiml);
    } catch (error) {
      console.error("Error in wellness call gather:", error);
      res.status(500).send("");
    }
  });

  // After the user pressed 2 ("I need help"), this handles the second-tier
  // menu so we never just leave them on a dead line.
  app.post("/api/wellness-call/help-followup", verifyTwilioSignature, async (req, res) => {
    try {
      const digits = req.body.Digits;
      const calledNumber = req.body.To;
      const normalizedPhone = calledNumber ? (calledNumber.startsWith("+") ? calledNumber : `+${calledNumber}`) : null;
      const user = normalizedPhone ? await storage.getUserByPhone(normalizedPhone) : null;

      // Press 1 -> patch them through to their primary contact via <Dial>
      // The Dial uses an `action` URL so Twilio posts back the real outcome
      // (DialCallStatus + DialCallDuration). Without the action attribute,
      // Twilio plays the next verb after the call regardless of whether the
      // contact answered, which caused us to incorrectly say
      // "we couldn't reach <name>" even after a successful conversation.
      if (digits === "1" && user) {
        const allContacts = await storage.getContacts(user.id);
        const sorted = [...allContacts].sort((a, b) => a.priority - b.priority);
        const primary = sorted[0];
        if (primary && primary.phone) {
          const safeName = escapeXml(primary.name);
          const safeContactId = escapeXml(primary.id);
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${calm(`Connecting you to ${safeName} now. Please hold.`)}</Say>
  <Dial timeout="25" callerId="${escapeXml(getTwilioVoiceFromNumber() || "")}" answerOnBridge="true" action="/api/wellness-call/dial-result?contactId=${safeContactId}" method="POST">
    <Number>${escapeXml(primary.phone)}</Number>
  </Dial>
</Response>`;
          return res.type("text/xml").send(twiml);
        }
        // No contact available -> fall through to comfort
        const emergencyNoContact = user ? await getEmergencyInfoForUser(user as any) : { number: "911" };
        const twimlNoContact = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${calm(`We don't have a contact phone number on file to connect you to. Please call ${emergencyNoContact.number} if this is life-threatening. We will stay with you.`)}</Say>
  <Redirect method="POST">/api/wellness-call/comfort?cycle=1</Redirect>
</Response>`;
        return res.type("text/xml").send(twimlNoContact);
      }

      // Press 0 -> emergency services guidance, with user's local number
      if (digits === "0") {
        const emergency = user ? await getEmergencyInfoForUser(user as any) : { number: "911" };
        const safeEmergency = escapeXml(emergency.number);
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${calm(`If this is a life-threatening emergency, please hang up now and dial ${safeEmergency}. Your safety circle has already been alerted, and we will keep them updated.`)}</Say>
  <Pause length="2"/>
  <Say voice="Polly.Joanna-Neural">${calm("If you cannot hang up, stay with us. We are right here with you.")}</Say>
  <Redirect method="POST">/api/wellness-call/comfort?cycle=1</Redirect>
</Response>`;
        return res.type("text/xml").send(twiml);
      }

      // Anything else (timeout, other digit) -> comfort loop
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Redirect method="POST">/api/wellness-call/comfort?cycle=1</Redirect></Response>`;
      res.type("text/xml").send(twiml);
    } catch (error) {
      console.error("Error in wellness call help-followup:", error);
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Redirect method="POST">/api/wellness-call/comfort?cycle=1</Redirect></Response>`);
    }
  });

  // Dial result: Twilio posts the real outcome of the watcher dial here
  // (DialCallStatus + DialCallDuration). This is the fix for the bug where we
  // told the user "we couldn't reach <name>" even after a successful call.
  //
  // - If the contact actually answered for at least ~15s (real conversation),
  //   we stamp the incident timeline as "contact_reached" and ask the user
  //   whether the situation is resolved (the post-contact follow-up).
  // - If the contact didn't answer (no-answer / busy / failed / canceled),
  //   we honestly tell the user we couldn't reach them and continue the
  //   comfort loop (escalation is already running in the background).
  app.post("/api/wellness-call/dial-result", verifyTwilioSignature, async (req, res) => {
    try {
      const dialStatus = String(req.body.DialCallStatus || "").toLowerCase();
      const dialDurationSec = parseInt(String(req.body.DialCallDuration || "0"), 10) || 0;
      const calledNumber = req.body.To;
      const normalizedPhone = calledNumber ? (calledNumber.startsWith("+") ? calledNumber : `+${calledNumber}`) : null;
      const user = normalizedPhone ? await storage.getUserByPhone(normalizedPhone) : null;
      const contactId = typeof req.query.contactId === "string" ? req.query.contactId : null;

      let contactName = "your contact";
      if (user && contactId) {
        const contact = (await storage.getContacts(user.id)).find(c => c.id === contactId);
        if (contact) contactName = contact.name;
      }
      const safeName = escapeXml(contactName);

      // "Real conversation" threshold: the contact answered AND stayed on
      // long enough that the user got to actually speak with them.
      const wasReached = dialStatus === "completed" && dialDurationSec >= 15;

      console.log(JSON.stringify({
        event: "WELLNESS_CALL_DIAL_RESULT",
        userId: user?.id || null,
        contactId,
        contactName,
        dialStatus,
        dialDurationSec,
        wasReached,
        timestamp: new Date().toISOString(),
      }));

      // Append to the incident escalation timeline so the watcher dashboard,
      // emergency page, and weekly report all show the truth.
      if (user) {
        const incident = await storage.getLatestRealOpenIncident(user.id);
        if (incident && !incident.isDrill) {
          let timeline: any[] = [];
          try { timeline = JSON.parse(incident.escalationTimeline || "[]"); } catch {}
          if (wasReached) {
            timeline.push({
              type: "contact_reached",
              time: new Date().toISOString(),
              detail: `User spoke with ${contactName} for ${Math.round(dialDurationSec / 60 * 10) / 10} min`,
            });
          } else {
            timeline.push({
              type: "call_failed",
              time: new Date().toISOString(),
              detail: `Could not reach ${contactName} (${dialStatus || "no response"})`,
            });
          }
          await storage.updateIncident(incident.id, {
            escalationTimeline: JSON.stringify(timeline),
          });
        }
      }

      if (wasReached) {
        // Ask the user whether the situation is resolved.
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${calm(`Welcome back. We're glad you got through to ${safeName}.`)}</Say>
  <Pause length="1"/>
  <Gather numDigits="1" action="/api/wellness-call/post-contact-followup" method="POST" timeout="15" actionOnEmptyResult="true">
    <Say voice="Polly.Joanna-Neural">${calm(`Is everything okay now? Press 1 if you're safe and the situation is resolved. Press 2 if you still need more help.`)}</Say>
    <Pause length="2"/>
    <Say voice="Polly.Joanna-Neural">${calm(`Take your time. Press 1 if you're safe. Press 2 if you still need help.`)}</Say>
  </Gather>
  <Say voice="Polly.Joanna-Neural">${calm("We didn't catch your response. We'll keep your safety circle on alert just in case.")}</Say>
  <Redirect method="POST">/api/wellness-call/comfort?cycle=1</Redirect>
</Response>`;
        return res.type("text/xml").send(twiml);
      }

      // Truly didn't reach them — be honest, continue the comfort loop.
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${calm(`We could not reach ${safeName} right now. We will keep trying your safety circle. Stay with us.`)}</Say>
  <Redirect method="POST">/api/wellness-call/comfort?cycle=1</Redirect>
</Response>`;
      res.type("text/xml").send(twiml);
    } catch (error) {
      console.error("Error in wellness call dial-result:", error);
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Redirect method="POST">/api/wellness-call/comfort?cycle=1</Redirect></Response>`);
    }
  });

  // Post-contact follow-up: after a confirmed conversation with a watcher,
  // we ask the user if the situation is resolved.
  // - Press 1 = resolved -> resolveCheckin (closes incident, sends all-clear
  //   SMS to the rest of the circle, stops further escalation, logs to the
  //   weekly safety report).
  // - Press 2 = still needs help -> log timeline entry and accelerate
  //   escalation by setting nextActionAt to now so the next cron tick
  //   immediately notifies the next contact in the chain.
  app.post("/api/wellness-call/post-contact-followup", verifyTwilioSignature, async (req, res) => {
    try {
      const digits = req.body.Digits;
      const calledNumber = req.body.To;
      const normalizedPhone = calledNumber ? (calledNumber.startsWith("+") ? calledNumber : `+${calledNumber}`) : null;
      const user = normalizedPhone ? await storage.getUserByPhone(normalizedPhone) : null;

      if (digits === "1" && user) {
        // Resolved! Mark the incident closed and check the user in.
        const incident = await storage.getLatestRealOpenIncident(user.id);
        if (incident && !incident.isDrill) {
          let timeline: any[] = [];
          try { timeline = JSON.parse(incident.escalationTimeline || "[]"); } catch {}
          timeline.push({
            type: "resolved",
            time: new Date().toISOString(),
            detail: "User confirmed safe by phone after speaking with their contact",
          });
          await storage.updateIncident(incident.id, {
            wellnessCallStatus: "safe",
            escalationTimeline: JSON.stringify(timeline),
          });
        }
        const result = await resolveCheckin(user.id, "call", { resolvedBy: "user" });
        console.log(`[WELLNESS CALL] Post-contact resolution: user=${user.id} confirmed safe (incidentResolved=${result.hadIncident})`);

        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${calm("Wonderful. We've checked you in and let your safety circle know you're safe.")}</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna-Neural">${calm("Take care, and have a lovely day.")}</Say>
  <Hangup/>
</Response>`;
        return res.type("text/xml").send(twiml);
      }

      if (digits === "2" && user) {
        // Still not resolved — log it and force the next escalation step soon.
        const incident = await storage.getLatestRealOpenIncident(user.id);
        if (incident && !incident.isDrill) {
          let timeline: any[] = [];
          try { timeline = JSON.parse(incident.escalationTimeline || "[]"); } catch {}
          timeline.push({
            type: "still_need_help",
            time: new Date().toISOString(),
            detail: "User confirmed they still need help after speaking with their contact",
          });
          // Set nextActionAt to now so the cron picks up this incident on its
          // next tick and notifies the next contact in the chain immediately.
          await storage.updateIncident(incident.id, {
            escalationTimeline: JSON.stringify(timeline),
            nextActionAt: new Date(),
          });
          console.log(`[WELLNESS CALL] User user=${user.id} still needs help — accelerating escalation to next contact`);
        }
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${calm("We hear you. We're alerting the next person in your safety circle right now. We are right here with you.")}</Say>
  <Redirect method="POST">/api/wellness-call/comfort?cycle=1</Redirect>
</Response>`;
        return res.type("text/xml").send(twiml);
      }

      // No clear response — stay with them, keep escalation going.
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${calm("We didn't catch that. We'll keep your safety circle on alert. We're right here with you.")}</Say>
  <Redirect method="POST">/api/wellness-call/comfort?cycle=1</Redirect>
</Response>`;
      res.type("text/xml").send(twiml);
    } catch (error) {
      console.error("Error in wellness call post-contact-followup:", error);
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Redirect method="POST">/api/wellness-call/comfort?cycle=1</Redirect></Response>`);
    }
  });

  // Comfort loop: stays on the call with the user, gently checking in, instead
  // of hanging up. Bounded to 3 cycles (~3 min) so the call eventually ends if
  // they truly cannot respond, but every cycle re-offers the "press 1 to be
  // connected" option.
  app.post("/api/wellness-call/comfort", verifyTwilioSignature, async (req, res) => {
    try {
      const cycle = Math.max(1, Math.min(parseInt(String(req.query.cycle || "1"), 10) || 1, 3));
      const calledNumber = req.body.To;
      const normalizedPhone = calledNumber ? (calledNumber.startsWith("+") ? calledNumber : `+${calledNumber}`) : null;
      const user = normalizedPhone ? await storage.getUserByPhone(normalizedPhone) : null;

      let primaryName = "your primary contact";
      let emergencyNumber = "911";
      if (user) {
        const allContacts = await storage.getContacts(user.id);
        const sorted = [...allContacts].sort((a, b) => a.priority - b.priority);
        if (sorted[0]) primaryName = sorted[0].name;
        const e = await getEmergencyInfoForUser(user as any);
        emergencyNumber = e.number;
      }
      const safePrimary = escapeXml(primaryName);
      const safeEmergency = escapeXml(emergencyNumber);

      // Final cycle -> warm sign-off (never just a dead "Goodbye")
      if (cycle >= 3) {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${calm(`We need to end this call now so the line stays open for ${safePrimary}, but the safety flow is still active. We have reached out to your safety circle, and you have a text message from us with next steps.`)}</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna-Neural">${calm(`If you are in danger right now, please call ${safeEmergency}. You are not alone. Take care.`)}</Say>
  <Hangup/>
</Response>`;
        return res.type("text/xml").send(twiml);
      }

      // Reassurance varies a little per cycle so it doesn't feel robotic
      const reassurance = cycle === 1
        ? `We are still right here with you. We are attempting to reach ${safePrimary} now.`
        : `Hang in there. We are still trying to reach your safety circle.`;

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${calm(reassurance)}</Say>
  <Pause length="2"/>
  <Say voice="Polly.Joanna-Neural">${calm("Let's take a slow breath together. Breathe in.")}</Say>
  <Pause length="2"/>
  <Say voice="Polly.Joanna-Neural">${calm("And gently breathe out. You are doing great.")}</Say>
  <Pause length="2"/>
  <Gather numDigits="1" action="/api/wellness-call/help-followup" method="POST" timeout="20" actionOnEmptyResult="true">
    <Say voice="Polly.Joanna-Neural">${calm(`Press 1 anytime to be connected directly to ${safePrimary}. Press 0 for emergency services guidance. Or just stay on the line with us.`)}</Say>
  </Gather>
  <Redirect method="POST">/api/wellness-call/comfort?cycle=${cycle + 1}</Redirect>
</Response>`;
      res.type("text/xml").send(twiml);
    } catch (error) {
      console.error("Error in wellness call comfort:", error);
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Joanna-Neural">${calm("You are not alone. We are reaching out to your safety circle. Take care.")}</Say><Hangup/></Response>`);
    }
  });

  const locationWakeThrottles = new Map<string, number>();
  let cronRunning = false;

  // Cron tick - check for due users (internal only)
  app.get("/api/cron/tick", async (req, res) => {
    try {
      const cronSecret = process.env.SESSION_SECRET;
      if (!cronSecret) {
        console.error("[CRON] SESSION_SECRET not configured, rejecting cron request");
        return res.status(500).json({ error: "Server misconfigured" });
      }
      const providedSecret = req.headers["x-cron-secret"];
      if (providedSecret !== cronSecret) {
        return res.status(403).json({ error: "Forbidden" });
      }

      if (cronRunning) {
        return res.json({ skipped: true, reason: "previous tick still running" });
      }
      cronRunning = true;

      let normalizedLegacyIntervals = 0;
      try {
        normalizedLegacyIntervals = await storage.normalizeLegacyCheckinIntervals();
        if (normalizedLegacyIntervals > 0) {
          console.log(`[CRON] Normalized ${normalizedLegacyIntervals} legacy check-in interval setting(s) to daily-or-longer`);
        }
      } catch (err: any) {
        console.error("[CRON] Legacy check-in interval cleanup failed:", err?.message || err);
      }

      try {
        await storage.backfillNextCheckinDueAt(500);
      } catch (err: any) {
        console.error("[CRON] next_checkin_due_at backfill failed:", err?.message || err);
      }

      const overdueUsers = await storage.getOverdueUsersWithSettings();
      const baseUrl = getBaseUrl();
      
      let remindersSent = 0;
      let alertsSent = 0;
      const now = new Date();
      
      for (const { user, settings, incident: claimedIncident, isDueForAlert, dueTime, dueOccurrenceKey, localDueLabel } of overdueUsers) {
        if (isDueForAlert) {
          const existingOpenIncident = await storage.getOpenIncident(user.id);
          if (existingOpenIncident) {
            console.log(`[ALERT] Skipping checkin alert for user=${user.id}  -  open incident already exists (${existingOpenIncident.reason})`);
            continue;
          }

          const reminderHistory = await storage.getReminderTimeline(user.id);
          const timeStr = now.toISOString();
          const graceMs = (settings.graceMinutes || 15) * 60 * 1000;

          let incident = claimedIncident || await storage.createIncident(user.id, "missed_checkin");
          await storage.updateSafetyState(user.id, "concern", "Missed check-in");
          emitTrackingPolicyChanged(user.id, "missed_checkin_open").catch(() => {});

          const timeline: any[] = [...reminderHistory];
          timeline.push({
            type: "push",
            time: timeStr,
            detail: "Push notification sent to user",
            dueOccurrenceKey,
            scheduledDueAt: dueTime.toISOString(),
            localDueTime: localDueLabel,
          });

          await sendReminderPush(user.id, user.name);
          await createProtectedUserSystemAlert(
            user,
            `You missed your scheduled check-in at ${localDueLabel}. StillHere is trying to reach you.`,
            {
              kind: "missed_checkin",
              incidentId: incident.id,
              dueOccurrenceKey,
              scheduledDueAt: dueTime.toISOString(),
              localDueTime: localDueLabel,
            },
          );
          console.log(`[ESCALATION] Step 1/3: Push sent to user=${user.id}`);

          if (settings.locationMode === "emergency_only" || settings.locationMode === "both") {
            await storage.createLocationSession(user.id, "emergency", incident.id);
          }

          // Phase 2: site #7a removed. The previous regenerateTokensForUser
          // call here only "warmed" tokens but built/sent no link (no link is
          // constructed in this block; this is the missed-checkin push step
          // that runs before any contact escalation). The escalation worker
          // below mints incident-scoped tokens itself when it actually sends.

          await storage.updateIncident(incident.id, {
            escalationLevel: 0,
            lastEscalationStep: "push",
            pushSentAt: now,
            nextActionAt: new Date(now.getTime() + graceMs),
            notifiedContactIds: "[]",
            escalationTimeline: JSON.stringify(timeline),
          });

          alertsSent++;
          await storage.resetReminderState(user.id);
          continue;
        }
      }
      
      let escalations = 0;
      const incidentsNeedingEscalation = await storage.getIncidentsNeedingEscalation();
      const MAX_SEQUENTIAL = 5;

      for (const incident of incidentsNeedingEscalation) {
        console.log(JSON.stringify({
          event: "INCIDENT_ESCALATION_PROCESS_START",
          workerId: (incident as any).processingLockId || null,
          incidentId: incident.id,
          userId: incident.userId,
          reason: incident.reason,
          step: incident.lastEscalationStep || "initial",
          nextActionAt: incident.nextActionAt?.toISOString?.() || null,
          latencyMs: incident.nextActionAt ? Math.max(0, now.getTime() - incident.nextActionAt.getTime()) : null,
        }));
        const user = await storage.getUser(incident.userId);
        if (!user) {
          await storage.updateIncident(incident.id, {
            nextActionAt: addMinutes(now, 30),
            escalationTimeline: JSON.stringify([
              ...parseEscalationTimeline(incident.escalationTimeline),
              { type: "system", time: now.toISOString(), detail: "Escalation delayed because the user record was unavailable." },
            ]),
          });
          console.warn(JSON.stringify({
            event: "INCIDENT_ESCALATION_SKIPPED",
            incidentId: incident.id,
            reason: "user_not_found",
            workerId: (incident as any).processingLockId || null,
          }));
          continue;
        }

        const userSettings = await storage.getSettings(incident.userId);
        const escalationMinutes = userSettings?.escalationMinutes || 20;
        const graceMs = (userSettings?.graceMinutes || 15) * 60 * 1000;

        const contacts = (await storage.getContacts(incident.userId)).filter(isContactActiveForAlerts);
        // Phase 2: incident-scoped tokens. Reused within this incident across
        // every escalation branch below (paused, sms_fallthrough, call_unanswered,
        // sequential, blast, legacy).
        const tokens = await storage.getOrMintIncidentTokensForUser(incident.userId, incident.startedAt);
        const sortedContacts = [...contacts].sort((a, b) => a.priority - b.priority);

        let notifiedIds: string[] = [];
        try { notifiedIds = JSON.parse(incident.notifiedContactIds || "[]"); } catch { notifiedIds = []; }

        const step = incident.lastEscalationStep || null;
        const existingTimeline: any[] = JSON.parse(incident.escalationTimeline || "[]");
        const timeStr = now.toISOString();

        if (incident.status === "paused") {
          console.log(`[ESCALATION] Handling timeout, re-notifying all contacts`);
          for (const contact of contacts) {
            const token = tokens.find(t => t.contact.id === contact.id);
            if (token) {
              const link = `${baseUrl}/emergency/${token.token}`;
              const normalizedPhone = normalizePhone(contact.phone);
              await sendHandlingTimeoutAlert(normalizedPhone, user.name, link);
            }
          }
          const firstContact = sortedContacts[0];
          await storage.updateIncident(incident.id, {
            status: "open",
            handledByContactId: null,
            escalationLevel: 1,
            lastEscalationStep: "contact_1",
            notifiedContactIds: JSON.stringify(firstContact ? [firstContact.id] : []),
            lastContactNotifiedAt: now,
            allContactsNotifiedAt: null,
            userNotifiedNoResponseAt: null,
            contact1NotifiedAt: now,
            contact2NotifiedAt: null,
            nextActionAt: addMinutes(now, escalationMinutes),
          });
          console.log("[ESCALATION] Handling timeout alerts sent, escalation reset");
          escalations++;
          continue;
        }

        if (incident.status !== "open") {
          await storage.updateIncident(incident.id, { nextActionAt: addMinutes(now, 30) });
          console.log(JSON.stringify({
            event: "INCIDENT_ESCALATION_SKIPPED",
            incidentId: incident.id,
            reason: `status:${incident.status}`,
            workerId: (incident as any).processingLockId || null,
          }));
          continue;
        }

        if (step === "push") {
          console.log(JSON.stringify({ event: "CONTACT_BLOCKED", reason: "escalation in progress  -  step: push→sms", userId: user.id, incidentId: incident.id, timestamp: timeStr }));
          const checkInLink = `${baseUrl}/`;
          const dueOccurrenceKey = existingTimeline.find((entry) => entry?.dueOccurrenceKey)?.dueOccurrenceKey
            || incident.startedAt.toISOString();
          if (user.phone) {
            await sendReminderSms(user.phone, checkInLink, !!userSettings?.smsCheckinEnabled, {
              userId: user.id,
              incidentId: incident.id,
              dedupeKey: `checkin_reminder_sms:${user.id}:${dueOccurrenceKey}`,
            });
            existingTimeline.push({ type: "sms", time: timeStr, detail: "SMS reminder sent to user. Still trying to reach them" });
            console.log(`[ESCALATION] Step 2/3: SMS sent to user=${user.id} (phone ***${user.phone.slice(-4)})`);
          } else {
            await sendReminderPush(user.id, user.name);
            await createProtectedUserSystemAlert(
              user,
              "StillHere sent another missed check-in reminder because no phone number is available for SMS.",
              {
                kind: "missed_checkin",
                incidentId: incident.id,
                dueOccurrenceKey,
                stage: "push_no_phone",
              },
            );
            existingTimeline.push({ type: "push", time: timeStr, detail: "Push reminder sent because no phone is available. Still trying to reach them" });
            console.log(`[ESCALATION] Step 2/3: Push sent to user=${user.id} (no phone for SMS)`);
          }
          await storage.updateIncident(incident.id, {
            lastEscalationStep: "sms",
            smsSentAt: now,
            nextActionAt: new Date(now.getTime() + graceMs),
            escalationTimeline: JSON.stringify(existingTimeline),
          });
          escalations++;
          continue;
        }

        if (step === "sms") {
          console.log(JSON.stringify({ event: "CONTACT_BLOCKED", reason: "escalation in progress  -  step: sms→call", userId: user.id, incidentId: incident.id, timestamp: timeStr }));
          const autoWellnessCallFlag = !!(userSettings as any)?.autoWellnessCall;
          const twilioReady = isTwilioConfigured();
          const hasPhone = !!user.phone;
          const wellnessCallEnabled = autoWellnessCallFlag && twilioReady && hasPhone;

          console.log(JSON.stringify({
            event: "CALL_FLOW_DIAGNOSTIC",
            userId: user.id,
            autoWellnessCallEnabled: autoWellnessCallFlag,
            twilioConfigured: twilioReady,
            hasPhone,
            phoneLast4: hasPhone && user.phone ? `***${user.phone.slice(-4)}` : null,
            willAttemptCall: wellnessCallEnabled,
            incidentId: incident.id,
            timestamp: timeStr,
          }));

          if (wellnessCallEnabled && user.phone) {
            const voicePolicy = await import("./outbound-policy");
            let voiceAttemptId: string | undefined;
            try {
              console.log(`[ESCALATION] Step 3/3: Calling user=${user.id} (phone ***${user.phone.slice(-4)})`);
              // Voice is the most expensive channel — gate it through the
              // outbound policy with a per-incident dedupe key so a stuck
              // escalation worker can't dial the same person twice. Note:
              // wellness_call is safety-critical, so the policy will allow
              // the send even when the channel ceiling is breached but
              // returns degraded:true so we can flip degradedDelivery.
              const voiceDecision = await voicePolicy.enforceSendPolicy({
                channel: "voice",
                purpose: "wellness_call",
                destination: user.phone,
                userId: user.id,
                incidentId: incident.id,
                dedupeKey: `wellness_call:${incident.id}`,
              });
              voiceAttemptId = voiceDecision.attemptId;
              if (voiceDecision.degraded) {
                await storage.updateIncident(incident.id, { degradedDelivery: true });
              }
              if (!voiceDecision.allowed) {
                console.warn(`[ESCALATION] Wellness call blocked by policy (${voiceDecision.reason}) for user=${user.id}`);
                existingTimeline.push({ type: "call_failed", time: timeStr, detail: `Wellness call blocked by policy: ${voiceDecision.reason}` });
              } else {
              const twilio = (await import("twilio")).default;
              const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
              const voiceFromNumber = getTwilioVoiceFromNumber();
              if (!voiceFromNumber) {
                throw new Error("Twilio voice caller number is not configured. Set TWILIO_VOICE_PHONE_NUMBER to a verified or purchased Twilio voice number.");
              }
              const callParams: any = {
                to: user.phone,
                from: voiceFromNumber,
                url: `${baseUrl}/api/wellness-call/respond`,
                method: "POST",
                machineDetection: "DetectMessageEnd",
                asyncAmd: true,
                asyncAmdStatusCallback: `${baseUrl}/api/wellness-call/status`,
                asyncAmdStatusCallbackMethod: "POST",
                statusCallback: `${baseUrl}/api/wellness-call/status`,
                statusCallbackMethod: "POST",
                statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
              };
              const callResult = await twilioVoiceLimiter.run(() => client.calls.create(callParams));
              await voicePolicy.markSendProviderResult(voiceAttemptId, "sent", { providerId: callResult.sid });
              existingTimeline.push({ type: "call", time: timeStr, detail: "Wellness call placed" });
              console.log(`[ESCALATION] Call placed (SID: ${callResult.sid})`);

              console.log(JSON.stringify({
                event: "CALL_FLOW_RESULT",
                userId: user.id,
                callPlaced: true,
                callSid: callResult.sid,
                timestamp: timeStr,
              }));

              await storage.updateIncident(incident.id, {
                lastEscalationStep: "call",
                callSentAt: now,
                wellnessCallStatus: "placed",
                nextActionAt: addMinutes(now, 2),
                escalationTimeline: JSON.stringify(existingTimeline),
              });
              escalations++;
              continue;
              }
            } catch (err: any) {
              const callError = err?.message || "unknown error";
              existingTimeline.push({ type: "call_failed", time: timeStr, detail: `Wellness call failed: ${callError}` });
              console.error(`[ESCALATION] Wellness call FAILED for user=${user.id}: ${callError}  -  falling through to contacts`);
              try {
                await voicePolicy.markSendProviderResult(voiceAttemptId, "failed", { errorMessage: callError });
                await storage.updateIncident(incident.id, { degradedDelivery: true });
              } catch {}
            }
          } else {
            const reasons = [];
            if (!autoWellnessCallFlag) reasons.push("autoWellnessCall disabled");
            if (!twilioReady) reasons.push("Twilio not configured");
            if (!hasPhone) reasons.push("no phone number");
            console.log(`[ESCALATION] Skipping call for user=${user.id}: ${reasons.join(", ")}  -  advancing to contacts`);
          }

          const firstContact = sortedContacts[0];
          if (firstContact) {
            const token = tokens.find(t => t.contact.id === firstContact.id);
            if (token) {
              const link = `${baseUrl}/emergency/${token.token}`;
              console.log(JSON.stringify({ event: "CONTACT_SENT", type: "alert", contactId: firstContact.id, reason: incident.reason, userId: user.id, step: "sms_fallthrough", timestamp: timeStr }));
              const smsFn = incident.reason === "sos" ? sendSosAlert : sendMissedCheckinAlert;
              await notifyContact(firstContact, user.name, link, incident.reason as "sos" | "missed_checkin", smsFn, { incidentId: incident.id });
              existingTimeline.push({ type: "contact_alert", time: timeStr, detail: `Emergency contacts alerted after no response. First contact notified: ${firstContact.name}` });
            }
          }
          notifyConcern(user.id, user.name, incident.reason as any).catch((err) => {
            console.error(`[ESCALATION] notifyConcern failed:`, err?.message || err);
          });
          await storage.updateIncident(incident.id, {
            escalationLevel: 1,
            lastEscalationStep: "contact_1",
            notifiedContactIds: JSON.stringify(firstContact ? [firstContact.id] : []),
            lastContactNotifiedAt: now,
            contact1NotifiedAt: now,
            nextActionAt: addMinutes(now, escalationMinutes),
            escalationTimeline: JSON.stringify(existingTimeline),
          });
          escalations++;
          continue;
        }

        if (step === "call") {
          const firstContact = sortedContacts[0];
          if (firstContact) {
            const token = tokens.find(t => t.contact.id === firstContact.id);
            if (token) {
              const link = `${baseUrl}/emergency/${token.token}`;
              console.log(JSON.stringify({ event: "CONTACT_SENT", type: "alert", contactId: firstContact.id, reason: incident.reason, userId: user.id, step: "call_unanswered", timestamp: timeStr }));
              const smsFn = incident.reason === "sos" ? sendSosAlert : sendMissedCheckinAlert;
              await notifyContact(firstContact, user.name, link, incident.reason as "sos" | "missed_checkin", smsFn, { incidentId: incident.id });
              existingTimeline.push({ type: "contact_alert", time: timeStr, detail: `Emergency contacts alerted after no response to the wellness call. First contact notified: ${firstContact.name}` });
            }
          }
          notifyConcern(user.id, user.name, incident.reason as any).catch((err) => {
            console.error(`[ESCALATION] notifyConcern failed:`, err?.message || err);
          });
          await storage.updateIncident(incident.id, {
            escalationLevel: 1,
            lastEscalationStep: "contact_1",
            notifiedContactIds: JSON.stringify(firstContact ? [firstContact.id] : []),
            lastContactNotifiedAt: now,
            contact1NotifiedAt: now,
            nextActionAt: addMinutes(now, escalationMinutes),
            escalationTimeline: JSON.stringify(existingTimeline),
          });
          escalations++;
          continue;
        }

        if (step === "wellness_call_help") {
          const notifiedCount = notifiedIds.length;
          const allKnownNotified = sortedContacts.length > 0 && notifiedCount >= sortedContacts.length;
          await storage.updateIncident(incident.id, {
            escalationLevel: notifiedCount || incident.escalationLevel || 1,
            lastEscalationStep: `contact_${Math.max(1, notifiedCount || incident.escalationLevel || 1)}`,
            allContactsNotifiedAt: allKnownNotified ? (incident.allContactsNotifiedAt || incident.lastContactNotifiedAt || now) : incident.allContactsNotifiedAt,
            nextActionAt: allKnownNotified ? addMinutes(now, 30) : now,
          });
          escalations++;
          continue;
        }

        if (step && step.startsWith("contact_")) {
          const lastNotifiedAt = incident.lastContactNotifiedAt || incident.contact1NotifiedAt;
          if (!lastNotifiedAt) {
            await storage.updateIncident(incident.id, {
              lastContactNotifiedAt: now,
              nextActionAt: addMinutes(now, escalationMinutes),
            });
            continue;
          }

          const ESCALATION_WINDOW_MS = escalationMinutes * 60 * 1000;
          const elapsedMs = now.getTime() - lastNotifiedAt.getTime();
          if (elapsedMs < ESCALATION_WINDOW_MS) {
            const remainingMs = ESCALATION_WINDOW_MS - elapsedMs;
            await storage.updateIncident(incident.id, {
              nextActionAt: new Date(now.getTime() + remainingMs + 60000),
            });
            continue;
          }

          const sequentialContacts = sortedContacts.slice(0, MAX_SEQUENTIAL);
          const nextSequential = sequentialContacts.find(c => !notifiedIds.includes(c.id));

          if (nextSequential) {
            const token = tokens.find(t => t.contact.id === nextSequential.id);
            if (token) {
              const link = `${baseUrl}/emergency/${token.token}`;
              console.log(JSON.stringify({ event: "CONTACT_SENT", type: "alert", contactId: nextSequential.id, reason: incident.reason, userId: user.id, step: `escalation_contact_${notifiedIds.length + 1}`, timestamp: timeStr }));
              const reason = incident.reason as "sos" | "missed_checkin";
              await notifyContact(nextSequential, user.name, link, reason, (p, n, l, opts) => sendEscalationAlert(p, n, l, reason, opts), { incidentId: incident.id });
            }
            existingTimeline.push({ type: "contact_escalation", time: timeStr, detail: `Escalated to: ${nextSequential.name}` });
            notifiedIds.push(nextSequential.id);
            const newLevel = notifiedIds.length;
            const updateData: any = {
              escalationLevel: newLevel,
              lastEscalationStep: `contact_${newLevel}`,
              notifiedContactIds: JSON.stringify(notifiedIds),
              lastContactNotifiedAt: now,
              nextActionAt: addMinutes(now, escalationMinutes),
              escalationTimeline: JSON.stringify(existingTimeline),
            };
            if (newLevel === 2) updateData.contact2NotifiedAt = now;
            await storage.updateIncident(incident.id, updateData);
            escalations++;
            continue;
          }

          const remainingContacts = sortedContacts.filter(c => !notifiedIds.includes(c.id));
          if (remainingContacts.length > 0 && !incident.allContactsNotifiedAt) {
            console.log(`[ESCALATION] Top ${MAX_SEQUENTIAL} exhausted, blasting ${remainingContacts.length} remaining`);
            for (const contact of remainingContacts) {
              const token = tokens.find(t => t.contact.id === contact.id);
              if (token) {
                const link = `${baseUrl}/emergency/${token.token}`;
                const reason = incident.reason as "sos" | "missed_checkin";
                await notifyContact(contact, user.name, link, reason, (p, n, l, opts) => sendEscalationAlert(p, n, l, reason, opts), { incidentId: incident.id });
              }
              notifiedIds.push(contact.id);
            }
            await storage.updateIncident(incident.id, {
              escalationLevel: notifiedIds.length,
              lastEscalationStep: `contact_${notifiedIds.length}`,
              notifiedContactIds: JSON.stringify(notifiedIds),
              allContactsNotifiedAt: now,
              lastContactNotifiedAt: now,
              nextActionAt: addMinutes(now, escalationMinutes),
              escalationTimeline: JSON.stringify(existingTimeline),
            });
            escalations++;
            continue;
          }

          if (!incident.userNotifiedNoResponseAt) {
            console.log(`[ESCALATION] No contacts responded, updating in-app status`);
            await storage.updateIncident(incident.id, {
              userNotifiedNoResponseAt: now,
              nextActionAt: addMinutes(now, 30),
            });
            escalations++;
            continue;
          }

          await storage.updateIncident(incident.id, {
            nextActionAt: addMinutes(now, 30),
          });
        }

        if (!step) {
          if (incident.reason === "missed_checkin") {
            existingTimeline.push({ type: "push", time: timeStr, detail: "Push notification sent (legacy recovery)" });
            await sendReminderPush(user.id, user.name);
            await createProtectedUserSystemAlert(
              user,
              "StillHere restarted your missed check-in reminder flow for an open incident.",
              {
                kind: "missed_checkin",
                incidentId: incident.id,
                stage: "legacy_recovery",
              },
            );
            await storage.updateIncident(incident.id, {
              lastEscalationStep: "push",
              pushSentAt: now,
              nextActionAt: new Date(now.getTime() + graceMs),
              escalationTimeline: JSON.stringify(existingTimeline),
            });
          } else {
            const firstContact = sortedContacts[0];
            if (firstContact) {
              const token = tokens.find(t => t.contact.id === firstContact.id);
              if (token) {
                const link = `${baseUrl}/emergency/${token.token}`;
                const smsFn = incident.reason === "sos" ? sendSosAlert : sendMissedCheckinAlert;
                await notifyContact(firstContact, user.name, link, incident.reason as "sos" | "missed_checkin", smsFn, { incidentId: incident.id });
                existingTimeline.push({ type: "contact_alert", time: timeStr, detail: `Emergency contact notified: ${firstContact.name} (legacy recovery)` });
              }
            }
            notifyConcern(user.id, user.name, incident.reason as any).catch(() => {});
            await storage.updateIncident(incident.id, {
              escalationLevel: 1,
              lastEscalationStep: "contact_1",
              notifiedContactIds: JSON.stringify(firstContact ? [firstContact.id] : []),
              lastContactNotifiedAt: now,
              contact1NotifiedAt: now,
              nextActionAt: addMinutes(now, escalationMinutes),
              escalationTimeline: JSON.stringify(existingTimeline),
            });
          }
          escalations++;
          continue;
        }
      }
      
      let reportsSent = 0;
      try {
        const dueReports = await storage.getDueReports();
        for (const pref of dueReports) {
          try {
            const watchedUser = await storage.getUser(pref.watchedUserId);
            const watcherUser = await storage.getUser(pref.watcherId);
            if (!watchedUser || !watcherUser) continue;

            const watchedSettings = await storage.getSettings(pref.watchedUserId);
            if (watchedSettings && !watchedSettings.allowReports) continue;

            const periodDays = pref.frequency === "daily" ? 1 : pref.frequency === "weekly" ? 7 : pref.frequency === "fortnightly" ? 14 : 30;
            const from = new Date(Date.now() - periodDays * 86400000);
            const now = new Date();
            const checkinList = await storage.getCheckinHistory(pref.watchedUserId, from, now);
            const incidentList = await storage.getIncidentHistory(pref.watchedUserId, from, now);

            const recipientEmail = pref.email || null;
            if (recipientEmail) {
              const { sendEmail } = await import("./email");
              const { format: fmtDate } = await import("date-fns");

              const escHtml = (s: string | null | undefined) =>
                String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
              const safeWatchedName = escHtml(watchedUser.name);

              const checkinRows = checkinList.map(c =>
                `<tr><td>${fmtDate(c.createdAt, "MMM d, yyyy")}</td><td>${fmtDate(c.createdAt, "h:mm a")}</td><td>${escHtml(c.method)}</td></tr>`
              ).join("");
              const incidentRows = incidentList.map(i => {
                const timeline = parseEscalationTimeline(i.escalationTimeline);
                const activity = timeline.length > 0
                  ? `<ul style="margin:0;padding-left:18px;">${timeline.map(entry => `<li>${fmtDate(new Date(entry.time), "h:mm a")}: ${escHtml(entry.detail)}</li>`).join("")}</ul>`
                  : "No escalation steps recorded";
                return `<tr><td>${fmtDate(i.startedAt, "MMM d, yyyy")}</td><td>${i.reason === "sos" ? "SOS Alert" : "Missed Checkin"}</td><td>${i.status === "resolved" ? "Resolved" : "Open"}</td><td>${activity}</td></tr>`;
              }).join("");

              const complianceRate = Math.min(100, Math.round((checkinList.length / Math.max(1, periodDays)) * 100));

              const html = `
                <h2>StillHere Safety Report for ${safeWatchedName}</h2>
                <p>Report period: ${fmtDate(from, "MMM d, yyyy")} to ${fmtDate(now, "MMM d, yyyy")}</p>
                <h3>Summary</h3>
                <ul>
                  <li>Total checkins: ${checkinList.length}</li>
                  <li>Compliance rate: ${complianceRate}%</li>
                  <li>Incidents: ${incidentList.length}</li>
                </ul>
                ${checkinList.length > 0 ? `<h3>Checkin History</h3><table border="1" cellpadding="6"><tr><th>Date</th><th>Time</th><th>Method</th></tr>${checkinRows}</table>` : ""}
                ${incidentList.length > 0 ? `<h3>Incidents</h3><table border="1" cellpadding="6"><tr><th>Date</th><th>Type</th><th>Status</th><th>Safety flow</th></tr>${incidentRows}</table>` : ""}
                <p style="color:#888;font-size:12px;margin-top:20px;">This report was generated automatically by StillHere. ${safeWatchedName} has consented to share this information.</p>
              `;

              const subject = `StillHere Report: ${watchedUser.name} (${pref.frequency})`.replace(/[\r\n\t\0]+/g, " ").slice(0, 200);
              await sendEmail(recipientEmail, subject, html);
              reportsSent++;
            }

            await storage.updateReportLastSent(pref.id);
          } catch (err) {
            console.error(`[CRON] Report send failed for pref ${pref.id}:`, err);
          }
        }
      } catch (err) {
        console.error("[CRON] Report processing failed:", err);
      }

      let locationWakeups = 0;
      try {
        const allShares = await storage.getAllActiveLiveShares();
        for (const share of allShares) {
          if (share.expiresAt && new Date() > share.expiresAt) {
            await storage.stopLiveLocationShare(share.userId);
            continue;
          }
          const lastUpdate = share.lastUpdatedAt ? new Date(share.lastUpdatedAt).getTime() : 0;
          const staleMs = Date.now() - lastUpdate;
          const lastWake = locationWakeThrottles.get(share.userId) || 0;
          const sinceLastWake = Date.now() - lastWake;
          if (staleMs > 2 * 60 * 1000 && staleMs < 30 * 60 * 1000 && sinceLastWake > 5 * 60 * 1000) {
            try {
              const result = await sendPushNotification(share.userId, {
                title: "Location sharing active",
                body: "Tap to keep your location updating for your contacts.",
                tag: "location-wake",
                url: "/live-location",
              });
              locationWakeThrottles.set(share.userId, Date.now());
              if (result.sent > 0) {
                locationWakeups++;
              }
            } catch (err: any) {
              console.error(`[CRON] Location wake-up push failed for ${share.userId}:`, err?.message || err);
            }
          }
        }
        if (locationWakeups > 0) {
          console.log(`[CRON] Sent ${locationWakeups} location wake-up push(es)`);
        }
      } catch (err) {
        console.error("[CRON] Location heartbeat failed:", err);
      }

      let softDeletesCleaned = 0;
      try {
        softDeletesCleaned = await storage.cleanupExpiredSoftDeletes();
        if (softDeletesCleaned > 0) {
          console.log(`[CRON] Cleaned up ${softDeletesCleaned} expired soft-deleted contacts`);
        }
      } catch (err) {
        console.error("[CRON] Soft-delete cleanup failed:", err);
      }

      // Privacy: delete historical location data older than each user's
      // retention window. Throttled to once per 24h via a server-side flag
      // so it doesn't run on every 2-min cron tick. No PII is logged.
      try {
        const lastRunMs = (global as any).__lastLocationCleanupAt || 0;
        const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
        if (Date.now() - lastRunMs >= TWENTY_FOUR_HOURS_MS) {
          (global as any).__lastLocationCleanupAt = Date.now();
          const result = await storage.cleanupExpiredLocationData();
          console.log(`[CRON][retention] location cleanup: users=${result.usersProcessed} points=${result.pointsDeleted} shares=${result.sharesDeleted} breadcrumbs=${result.breadcrumbsDeleted} tripPoints=${result.tripPointsDeleted} contextEvents=${result.contextEventsDeleted} speedAlerts=${result.speedAlertsDeleted} checkinCoordsNulled=${result.checkinCoordsNulled} driveCoordsNulled=${result.driveSessionCoordsNulled} timerCoordsNulled=${result.safetyTimerCoordsNulled} walkCoordsNulled=${result.safeWalkCoordsNulled}`);
        }
      } catch (err: any) {
        console.error("[CRON][retention] location cleanup failed:", err?.message || err);
      }

      // Safety Timer escalation
      let timerEscalations = 0;
      try {
        const expiredTimers = await storage.getExpiredSafetyTimers();
        for (const timer of expiredTimers) {
          try {
            await storage.updateSafetyTimer(timer.id, { status: "escalated", resolvedAt: new Date() });
            const user = await storage.getUser(timer.userId);
            if (!user) continue;

            // Incident reason intentionally remains "sos": the current DB
            // enum only supports missed_checkin/sos/test, and an expired
            // Safety Timer is treated as an urgent emergency escalation. The
            // timeline marks the exact source so reports can distinguish it.
            const incident = await storage.createIncident(timer.userId, "sos");
            await storage.updateSafetyState(timer.userId, "concern", "Safety timer expired");
            emitTrackingPolicyChanged(timer.userId, "safety_timer_escalated").catch(() => {});
            await createProtectedUserSystemAlert(
              user,
              "Your Safety Timer expired. Emergency contacts have been alerted.",
              {
                kind: "safety_timer_expired",
                incidentId: incident.id,
                timerId: timer.id,
                expiresAt: timer.expiresAt.toISOString(),
              },
            );
            notifyConcern(timer.userId, user.name, "sos").catch((err) => {
              console.error(`[TIMER] notifyConcern failed for user=${timer.userId}:`, err?.message || err);
            });
            // Phase 2: incident-scoped tokens for the safety-timer incident.
            const tokens = await storage.getOrMintIncidentTokensForUser(timer.userId, incident.startedAt);
            const allContactIds: string[] = [];

            for (const { contact, token } of tokens) {
              const link = `${baseUrl}/emergency/${token}`;
              let locationInfo = "";
              if (timer.lastLat && timer.lastLng) {
                locationInfo = `\nLast known location: https://www.google.com/maps?q=${timer.lastLat},${timer.lastLng}`;
                if (timer.lastActivity) locationInfo += `\nActivity: ${timer.lastActivity}`;
              }
              const noteInfo = timer.note ? `\nNote: ${timer.note}` : "";

              if (contact.phone) {
                try {
                  await sendSms(contact.phone,
                    `StillHere ALERT: ${user.name}'s safety timer has expired and they have not responded.${noteInfo}${locationInfo}\n\nCheck their status: ${link}\n\nLink expires in 24 hours.`,
                    { purpose: "sos_alert", userId: user.id, dedupeKey: `safety_timer:${timer.id}:${contact.id}` }
                  );
                } catch (err: any) {
                  console.error(`[TIMER] SMS to contact=${contact.id} (phone ***${contact.phone.slice(-4)}) failed:`, err?.message || err);
                }
              } else {
                console.log(`[TIMER] Skipping SMS for contact=${contact.id}: no phone number`);
              }
              if (isValidEmail(contact.email)) {
                try {
                  const { sendEmail } = await import("./email");
                  await sendEmail(contact.email!.trim(),
                    `StillHere Alert: ${user.name}'s Safety Timer Expired`,
                    `${user.name}'s safety timer has expired and they have not responded.${noteInfo}${locationInfo}\n\nCheck their status: ${link}\n\nThis link expires in 24 hours for your safety and privacy.`
                  );
                } catch (err: any) {
                  console.error(`[TIMER] Email to contact=${contact.id} failed:`, err?.message || err);
                }
              }
              allContactIds.push(contact.id);
            }

            await storage.updateIncident(incident.id, {
              escalationLevel: allContactIds.length,
              lastEscalationStep: `contact_${allContactIds.length}`,
              notifiedContactIds: JSON.stringify(allContactIds),
              lastContactNotifiedAt: now,
              contact1NotifiedAt: now,
              contact2NotifiedAt: allContactIds.length > 1 ? now : undefined,
              allContactsNotifiedAt: now,
              nextActionAt: addMinutes(now, 30),
              escalationTimeline: JSON.stringify([
                {
                  type: "safety_timer_expired",
                  time: now.toISOString(),
                  detail: "Safety Timer expired. Emergency contacts were notified immediately.",
                },
              ]),
            });

            timerEscalations++;
            console.log(`[CRON] Safety timer escalated for user=${user.id}`);
          } catch (err) {
            console.error("[CRON] Safety timer escalation failed:", err);
          }
        }
      } catch (err) {
        console.error("[CRON] Safety timer check failed:", err);
      }

      // Safe Walk: mark newly overdue walks and notify user
      try {
        const nowDate = new Date();
        const newlyOverdue = await db.select().from(safeWalks)
          .where(and(eq(safeWalks.status, "active"), lt(safeWalks.expectedArrivalAt, nowDate)));
        for (const w of newlyOverdue) {
          await storage.updateSafeWalk(w.id, { status: "overdue" });
          const u = await storage.getUser(w.userId);
          if (!u) continue;
          console.log(`[CRON] Safe Walk now overdue for user=${u.id}  -  10 min grace period started`);

          const destInfo = w.destinationName ? ` to ${w.destinationName}` : "";

          try {
            // Route through sendPushNotification so the policy + audit log
            // captures every safe-walk overdue push (purpose=missed_checkin_alert).
            await sendPushNotification(w.userId, {
              title: "Are you OK?",
              body: `You haven't arrived${destInfo} yet. Tap "I've Arrived" or extend your time.`,
              tag: "safe-walk-overdue",
              url: "/safe-walk",
            }, { purpose: "missed_checkin_alert", incidentId: null, dedupeKey: `safe_walk_overdue:${w.id}` });
            console.log(`[CRON] Sent push notification to user=${u.id}  -  safe walk overdue`);
          } catch (err: any) {
            console.error(`[SAFE-WALK] Push notification batch failed for user=${u.id}:`, err?.message || err);
          }

          if (u.phone && isTwilioConfigured()) {
            try {
              await sendSms(u.phone,
                `StillHere: You haven't arrived${destInfo} yet. Are you OK? Open the app to confirm you're safe, or reply YES to this message.`,
                { purpose: "reminder", userId: u.id, dedupeKey: `safe_walk:${w.id}:user_check` }
              );
              console.log(`[CRON] Sent SMS to user=${u.id}  -  safe walk overdue`);
            } catch (err: any) {
              console.error(`[SAFE-WALK] Overdue SMS to user=${u.id} failed:`, err?.message || err);
            }
          }
        }
      } catch (err) {
        console.error("[CRON] Safe Walk overdue marking failed:", err);
      }

      // Safe Walk escalation (10 min grace period passed)
      let walkEscalations = 0;
      try {
        const overdueWalks = await storage.getOverdueSafeWalks();
        for (const walk of overdueWalks) {
          try {
            await storage.updateSafeWalk(walk.id, { status: "escalated", resolvedAt: new Date() });
            const user = await storage.getUser(walk.userId);
            if (!user) continue;

            const incident = await storage.createIncident(walk.userId, "sos");
            await storage.updateSafetyState(walk.userId, "concern", "Safe walk overdue. Not responding");
            emitTrackingPolicyChanged(walk.userId, "safe_walk_escalated").catch(() => {});
            const destInfo = walk.destinationName ? ` to ${walk.destinationName}` : "";
            await createProtectedUserSystemAlert(
              user,
              `Your Safe Walk${destInfo} escalated because you had not arrived or responded. Emergency contacts have been alerted.`,
              {
                kind: "safe_walk_escalated",
                incidentId: incident.id,
                safeWalkId: walk.id,
                destinationName: walk.destinationName,
                expectedArrivalAt: walk.expectedArrivalAt.toISOString(),
              },
            );
            notifyConcern(walk.userId, user.name, "sos").catch((err) => {
              console.error(`[SAFE-WALK] notifyConcern failed for user=${walk.userId}:`, err?.message || err);
            });
            const escalationTimeline = [
              {
                type: "safe_walk_escalated",
                time: now.toISOString(),
                detail: `Safe Walk${destInfo} escalated because the user did not arrive or respond.`,
              },
            ];
            await placeWellnessCallForIncident(
              user,
              incident,
              escalationTimeline,
              now,
              "Wellness call attempted for Safe Walk escalation",
            );
            // Phase 2: incident-scoped tokens for the safe-walk incident.
            const tokens = await storage.getOrMintIncidentTokensForUser(walk.userId, incident.startedAt);
            const contacts = (await storage.getContacts(walk.userId)).filter(isContactActiveForAlerts);
            const sortedContacts = [...contacts].sort((a, b) => a.priority - b.priority);
            const noteInfo = walk.note ? `\nNote: ${walk.note}` : "";
            const allContactIds: string[] = [];

            for (const { contact, token } of tokens) {
              const link = `${baseUrl}/emergency/${token}`;
              let locationInfo = "";
              if (walk.lastLat && walk.lastLng) {
                locationInfo = `\nLast known location: https://www.google.com/maps?q=${walk.lastLat},${walk.lastLng}`;
                if (walk.lastLocationAt) locationInfo += `\nLast updated: ${formatOwnerLocalAlertTime(walk.lastLocationAt, user.timezone)}`;
                if (walk.lastActivity) locationInfo += `\nActivity: ${walk.lastActivity}`;
              }

              if (contact.phone) {
                try {
                  await sendSms(contact.phone,
                    `StillHere ALERT: ${user.name} has not arrived${destInfo} and is not responding.${noteInfo}${locationInfo}\n\nCheck their status: ${link}\n\nLink expires in 24 hours.`,
                    { purpose: "sos_alert", userId: user.id, dedupeKey: `safe_walk:${walk.id}:${contact.id}` }
                  );
                } catch (err: any) {
                  console.error(`[SAFE-WALK] Escalation SMS to contact=${contact.id} (phone ***${contact.phone.slice(-4)}) failed:`, err?.message || err);
                }
              } else {
                console.log(`[SAFE-WALK] Skipping SMS for contact=${contact.id}: no phone number`);
              }
              if (isValidEmail(contact.email)) {
                try {
                  const { sendEmail } = await import("./email");
                  await sendEmail(contact.email!.trim(),
                    `StillHere Alert: ${user.name} Did Not Arrive${destInfo}`,
                    `${user.name} has not arrived${destInfo} and is not responding.${noteInfo}${locationInfo}\n\nCheck their status: ${link}\n\nThis link expires in 24 hours for your safety and privacy.`
                  );
                } catch (err: any) {
                  console.error(`[SAFE-WALK] Escalation email to contact=${contact.id} failed:`, err?.message || err);
                }
              }
              allContactIds.push(contact.id);
            }
            escalationTimeline.push({
              type: "contact_alert",
              time: now.toISOString(),
              detail: `Emergency contacts alerted for Safe Walk${destInfo}. Notified ${allContactIds.length} contact(s).`,
            });

            await storage.updateIncident(incident.id, {
              escalationLevel: allContactIds.length,
              lastEscalationStep: `contact_${allContactIds.length}`,
              notifiedContactIds: JSON.stringify(allContactIds),
              lastContactNotifiedAt: now,
              contact1NotifiedAt: now,
              contact2NotifiedAt: allContactIds.length > 1 ? now : undefined,
              allContactsNotifiedAt: now,
              nextActionAt: addMinutes(now, 30),
              escalationTimeline: JSON.stringify(escalationTimeline),
            });

            walkEscalations++;
            console.log(`[CRON] Safe Walk escalated for user=${user.id}`);
          } catch (err) {
            console.error("[CRON] Safe Walk escalation failed:", err);
          }
        }
      } catch (err) {
        console.error("[CRON] Safe Walk check failed:", err);
      }

      // ---- Family Place Schedule evaluator ----
      // For every active schedule whose window has now passed (+ grace) on a
      // scheduled day, check whether the assigned member is currently inside
      // the place's radius. If not (and we haven't already alerted today),
      // post a system message into the family chat.
      let placeScheduleAlerts = 0;
      try {
        const schedules = await storage.getAllActiveFamilyPlaceSchedules();
        if (schedules.length > 0) {
          const nowLocal = new Date();
          const today = nowLocal.getDay(); // 0..6
          const nowMinutes = nowLocal.getHours() * 60 + nowLocal.getMinutes();
          // Use the LOCAL calendar date (not UTC) for the dedupe key, so we
          // don't accidentally suppress or duplicate alerts around midnight.
          const todayStr = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth() + 1).padStart(2, "0")}-${String(nowLocal.getDate()).padStart(2, "0")}`;

          // Cache per-family lookups so we don't re-fetch the same family N times.
          const placesCache = new Map<string, Awaited<ReturnType<typeof storage.getFamilyPlaces>>>();
          const overviewCache = new Map<string, Awaited<ReturnType<typeof storage.getActiveFamilyForUser>>>();

          for (const s of schedules) {
            try {
              if (s.lastAlertedDate === todayStr) continue;
              const days = s.daysOfWeek.split(",").map(d => parseInt(d, 10));
              if (!days.includes(today)) continue;
              // Only fire once the window has fully ended + grace.
              // Clamp to 23:59 so a late-evening window with a long grace
              // (e.g. 23:30 + 60min = 24:30) still fires before midnight rolls
              // the day over, instead of being skipped forever.
              const dueAt = Math.min(1439, s.expectedEndMinutes + (s.graceMinutes || 0));
              if (nowMinutes < dueAt) continue;

              let places = placesCache.get(s.familyId);
              if (!places) {
                places = await storage.getFamilyPlaces(s.familyId);
                placesCache.set(s.familyId, places);
              }
              const place = places.find(p => p.id === s.placeId);
              if (!place) continue;

              // We need member info + their last-known position. Easiest path:
              // pull overview via any active member (the schedule was created by
              // an admin so the family is real). Cache it.
              let overview = overviewCache.get(s.familyId);
              if (!overview) {
                // findFirst userId in the family for the lookup
                const recipients = await storage.getActiveFamilyUserIds(s.familyId);
                if (recipients.length === 0) continue;
                overview = await storage.getActiveFamilyForUser(recipients[0]);
                overviewCache.set(s.familyId, overview);
              }
              if (!overview?.family) continue;

              const member = overview.members.find(m => m.id === s.memberId);
              if (!member) continue;
              if (member.lastLat == null || member.lastLng == null) {
                // Treat unknown location as a miss - it's literally what the
                // parent wanted to know about ("we have no idea where she is")
              } else {
                const dist = haversineDistance(member.lastLat, member.lastLng, place.lat, place.lng);
                if (dist <= place.radiusMeters) continue; // She's there - silent
              }

              const body = member.lastLat == null
                ? `${member.name} hasn't checked in yet for ${place.name} today. Last seen position is unknown.`
                : `${member.name} doesn't appear to be at ${place.name} (expected by now).`;

              if (member.userId) {
                broadcastToFamily(member.userId, body, "system",
                  { kind: "place_missed", place: place.name, scheduleId: s.id }
                ).catch(() => {});
              } else {
                // Member without a linked user account - notify directly via the
                // admin/sender channel by calling broadcast on the schedule creator.
                if (s.createdByUserId) {
                  broadcastToFamily(s.createdByUserId, body, "system",
                    { kind: "place_missed", place: place.name, scheduleId: s.id }
                  ).catch(() => {});
                }
              }
              await storage.markScheduleAlerted(s.id, todayStr);
              placeScheduleAlerts++;
            } catch (e) {
              console.error("[CRON] schedule eval failed for", s.id, e);
            }
          }
        }
      } catch (err) {
        console.error("[CRON] Family place schedule check failed:", err);
      }

      // Batch 2: drain processor cleanup queue (Stripe / RevenueCat / outbound
      // log purge) for accounts deleted since the last tick. Bounded work,
      // never throws -- failures stay queued for the next tick.
      let processorCleanup = { processed: 0, succeeded: 0, stillFailing: 0, abandoned: 0, pruned: 0 };
      try {
        processorCleanup = await drainProcessorCleanupQueue();
      } catch (err) {
        console.error("[CRON] processor cleanup drain failed:", err);
      }

      // Stale-incident sweeper. Without this, an incident that gets stuck
      // open (resolve path failed mid-flight, watcher claimed via SMS but the
      // claim ack was lost, escalation completed with no resolution) blocks
      // every future SOS press for that user via the dedup logic in /api/sos.
      // Threshold = 4 hours of no escalation activity. Genuine ongoing
      // escalation runs at 20 min per step over up to 5 contacts, so a real
      // active incident never trips this cap.
      let staleArchived = 0;
      try {
        const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000;
        const stale = await storage.getStaleOpenIncidents(STALE_THRESHOLD_MS);
        for (const inc of stale) {
          try {
            const lastTouched = inc.lastContactNotifiedAt
              ? new Date(inc.lastContactNotifiedAt).getTime()
              : new Date(inc.startedAt).getTime();
            const stalenessMin = Math.round((Date.now() - lastTouched) / 60_000);
            const timeline: any[] = (() => {
              try { return JSON.parse(inc.escalationTimeline || "[]"); } catch { return []; }
            })();
            timeline.push({
              type: "auto_archived",
              time: new Date().toISOString(),
              detail: `Auto-archived by sweeper after ${stalenessMin} min of no escalation activity`,
            });
            await storage.updateIncident(inc.id, {
              status: "resolved",
              resolvedAt: new Date(),
              escalationTimeline: JSON.stringify(timeline),
            });
            // End any associated active location session so we are not
            // collecting GPS for a closed incident.
            const session = await storage.getActiveLocationSession(inc.userId);
            if (session) {
              try { await storage.endLocationSession(session.id); } catch {}
            }
            // Restore safety state if the user is still in concern from this
            // incident. The safety-state worker also nudges users to quiet
            // based on heartbeat, but explicitly clearing here avoids leaving
            // a watcher's UI flagged red after we have given up on the
            // incident.
            const u = await storage.getUser(inc.userId);
            if (u?.safetyState === "concern") {
              await storage.updateSafetyState(inc.userId, "active", "Stale incident auto-archived").catch(() => {});
            }
            staleArchived++;
            console.log(JSON.stringify({
              event: "INCIDENT_AUTO_ARCHIVED",
              incidentId: inc.id,
              userId: inc.userId,
              reason: inc.reason,
              stalenessMinutes: stalenessMin,
              startedAt: inc.startedAt,
              timestamp: new Date().toISOString(),
            }));
          } catch (e: any) {
            console.error(`[CRON] Failed to auto-archive stale incident ${inc.id}:`, e?.message || e);
          }
        }
      } catch (err) {
        console.error("[CRON] Stale-incident sweeper failed:", err);
      }

      cronRunning = false;
      res.json({ success: true, reminders: remindersSent, alerts: alertsSent, escalations, reportsSent, softDeletesCleaned, locationWakeups, timerEscalations, placeScheduleAlerts, processorCleanup, staleArchived, normalizedLegacyIntervals });
    } catch (error) {
      cronRunning = false;
      console.error("Error in cron tick:", error);
      res.status(500).json({ error: "Cron tick failed" });
    }
  });

  app.get("/api/safety-state/tick", async (req, res) => {
    let releaseSafetyLock: null | (() => Promise<void>) = null;
    try {
      const cronSecret = process.env.SESSION_SECRET;
      if (!cronSecret) return res.status(500).json({ error: "Server misconfigured" });
      const providedSecret = req.headers["x-cron-secret"];
      if (providedSecret !== cronSecret) return res.status(403).json({ error: "Forbidden" });
      releaseSafetyLock = await tryAcquireDbAdvisoryLock(SAFETY_STATE_TICK_LOCK_ID);
      if (!releaseSafetyLock) {
        return res.json({ ok: true, skipped: true, reason: "safety-state tick already running on another instance", transitioned: 0 });
      }

      const QUIET_THRESHOLD_SECONDS = 180;
      const staleUsers = await storage.getStaleActiveUsers(QUIET_THRESHOLD_SECONDS);
      let transitioned = 0;
      for (const user of staleUsers) {
        await storage.updateSafetyState(user.id, "quiet", "No heartbeat received for 3 minutes");
        transitioned++;
      }
      if (releaseSafetyLock) {
        await releaseSafetyLock();
        releaseSafetyLock = null;
      }
      res.json({ ok: true, transitioned });
    } catch (error) {
      if (releaseSafetyLock) {
        await releaseSafetyLock().catch((unlockError) => console.error("[CRON] Failed to release safety-state advisory lock:", unlockError));
      }
      console.error("Error in safety-state tick:", error);
      res.status(500).json({ error: "Safety state tick failed" });
    }
  });

  // ============================================================
  // Family Mode (safety group  -  NOT parental control / surveillance)
  // ============================================================
  app.get("/api/family", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      // Use the inclusive helper so admins see pending invitees in their
      // member list (so they can manage them). Non-admin members still only
      // see effectively-active members because getFamilyForUser filters its
      // member list for non-admins.
      const overview = await storage.getFamilyForUser(userId);
      res.json(overview);
    } catch (e) {
      console.error("[family] get failed", e);
      res.status(500).json({ error: "Failed to load family" });
    }
  });

  app.post("/api/family", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const name = (req.body?.name || "").toString().trim();
      if (!name) return res.status(400).json({ error: "Family name is required" });
      // Prevent duplicate family per admin
      const existing = await storage.getActiveFamilyForUser(userId);
      if (existing.family) return res.status(409).json({ error: "You already belong to a family" });
      const family = await storage.createFamily(userId, name);
      res.json({ family });
    } catch (e) {
      console.error("[family] create failed", e);
      res.status(500).json({ error: "Failed to create family" });
    }
  });

  app.post("/api/family/invite", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getActiveFamilyForUser(userId);
      if (!overview.family) return res.status(404).json({ error: "Create a family first" });
      if (!overview.isAdmin) return res.status(403).json({ error: "Only the family admin can invite" });

      const name = (req.body?.name || "").toString().trim();
      const phoneRaw = (req.body?.phone || "").toString().trim();
      const role = (req.body?.role || "adult") as FamilyRole;
      if (!name || !phoneRaw) return res.status(400).json({ error: "Name and phone are required" });
      // COPPA / age gate (Batch 3). StillHere is for 13+. teen/child roles
      // are NOT supported in v1 (no parental consent flow). Block at API.
      if (role === "teen" || role === "child") {
        return res.status(400).json({
          error: "role_not_supported",
          message: "StillHere is for users 13 and older. Invite as Adult.",
        });
      }
      if (!["admin", "adult"].includes(role)) return res.status(400).json({ error: "Invalid role" });

      const phone = normalizePhone(phoneRaw);
      const member = await storage.inviteFamilyMember({
        familyId: overview.family.id,
        invitedBy: userId,
        name,
        phone,
        role,
        // No parental consent flow in v1. teen/child roles are blocked above.
        parentalConsentRequired: false,
      });

      // Send the SMS invite (best-effort - does not block the API response).
      // Dedupe is enforced server-wide by the outbound policy (Category-A:
      // 30-minute per-destination cooldown + per-user/IP hourly + daily caps).
      // Phone numbers are PII - they are NEVER logged here, only the family
      // id and policy result are. Use family_id + outbound logs in the DB to
      // diagnose specific destinations.
      let deduped = false;
      try {
          const inviter = await storage.getUser(userId);
          const inviterName = inviter?.name || "Someone you trust";
          const baseUrl = getBaseUrl();
          const existingUser = await storage.getUserByPhone(phone);
          // Consent disclosure (Round 3 plan): make it explicit to the
          // invitee that joining is opt-in. Inviter cannot see safety or
          // location until the invitee accepts in-app.
          const body = existingUser
            ? `${inviterName} invited you to their StillHere Family. Open the app to accept or decline. They will not see your safety status or location until you accept.`
            : `${inviterName} invited you to their StillHere Family. Join and accept here: ${baseUrl} They will not see your safety status or location until you accept.`;
          if (isTwilioConfigured()) {
            const inviteResult = await sendSms(phone, body, {
              purpose: "family_invite",
              userId,
              ipAddress: req.ip,
              dedupeKey: `family_invite:${overview.family.id}:${phone}`,
            });
            if (inviteResult.success) {
              console.log(`[INVITE] SMS sent (family:${overview.family.id.slice(0, 8)})`);
            } else if (inviteResult.error?.startsWith("policy:")) {
              deduped = true;
              console.log(`[INVITE] SMS suppressed by policy (${inviteResult.error}) family:${overview.family.id.slice(0, 8)}`);
            } else {
              console.warn(`[INVITE] SMS send failed family:${overview.family.id.slice(0, 8)}: ${inviteResult.error}`);
            }
          } else {
            console.warn(`[INVITE] SMS skipped (Twilio not configured) family:${overview.family.id.slice(0, 8)}`);
          }
      } catch (smsErr: any) {
        console.warn("[INVITE] SMS prep failed:", smsErr?.message || "unknown");
      }

      res.json({ member, deduped });
    } catch (e: any) {
      // Surface the 24h decline cooldown so the client can show a clear
      // message instead of a generic 500. Phone is never echoed back.
      if (e?.message === "decline_cooldown") {
        const retryAfterSec = Math.ceil((e.retryAfterMs || 24 * 60 * 60 * 1000) / 1000);
        return res.status(429).json({
          error: "decline_cooldown",
          message: "This person declined a recent invite. You can re-invite them after 24 hours.",
          retryAfter: retryAfterSec,
        });
      }
      console.error("[family] invite failed", e);
      res.status(500).json({ error: "Failed to invite member" });
    }
  });

  // ----- Invitations inbox + accept / decline (consent gate) -----

  app.get("/api/family/invitations", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const invitations = await storage.getPendingInvitationsForUser(userId);
      res.json({ invitations });
    } catch (e) {
      console.error("[family] invitations list failed", e);
      res.status(500).json({ error: "Failed to load invitations" });
    }
  });

  app.post("/api/family/invite/:memberId/accept", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const memberId = req.params.memberId;
      const updated = await storage.acceptFamilyInvite(memberId, userId);
      // Notify the inviter that the invite was accepted. Decline is
      // intentionally silent (anti-harassment rule).
      try {
        const family = await storage.getActiveFamilyForUser(userId);
        const me = await storage.getUser(userId);
        const inviterId = updated.invitedBy || family.family?.adminUserId;
        if (inviterId && inviterId !== userId) {
          await sendPushNotification(inviterId, {
            title: "Family invite accepted",
            body: `${me?.name || "Someone"} accepted your StillHere Family invite.`,
            url: "/family",
            tag: `family-accept:${updated.id}`,
          }).catch(() => {});
          emitToUser(inviterId, "family:invite:accepted", { memberId: updated.id });
        }
      } catch {}
      res.json({ member: updated });
    } catch (e: any) {
      const status = e?.status || 500;
      if (status >= 500) console.error("[family] invite accept failed", e);
      res.status(status).json({ error: e?.message || "Failed to accept invite" });
    }
  });

  app.post("/api/family/invite/:memberId/decline", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const memberId = req.params.memberId;
      const updated = await storage.declineFamilyInvite(memberId, userId);
      // No notification to inviter (anti-harassment).
      res.json({ member: updated });
    } catch (e: any) {
      const status = e?.status || 500;
      if (status >= 500) console.error("[family] invite decline failed", e);
      res.status(status).json({ error: e?.message || "Failed to decline invite" });
    }
  });

  // (Family invite dedupe is now enforced server-wide by enforceSendPolicy
  // in server/outbound-policy.ts via the family_invite Category-A rule:
  // 30-minute per-destination cooldown + per-user/IP hourly + daily caps.)

  // "Watch over me while I'm here"  -  starts a real live-location session
  // (continuous GPS share for a chosen duration) and tells every family member
  // the user is asking to be watched. The client then pumps GPS updates via
  // the existing /api/live-location/update endpoint for the duration.
  // Per-user cooldown prevents flooding family inboxes / SMS bills.
  const familyShareCooldown = new Map<string, number>();
  const FAMILY_SHARE_COOLDOWN_MS = 15_000;

  app.post("/api/family/watch-me/stop", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      await storage.stopLiveLocationShare(userId);
      const overview = await storage.getActiveFamilyForUser(userId);
      const me = await storage.getUser(userId);
      const myName = me?.name || "A family member";
      if (overview.family) {
        const recipients = overview.members.filter(
          (m) => m.userId && m.userId !== userId && (m.status === "active" || m.status === "active_legacy"),
        );
        for (const r of recipients) {
          try {
            const msg = await storage.saveMessage(
              userId,
              r.userId!,
              `${myName} stopped sharing live location with the family.`,
              { messageType: "system_info", meta: { kind: "family_watch_stop" } },
            );
            emitToUser(r.userId!, "message:new", { message: msg, fromUserId: userId });
          } catch {}
        }
      }
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[family] watch-me stop failed:", e?.message || "unknown");
      res.status(500).json({ error: "Failed to stop" });
    }
  });

  // Backwards-compat alias kept for the previous button wiring.
  app.post("/api/family/share-location", async (req, res, next) => {
    (req as any).url = "/api/family/watch-me/start";
    next();
  });

  app.post("/api/family/watch-me/start", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const lat = Number(req.body?.lat);
      const lng = Number(req.body?.lng);
      const accuracyRaw = req.body?.accuracy;
      const accuracy = accuracyRaw != null ? Number(accuracyRaw) : undefined;
      const durationRaw = req.body?.durationMinutes;
      const durationMinutes =
        durationRaw === null || durationRaw === undefined
          ? 30
          : Number(durationRaw);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        return res.status(400).json({ error: "lat must be between -90 and 90" });
      }
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
        return res.status(400).json({ error: "lng must be between -180 and 180" });
      }
      if (accuracy !== undefined && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100_000)) {
        return res.status(400).json({ error: "accuracy out of range" });
      }
      if (!Number.isFinite(durationMinutes) || durationMinutes < 5 || durationMinutes > 480) {
        return res.status(400).json({ error: "durationMinutes must be between 5 and 480" });
      }

      const lastAt = familyShareCooldown.get(userId) || 0;
      const now = Date.now();
      if (now - lastAt < FAMILY_SHARE_COOLDOWN_MS) {
        const retryAfter = Math.ceil((FAMILY_SHARE_COOLDOWN_MS - (now - lastAt)) / 1000);
        return res.status(429).json({ error: "Please wait a moment before starting again", retryAfter });
      }
      familyShareCooldown.set(userId, now);

      const overview = await storage.getActiveFamilyForUser(userId);
      if (!overview.family) return res.status(404).json({ error: "Create a family first" });

      // Tracking-policy gate: this is a foreground "watch me" share button.
      // If the user has explicitly paused or turned location off, refuse so
      // sensitive coords don't leak past their stated preference.
      const wmPolicy = await getTrackingPolicyForUser(userId);
      if (!wmPolicy.nativeTrackingAllowed) {
        console.log(`[TRACKING_POLICY] family/watch-me/start rejected (no allowed policy)`);
        return res.status(403).json({
          error: "Sharing is paused or location is off. Update your sharing settings to start.",
          policy: wmPolicy,
        });
      }

      // 1) Update heartbeat so map pin refreshes immediately.
      await storage.recordHeartbeat(userId, lat, lng, accuracy);
      emitTrackingPolicyChanged(userId, "watch_me_start").catch(() => {});

      // 2) Start a real live-location session for the chosen duration. The
      //    client will pump GPS updates via /api/live-location/update.
      const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);
      const share = await storage.startLiveLocationShare(userId, expiresAt);

      // 3) Record a check-in too (so it appears in safety history).
      try {
        await storage.createCheckin(userId, "button", { lat, lng });
      } catch (err: any) {
        console.warn("[family] watch-me createCheckin failed:", err?.message || "unknown");
      }

      // 4) Notify every other linked active member: persist a system_info
      //    message and emit a socket event for instant in-app delivery.
      const me = await storage.getUser(userId);
      const myName = me?.name || "A family member";
      const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
      const recipients = overview.members.filter(
        (m) => m.userId && m.userId !== userId && (m.status === "active" || m.status === "active_legacy"),
      );
      const durationLabel =
        durationMinutes >= 60
          ? `${Math.round(durationMinutes / 60)} hr`
          : `${durationMinutes} min`;
      for (const r of recipients) {
        try {
          const msg = await storage.saveMessage(
            userId,
            r.userId!,
            `${myName} asked the family to watch over them for ${durationLabel}.`,
            {
              messageType: "system_info",
              meta: {
                kind: "family_watch_start",
                lat,
                lng,
                accuracy,
                mapsUrl,
                durationMinutes,
                expiresAt: expiresAt.toISOString(),
                sharedAt: new Date().toISOString(),
              },
            },
          );
          emitToUser(r.userId!, "message:new", { message: msg, fromUserId: userId });
          await sendPushNotification(r.userId!, {
            title: `${myName} started Watch Me`,
            body: `${myName} is sharing live location with the family for ${durationLabel}.`,
            url: "/family",
            tag: "family-watch-start",
          }, {
            purpose: "presence",
            dedupeKey: `family_watch_start:${share.id}:${r.userId}`,
          });
        } catch (err: any) {
          console.warn(
            `[family] watch-me notify failed for user:${r.userId?.slice(0, 8)}:`,
            err?.message || "unknown",
          );
        }
      }

      res.json({
        ok: true,
        notified: recipients.length,
        lat,
        lng,
        durationMinutes,
        expiresAt: expiresAt.toISOString(),
        shareId: share.id,
      });
    } catch (e: any) {
      console.error("[family] watch-me start failed:", e?.message || "unknown");
      res.status(500).json({ error: "Failed to start watch session" });
    }
  });

  app.patch("/api/family/member/:memberId", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const memberId = req.params.memberId;
      const member = await storage.getFamilyMember(memberId);
      if (!member) return res.status(404).json({ error: "Member not found" });

      const overview = await storage.getActiveFamilyForUser(userId);
      if (!overview.family || overview.family.id !== member.familyId) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const isSelf = member.userId === userId;
      const isAdmin = overview.isAdmin;
      const updates: any = {};

      // Sharing mode: members change their own only. The previous
      // "admin can change for under-16" branch is removed in Batch 3 because
      // teen/child roles are no longer supported (StillHere v1 is 13+; no
      // parental consent flow). Each adult controls their own sharing mode,
      // matching the Family Mode UI copy.
      if (req.body?.sharingMode) {
        const m = req.body.sharingMode;
        if (!["precise", "area", "presence", "paused"].includes(m)) {
          return res.status(400).json({ error: "Invalid sharing mode" });
        }
        if (isSelf) {
          updates.sharingMode = m;
          // The member whose sharingMode is changing needs to re-evaluate their
          // tracking policy immediately. Emit to that user so their device
          // stops/starts native GPS.
          if (member.userId) {
            emitTrackingPolicyChanged(member.userId, "family_sharing_mode").catch(() => {});
          }
        } else {
          return res.status(403).json({ error: "Only the member can change their sharing mode" });
        }
      }

      // Admin-only fields
      if (req.body?.role !== undefined) {
        if (!isAdmin) return res.status(403).json({ error: "Admin only" });
        // COPPA / age gate (Batch 3). teen/child are not supported in v1.
        // Existing teen/child rows can still be read but cannot be set or
        // re-saved as teen/child. Admin can promote them to adult/admin.
        if (req.body.role === "teen" || req.body.role === "child") {
          return res.status(400).json({
            error: "role_not_supported",
            message: "StillHere is for users 13 and older. Invite as Adult.",
          });
        }
        if (!["admin", "adult"].includes(req.body.role)) {
          return res.status(400).json({ error: "Invalid role" });
        }
        updates.role = req.body.role;
      }
      if (req.body?.status !== undefined) {
        if (!isAdmin) return res.status(403).json({ error: "Admin only" });
        // Consent state machine: admin PATCH may only pause an active member
        // or unpause back to active. Transitions involving pending /
        // active_legacy / declined go through the dedicated invite/accept/
        // decline endpoints. Removal goes through DELETE /api/family/member.
        if (!["active", "paused"].includes(req.body.status)) {
          return res.status(400).json({
            error: "status_transition_not_allowed",
            message: "Use the accept, decline, or remove actions for this change.",
          });
        }
        // Defense-in-depth: do not allow an admin PATCH to bypass the consent
        // gate by flipping a pending / declined / active_legacy row directly
        // to active. active_legacy specifically must go through the invitee's
        // explicit accept (or expire to pending) before becoming active.
        if (
          member.status === "pending" ||
          member.status === "invited" ||
          member.status === "declined" ||
          member.status === "active_legacy"
        ) {
          return res.status(409).json({
            error: "status_transition_not_allowed",
            message: "This invitation is awaiting the invitee's response.",
          });
        }
        updates.status = req.body.status;
      }
      if (req.body?.parentalConsentGranted !== undefined) {
        if (!isAdmin) return res.status(403).json({ error: "Admin only" });
        updates.parentalConsentGranted = !!req.body.parentalConsentGranted;
      }
      if (req.body?.parentalConsentRequired !== undefined) {
        if (!isAdmin) return res.status(403).json({ error: "Admin only" });
        updates.parentalConsentRequired = !!req.body.parentalConsentRequired;
      }

      // Nickname: family-scoped display name (e.g. "Dad", "Mum", "Kid").
      // Admins can rename anyone; members can rename themselves. Empty string
      // clears the nickname and falls back to the underlying user/invite name.
      if (req.body?.nickname !== undefined) {
        if (!isAdmin && !isSelf) {
          return res.status(403).json({ error: "Only an admin or this member can rename" });
        }
        const raw = typeof req.body.nickname === "string" ? req.body.nickname.trim() : "";
        if (raw.length > 40) {
          return res.status(400).json({ error: "Nickname is too long (max 40 characters)" });
        }
        updates.nickname = raw.length === 0 ? null : raw;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No valid fields to update" });
      }

      const updated = await storage.updateFamilyMember(memberId, updates);
      res.json({ member: updated });
    } catch (e) {
      console.error("[family] update failed", e);
      res.status(500).json({ error: "Failed to update member" });
    }
  });

  // ---- Family Chat + Pulse + Close ----

  app.get("/api/family/messages", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getActiveFamilyForUser(userId);
      if (!overview.family) return res.json({ messages: [] });
      const messages = await storage.getFamilyMessages(overview.family.id, 200);
      // Hydrate sender names without N+1 surprises - small N here.
      const senderIds = Array.from(new Set(messages.map(m => m.senderId).filter((s): s is string => !!s)));
      const nameById = new Map<string, string>();
      for (const id of senderIds) {
        const u = await storage.getUser(id);
        if (u) nameById.set(id, u.name || "Family member");
      }
      res.json({
        messages: messages.map(m => ({
          ...m,
          senderName: m.senderId ? (nameById.get(m.senderId) || "Family member") : null,
        })),
      });
    } catch (e) {
      console.error("[family] messages get failed", e);
      res.status(500).json({ error: "Failed to load messages" });
    }
  });

  app.post("/api/family/messages", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const body = (req.body?.body || "").toString().trim();
      if (!body) return res.status(400).json({ error: "Message cannot be empty" });
      if (body.length > 2000) return res.status(400).json({ error: "Message too long" });
      const overview = await storage.getActiveFamilyForUser(userId);
      if (!overview.family) return res.status(404).json({ error: "Create a family first" });

      const msg = await storage.saveFamilyMessage({
        familyId: overview.family.id,
        senderId: userId,
        body,
        kind: "user",
      });
      const me = await storage.getUser(userId);
      const payload = { ...msg, senderName: me?.name || "Family member" };
      const recipients = await storage.getActiveFamilyUserIds(overview.family.id);
      for (const uid of recipients) {
        emitToUser(uid, "family:message:new", payload);
      }
      res.json({ message: payload });
    } catch (e) {
      console.error("[family] message send failed", e);
      res.status(500).json({ error: "Failed to send" });
    }
  });

  // Family Pulse - one-tap "I'm OK" broadcast. Optional location attached.
  app.post("/api/family/pulse", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getActiveFamilyForUser(userId);
      if (!overview.family) return res.status(404).json({ error: "Create a family first" });
      const me = await storage.getUser(userId);
      const myName = me?.name || "Family member";

      const rawLat = req.body?.lat != null ? Number(req.body.lat) : null;
      const rawLng = req.body?.lng != null ? Number(req.body.lng) : null;
      // Honor tracking policy: if denied, drop the coords but still send the
      // pulse text so family knows the user is OK.
      let lat: number | null = null;
      let lng: number | null = null;
      if (rawLat != null && rawLng != null && Number.isFinite(rawLat) && Number.isFinite(rawLng)) {
        const pPolicy = await getTrackingPolicyForUser(userId);
        if (pPolicy.nativeTrackingAllowed) {
          lat = rawLat; lng = rawLng;
          await storage.recordHeartbeat(userId, lat, lng).catch(() => {});
        } else {
          console.log(`[TRACKING_POLICY] family/pulse coords stripped (policy deny)`);
        }
      }

      const msg = await storage.saveFamilyMessage({
        familyId: overview.family.id,
        senderId: userId,
        body: `${myName} is OK.`,
        kind: "pulse",
        meta: lat != null && lng != null ? { lat, lng } : undefined,
      });
      const payload = { ...msg, senderName: myName };
      const recipients = await storage.getActiveFamilyUserIds(overview.family.id);
      for (const uid of recipients) emitToUser(uid, "family:message:new", payload);
      res.json({ message: payload });
    } catch (e) {
      console.error("[family] pulse failed", e);
      res.status(500).json({ error: "Failed to send pulse" });
    }
  });

  // Family Panic - urgent broadcast to family chat. Does NOT replace the
  // user's full SOS / contact-escalation flow (the home SOS still does that).
  app.post("/api/family/panic", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getActiveFamilyForUser(userId);
      if (!overview.family) return res.status(404).json({ error: "Create a family first" });
      const me = await storage.getUser(userId);
      const myName = me?.name || "Family member";
      const rawLat = req.body?.lat != null ? Number(req.body.lat) : null;
      const rawLng = req.body?.lng != null ? Number(req.body.lng) : null;
      const note = (req.body?.note || "").toString().trim().slice(0, 280);
      // Panic broadcast is critical: ALWAYS deliver the message, but honor
      // tracking policy for coordinate persistence (if denied, drop coords).
      let lat: number | null = null;
      let lng: number | null = null;
      if (rawLat != null && rawLng != null && Number.isFinite(rawLat) && Number.isFinite(rawLng)) {
        const panicPolicy = await getTrackingPolicyForUser(userId);
        if (panicPolicy.nativeTrackingAllowed) {
          lat = rawLat; lng = rawLng;
          await storage.recordHeartbeat(userId, lat, lng).catch(() => {});
        } else {
          console.log(`[TRACKING_POLICY] family/panic coords stripped (policy deny)`);
        }
      }
      const body = note
        ? `${myName} needs help: ${note}`
        : `${myName} needs help right now.`;
      const msg = await storage.saveFamilyMessage({
        familyId: overview.family.id,
        senderId: userId,
        body,
        kind: "panic",
        meta: lat != null && lng != null ? { lat, lng } : undefined,
      });
      const payload = { ...msg, senderName: myName };
      const recipients = await storage.getActiveFamilyUserIds(overview.family.id);
      for (const uid of recipients) {
        emitToUser(uid, "family:message:new", payload);
        // Best-effort push so offline family members are paged.
        try {
          await sendPushNotification(uid, {
            title: `${myName} needs help`,
            body: note || "Tap to open the family map.",
            url: "/family",
            tag: "family-panic",
          });
        } catch {}
      }
      res.json({ message: payload });
    } catch (e) {
      console.error("[family] panic failed", e);
      res.status(500).json({ error: "Failed to send alert" });
    }
  });

  // Admin closes (deletes) the entire family group. Members are detached;
  // group chat history is removed. Self-leave goes through DELETE /family/member/:id.
  app.delete("/api/family", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getActiveFamilyForUser(userId);
      if (!overview.family) return res.status(404).json({ error: "No family to close" });
      if (!overview.isAdmin) return res.status(403).json({ error: "Only admin can close the family" });
      const recipients = await storage.getActiveFamilyUserIds(overview.family.id);
      await storage.deleteFamily(overview.family.id);
      for (const uid of recipients) emitToUser(uid, "family:closed", { familyId: overview.family.id });
      res.json({ ok: true });
    } catch (e) {
      console.error("[family] close failed", e);
      res.status(500).json({ error: "Failed to close family" });
    }
  });

  // ---- Family Saved Places (Home / School / Work) ----
  app.get("/api/family/places", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getActiveFamilyForUser(userId);
      if (!overview.family) return res.json({ places: [] });
      const places = await storage.getFamilyPlaces(overview.family.id);
      res.json({ places });
    } catch (e) {
      console.error("[family] places get failed", e);
      res.status(500).json({ error: "Failed to load places" });
    }
  });

  app.post("/api/family/places", systemMessageLimiter, async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getActiveFamilyForUser(userId);
      if (!overview.family) return res.status(404).json({ error: "Create a family first" });

      const name = (req.body?.name || "").toString().trim().slice(0, 60);
      const icon = ["home", "school", "work", "gym", "park", "pin"].includes(req.body?.icon)
        ? req.body.icon : "pin";
      const lat = Number(req.body?.lat);
      const lng = Number(req.body?.lng);
      const radiusMeters = Math.max(50, Math.min(2000, Number(req.body?.radiusMeters) || 150));
      if (!name) return res.status(400).json({ error: "Name is required" });
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ error: "lat/lng required" });
      }
      const place = await storage.createFamilyPlace({
        familyId: overview.family.id, name, icon, lat, lng, radiusMeters,
        createdByUserId: userId,
      });
      res.json({ place });
    } catch (e) {
      console.error("[family] place create failed", e);
      res.status(500).json({ error: "Failed to create place" });
    }
  });

  app.delete("/api/family/places/:placeId", systemMessageLimiter, async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getActiveFamilyForUser(userId);
      if (!overview.family) return res.status(404).json({ error: "No family" });
      // Only admin can delete shared places (kept simple, mirrors close-family rule)
      if (!overview.isAdmin) return res.status(403).json({ error: "Only admin can delete places" });
      await storage.deleteFamilyPlace(String(req.params.placeId), overview.family.id);
      // Drop transient transition state so the in-memory map can't grow unbounded
      purgePlaceFromGeofenceState(String(req.params.placeId));
      res.json({ ok: true });
    } catch (e) {
      console.error("[family] place delete failed", e);
      res.status(500).json({ error: "Failed to delete place" });
    }
  });

  // ---- Family Place Schedules (per-member expectations like "Sarah at School Mon-Fri 8:30-15:30") ----
  app.get("/api/family/place-schedules", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getActiveFamilyForUser(userId);
      if (!overview.family) return res.json({ schedules: [] });
      const schedules = await storage.getFamilyPlaceSchedules(overview.family.id);
      res.json({ schedules });
    } catch (e) {
      console.error("[family] place-schedules get failed", e);
      res.status(500).json({ error: "Failed to load schedules" });
    }
  });

  app.post("/api/family/places/:placeId/schedules", systemMessageLimiter, async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getActiveFamilyForUser(userId);
      if (!overview.family) return res.status(404).json({ error: "Create a family first" });
      if (!overview.isAdmin) return res.status(403).json({ error: "Only admin can set place schedules" });

      const placeId = req.params.placeId;
      const places = await storage.getFamilyPlaces(overview.family.id);
      const place = places.find(p => p.id === placeId);
      if (!place) return res.status(404).json({ error: "Place not found" });

      const memberId = (req.body?.memberId || "").toString();
      // Reject synthetic admin rows (id like "admin:<userId>") - they aren't
      // real `family_members` UUIDs and would crash the FK insert.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_RE.test(memberId)) {
        return res.status(400).json({ error: "Pick a real family member" });
      }
      const member = overview.members.find(m => m.id === memberId);
      if (!member) return res.status(400).json({ error: "Member not in this family" });

      // Days like "1,2,3,4,5" - keep only 0..6
      const rawDays = (req.body?.daysOfWeek || "").toString();
      const cleanDays = rawDays.split(",")
        .map((d: string) => parseInt(d.trim(), 10))
        .filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 6);
      if (cleanDays.length === 0) return res.status(400).json({ error: "Pick at least one day" });

      const startMin = Math.max(0, Math.min(1439, parseInt(req.body?.expectedStartMinutes, 10)));
      const endMin = Math.max(0, Math.min(1439, parseInt(req.body?.expectedEndMinutes, 10)));
      if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin <= startMin) {
        return res.status(400).json({ error: "End time must be after start time" });
      }
      const grace = Math.max(0, Math.min(120, parseInt(req.body?.graceMinutes, 10) || 15));

      const schedule = await storage.createFamilyPlaceSchedule({
        familyId: overview.family.id,
        placeId: String(placeId),
        memberId,
        daysOfWeek: cleanDays.join(","),
        expectedStartMinutes: startMin,
        expectedEndMinutes: endMin,
        graceMinutes: grace,
        createdByUserId: userId,
      });
      res.json({ schedule });
    } catch (e) {
      console.error("[family] place-schedule create failed", e);
      res.status(500).json({ error: "Failed to save schedule" });
    }
  });

  app.delete("/api/family/place-schedules/:scheduleId", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getActiveFamilyForUser(userId);
      if (!overview.family) return res.status(404).json({ error: "No family" });
      if (!overview.isAdmin) return res.status(403).json({ error: "Only admin can remove schedules" });
      await storage.deleteFamilyPlaceSchedule(req.params.scheduleId, overview.family.id);
      res.json({ ok: true });
    } catch (e) {
      console.error("[family] place-schedule delete failed", e);
      res.status(500).json({ error: "Failed to remove schedule" });
    }
  });

  app.delete("/api/family/member/:memberId", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const memberId = req.params.memberId;
      const member = await storage.getFamilyMember(memberId);
      if (!member) return res.status(404).json({ error: "Member not found" });

      const overview = await storage.getActiveFamilyForUser(userId);
      if (!overview.family || overview.family.id !== member.familyId) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const isSelf = member.userId === userId;
      // Members may leave; only admin may remove others
      if (!isSelf && !overview.isAdmin) {
        return res.status(403).json({ error: "Only admin can remove other members" });
      }
      await storage.removeFamilyMember(memberId);
      res.json({ ok: true });
    } catch (e) {
      console.error("[family] remove failed", e);
      res.status(500).json({ error: "Failed to remove member" });
    }
  });

  return httpServer;
}

// Best-effort: post a system message into the user's family chat (if they're in one)
// and fan out a push notification + socket event. Always swallows errors so it can
// never break the primary safety flow that called it.
// Optional `prefetched` lets hot paths (geofence/check) avoid N+1 by passing in
// already-loaded familyId / senderName / recipients.
async function broadcastToFamily(
  userId: string,
  body: string,
  kind: "system" | "panic" | "pulse",
  meta?: Record<string, any>,
  push?: { title: string; body: string; url?: string; tag?: string },
  prefetched?: { familyId: string; senderName: string; recipients: string[] },
): Promise<void> {
  try {
    let familyId: string;
    let senderName: string;
    let recipients: string[];
    if (prefetched) {
      ({ familyId, senderName, recipients } = prefetched);
    } else {
      const overview = await storage.getActiveFamilyForUser(userId);
      if (!overview.family) return;
      familyId = overview.family.id;
      const me = await storage.getUser(userId);
      senderName = me?.name || "Family member";
      recipients = await storage.getActiveFamilyUserIds(familyId);
    }
    const msg = await storage.saveFamilyMessage({
      familyId, senderId: userId, body, kind, meta,
    });
    const payload = { ...msg, senderName };
    for (const uid of recipients) {
      try { emitToUser(uid, "family:message:new", payload); } catch {}
    }
    if (push && recipients.length > 0) {
      // Push fan-out runs concurrently (don't await each in series).
      await Promise.allSettled(recipients.map((uid) =>
        sendPushNotification(uid, {
          title: push.title,
          body: push.body,
          url: push.url || "/family",
          tag: push.tag || "family-broadcast",
        }),
      ));
    }
  } catch (err) {
    console.error("[family] broadcastToFamily failed", err);
  }
}

// Walks the in-memory geofence transition state and removes any entry for the
// given place ID across every user. Called when a place is deleted to prevent
// the state map from growing unbounded.
function purgePlaceFromGeofenceState(placeId: string): void {
  const key = `place:${placeId}`;
  for (const userMap of geofenceStateRef.values()) {
    userMap.delete(key);
  }
}

// Set during registerRoutes() so the place-delete handler and helper can purge
// stale entries without leaking across server boots.
let geofenceStateRef: Map<string, Map<string, boolean>> = new Map();

function formatReportTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  const timeStr = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  if (diffDays === 0) return `Today, ${timeStr}`;
  if (diffDays === 1) return `Yesterday, ${timeStr}`;
  const dayName = date.toLocaleDateString("en-US", { weekday: "long" });
  return `${dayName}, ${timeStr}`;
}

function parseEscalationTimeline(value: string | null | undefined): Array<{ type: string; time: string; detail: string }> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => ({
        type: typeof entry?.type === "string" ? entry.type : "event",
        time: typeof entry?.time === "string" ? entry.time : "",
        detail: typeof entry?.detail === "string" ? entry.detail : "",
      }))
      .filter((entry) => entry.time && entry.detail && !Number.isNaN(new Date(entry.time).getTime()))
      .slice(0, 30);
  } catch {
    return [];
  }
}

type SafetyReportTimelineEntry = {
  type: string;
  time: string;
  detail: string;
  source: "checkin" | "missed_checkin" | "safety_timer" | "safe_walk" | "sos" | "contact" | "delivery" | "location" | "system";
};

function reportTimeSortValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatLocationAvailability(at: Date | string | null | undefined): string {
  if (!at) return "Location not available";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "Location not available";
  const ageMs = Date.now() - date.getTime();
  if (ageMs < 2 * 60 * 1000) return "Location fresh: Live now";
  const minutes = Math.max(1, Math.round(ageMs / 60000));
  if (minutes < 60) return `Last known location updated ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `Last known location updated ${hours} hour${hours === 1 ? "" : "s"} ago`;
}

function inferIncidentReportReason(incident: any): string {
  const timeline = parseEscalationTimeline(incident?.escalationTimeline);
  if (timeline.some((entry) => entry.type?.startsWith("safety_timer"))) return "safety_timer";
  if (timeline.some((entry) => entry.type?.startsWith("safe_walk"))) return "safe_walk";
  return incident?.reason || "incident";
}

function describeDelivery(row: any): string | null {
  const key = String(row.dedupeKey || "");
  const channel = String(row.channel || "").toUpperCase();
  const status = String(row.status || "unknown").replace(/_/g, " ");
  if (row.purpose === "wellness_call") return `Wellness call ${status}`;
  if (row.purpose === "sos_alert" && key.startsWith("safe_walk:")) return `Safe Walk emergency contact ${channel} alert ${status}`;
  if (row.purpose === "sos_alert" && key.startsWith("safety_timer:")) return `Safety Timer emergency contact ${channel} alert ${status}`;
  if (key.startsWith("safe_walk:")) return `Safe Walk ${channel} delivery ${status}`;
  if (key.startsWith("safety_timer:")) return `Safety Timer ${channel} delivery ${status}`;
  if (row.purpose === "reminder") return `Reminder ${channel} delivery ${status}`;
  if (row.purpose === "missed_checkin_alert") return `Missed check-in ${channel} delivery ${status}`;
  if (row.purpose === "sos_alert") return `Emergency contact ${channel} alert ${status}`;
  return null;
}

async function buildSafetyActivityTimeline(userId: string, from: Date, to: Date): Promise<SafetyReportTimelineEntry[]> {
  const events: SafetyReportTimelineEntry[] = [];
  const inWindow = (date: Date | null | undefined) => !!date && date >= from && date <= to;

  const [timerRows, walkRows, incidentRows, deliveryRows] = await Promise.all([
    db.select().from(safetyTimers).where(eq(safetyTimers.userId, userId)).orderBy(desc(safetyTimers.startedAt)),
    db.select().from(safeWalks).where(eq(safeWalks.userId, userId)).orderBy(desc(safeWalks.startedAt)),
    db.select().from(incidents).where(and(eq(incidents.userId, userId), gte(incidents.startedAt, from))).orderBy(desc(incidents.startedAt)),
    db.select().from(outboundSendLog).where(and(eq(outboundSendLog.userId, userId), gte(outboundSendLog.createdAt, from))).orderBy(desc(outboundSendLog.createdAt)),
  ]);

  for (const timer of timerRows) {
    if (inWindow(timer.startedAt)) {
      const note = timer.note ? ` (${timer.note})` : "";
      events.push({
        type: "safety_timer_started",
        time: timer.startedAt.toISOString(),
        source: "safety_timer",
        detail: `Safety Timer started for ${timer.durationMinutes} minutes${note}. ${formatLocationAvailability(timer.lastLocationAt)}.`,
      });
      events.push({
        type: "safety_timer_extension_history_unavailable",
        time: timer.startedAt.toISOString(),
        source: "safety_timer",
        detail: "Safety Timer extension history was not recorded separately in this version.",
      });
    }
    if (timer.status === "safe" && inWindow(timer.resolvedAt)) {
      events.push({
        type: "safety_timer_safe",
        time: timer.resolvedAt!.toISOString(),
        source: "safety_timer",
        detail: `Safety Timer cancelled / marked safe. ${formatLocationAvailability(timer.lastLocationAt)}.`,
      });
    }
    if (timer.status === "cancelled" && inWindow(timer.resolvedAt)) {
      events.push({
        type: "safety_timer_cancelled",
        time: timer.resolvedAt!.toISOString(),
        source: "safety_timer",
        detail: `Safety Timer cancelled. ${formatLocationAvailability(timer.lastLocationAt)}.`,
      });
    }
    if (timer.status === "escalated" && inWindow(timer.resolvedAt)) {
      events.push({
        type: "safety_timer_escalated",
        time: timer.resolvedAt!.toISOString(),
        source: "safety_timer",
        detail: `Safety Timer expired and escalated. ${formatLocationAvailability(timer.lastLocationAt)}.`,
      });
    }
  }

  for (const walk of walkRows) {
    const destination = walk.destinationName ? ` to ${walk.destinationName}` : "";
    const correlatedIncident = incidentRows.find((incident) => {
      if (incident.reason !== "sos" || !incident.startedAt) return false;
      const startedAt = new Date(incident.startedAt).getTime();
      const dueAt = new Date(walk.expectedArrivalAt).getTime();
      const resolvedAt = walk.resolvedAt ? new Date(walk.resolvedAt).getTime() : dueAt + 2 * 60 * 60 * 1000;
      return startedAt >= dueAt && startedAt <= resolvedAt + 5 * 60 * 1000;
    });
    const resolvedLate = !!walk.resolvedAt && new Date(walk.resolvedAt).getTime() > new Date(walk.expectedArrivalAt).getTime();
    if (inWindow(walk.startedAt)) {
      events.push({
        type: "safe_walk_started",
        time: walk.startedAt.toISOString(),
        source: "safe_walk",
        detail: `Safe Walk started${destination}. Expected arrival: ${walk.expectedArrivalAt.toISOString()}. ${formatLocationAvailability(walk.lastLocationAt)}.`,
      });
      events.push({
        type: "safe_walk_extension_history_unavailable",
        time: walk.startedAt.toISOString(),
        source: "safe_walk",
        detail: "Safe Walk extension history was not recorded separately in this version.",
      });
    }
    if ((walk.status === "overdue" || walk.status === "escalated" || resolvedLate || correlatedIncident) && inWindow(walk.expectedArrivalAt)) {
      events.push({
        type: "safe_walk_overdue",
        time: walk.expectedArrivalAt.toISOString(),
        source: "safe_walk",
        detail: `Safe Walk became overdue${destination}. ${formatLocationAvailability(walk.lastLocationAt)}.`,
      });
    }
    if (walk.status === "arrived" && inWindow(walk.resolvedAt)) {
      events.push({
        type: "safe_walk_arrived",
        time: walk.resolvedAt!.toISOString(),
        source: "safe_walk",
        detail: `Safe Walk marked arrived safely${destination}. ${formatLocationAvailability(walk.lastLocationAt)}.`,
      });
    }
    if (walk.status === "cancelled" && inWindow(walk.resolvedAt)) {
      events.push({
        type: "safe_walk_cancelled",
        time: walk.resolvedAt!.toISOString(),
        source: "safe_walk",
        detail: `Safe Walk cancelled${destination}. ${formatLocationAvailability(walk.lastLocationAt)}.`,
      });
    }
    if (walk.status === "escalated" && inWindow(walk.resolvedAt)) {
      events.push({
        type: "safe_walk_escalated",
        time: walk.resolvedAt!.toISOString(),
        source: "safe_walk",
        detail: `Safe Walk escalated${destination}; emergency contacts were alerted. ${formatLocationAvailability(walk.lastLocationAt)}.`,
      });
    } else if (correlatedIncident && inWindow(correlatedIncident.startedAt)) {
      events.push({
        type: "safe_walk_escalated",
        time: correlatedIncident.startedAt.toISOString(),
        source: "safe_walk",
        detail: `Safe Walk escalated${destination}; emergency contacts were alerted. ${formatLocationAvailability(walk.lastLocationAt)}.`,
      });
    }
  }

  for (const incident of incidentRows) {
    const inferred = inferIncidentReportReason(incident);
    const source = inferred === "safety_timer" ? "safety_timer" : inferred === "safe_walk" ? "safe_walk" : inferred === "missed_checkin" ? "missed_checkin" : "sos";
    for (const entry of parseEscalationTimeline(incident.escalationTimeline)) {
      const entryTime = new Date(entry.time);
      if (!inWindow(entryTime)) continue;
      events.push({
        type: entry.type,
        time: entryTime.toISOString(),
        source,
        detail: entry.detail,
      });
    }
  }

  for (const row of deliveryRows) {
    if (!inWindow(row.createdAt)) continue;
    if (row.purpose === "drive_crash") continue;
    const detail = describeDelivery(row);
    if (!detail) continue;
    events.push({
      type: `delivery_${row.channel}_${row.status}`,
      time: row.createdAt.toISOString(),
      source: row.purpose === "wellness_call" ? "contact" : "delivery",
      detail,
    });
  }

  const seen = new Set<string>();
  return events
    .filter((event) => {
      const key = `${event.type}:${event.time}:${event.detail}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, 120);
}
