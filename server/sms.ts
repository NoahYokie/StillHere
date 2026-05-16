import twilio from "twilio";
import type { Request, Response, NextFunction } from "express";

let client: twilio.Twilio | null = null;

export function escapeXml(unsafe: string | null | undefined): string {
  if (!unsafe) return "";
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

export function verifyTwilioSignature(req: Request, res: Response, next: NextFunction): void {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error("[TWILIO-WEBHOOK] TWILIO_AUTH_TOKEN not configured, rejecting webhook");
    res.status(403).type("text/xml").send("<Response></Response>");
    return;
  }

  const signature = req.headers["x-twilio-signature"] as string | undefined;
  if (!signature) {
    console.warn(`[TWILIO-WEBHOOK] Missing X-Twilio-Signature on ${req.path}`);
    res.status(403).type("text/xml").send("<Response></Response>");
    return;
  }

  const proto = req.protocol || (req.headers["x-forwarded-proto"] as string)?.split(",")[0].trim();
  const host = req.get("host") || (req.headers["x-forwarded-host"] as string)?.split(",")[0].trim();
  const url = `${proto}://${host}${req.originalUrl}`;
  const params = (req.body && typeof req.body === "object") ? req.body : {};

  const isValid = twilio.validateRequest(authToken, signature, url, params);
  if (!isValid) {
    console.warn(`[TWILIO-WEBHOOK] Invalid signature on ${req.path}`);
    res.status(403).type("text/xml").send("<Response></Response>");
    return;
  }

  next();
}

let alphaSender: string | null = null;
let fromPhone: string | null = null;
let messagingServiceSid: string | null = null;

function getClient(): twilio.Twilio | null {
  if (client) return client;

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  alphaSender = process.env.TWILIO_ALPHA_SENDER || null;
  fromPhone = process.env.TWILIO_PHONE_NUMBER || null;
  messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID || null;

  if (!sid || !token) {
    console.warn("[SMS] Twilio credentials not configured");
    return null;
  }

  client = twilio(sid, token);
  return client;
}

export interface SendSmsResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export function isSmsConfigured(): boolean {
  const c = getClient();
  return c !== null && !!(messagingServiceSid || alphaSender || fromPhone);
}

export const isTwilioConfigured = isSmsConfigured;

// Normalize a phone for review-account comparison. We can't import the
// auth module's normalizePhone (circular import), so we do a permissive
// strip of non-digits + leading "+" and compare suffixes.
function isReviewPhone(to: string): boolean {
  const reviewPhone = process.env.APPLE_REVIEW_PHONE;
  if (!reviewPhone) return false;
  const norm = (s: string) => s.replace(/[^\d+]/g, "").replace(/^\+/, "");
  return norm(to) === norm(reviewPhone);
}

export interface SendSmsOptions {
  // Why this SMS is going out. Drives policy + audit. Required for new code.
  // Legacy callers that don't pass it default to "system_alert".
  purpose?: import("./outbound-policy").OutboundPurpose;
  userId?: string | null;
  incidentId?: string | null;
  ipAddress?: string | null;
  // Caller-supplied dedupeKey for Category-B traffic. When set, two sends
  // with the same key within 5 minutes are collapsed.
  dedupeKey?: string | null;
}

export async function sendSms(
  to: string,
  body: string,
  options: SendSmsOptions = {},
): Promise<SendSmsResult> {
  const purpose = options.purpose || "system_alert";
  const policy = await import("./outbound-policy");
  const ctx: import("./outbound-policy").SendContext = {
    channel: "sms",
    purpose,
    destination: to,
    userId: options.userId ?? null,
    incidentId: options.incidentId ?? null,
    ipAddress: options.ipAddress ?? null,
    dedupeKey: options.dedupeKey ?? null,
  };

  const decision = await policy.enforceSendPolicy(ctx);
  // Phase 1.1: when policy reports a degraded channel for a safety-critical
  // send tied to an incident, flip incidents.degradedDelivery so the watcher
  // UI surfaces the partial delivery state.
  if (decision.degraded && options.incidentId) {
    try {
      const { storage } = await import("./storage");
      await storage.updateIncident(options.incidentId, { degradedDelivery: true });
    } catch (e: any) {
      console.warn(`[SMS] Failed to mark incident ${options.incidentId} degraded: ${e?.message || e}`);
    }
  }
  if (!decision.allowed) {
    const masked = `***${to.slice(-4)}`;
    console.warn(`[SMS] Blocked by policy (${decision.reason}) to ${masked} purpose=${purpose}`);
    return { success: false, error: `policy:${decision.reason}` };
  }
  const attemptId = decision.attemptId;

  const c = getClient();
  if (!c) {
    console.warn("[SMS] Twilio not configured, skipping SMS");
    await policy.markSendProviderResult(attemptId, "provider_unconfigured", { errorMessage: "Twilio not configured" });
    return { success: false, error: "Twilio not configured" };
  }

  const masked = `***${to.slice(-4)}`;

  // Store-review safety net: never dispatch a real SMS to the dedicated
  // review phone. Returns "success" so callers don't retry / fall back to
  // voice or escalation paths.
  if (isReviewPhone(to)) {
    console.log(`[SMS] Skipped (review account) to ${masked}`);
    await policy.markSendProviderResult(attemptId, "blocked_optout", { errorMessage: "review_account" });
    return { success: true, messageId: "review-skip" };
  }

  // In-app SMS opt-out check (in addition to Twilio's carrier-level STOP).
  // Lazy-imported to avoid circular dependency with storage. If the recipient
  // has previously replied STOP/CANCEL/etc, we short-circuit BEFORE hitting
  // Twilio so we don't pay for, log, or attempt a delivery the carrier will
  // reject. Caller should treat this as a soft-skip and fall back to push,
  // voice call, and email.
  try {
    const { storage } = await import("./storage");
    if (await storage.isPhoneSmsOptedOut(to)) {
      console.log(`[SMS] Skipped (opted out): ${masked}`);
      await policy.markSendProviderResult(attemptId, "blocked_optout", { errorMessage: "opted_out" });
      return { success: false, error: "Recipient opted out of SMS" };
    }
  } catch (err) {
    // Defensive: never block a send because the opt-out lookup itself failed.
    // If the DB is down we want emergency SMS to still go out.
    console.warn(`[SMS] opt-out check failed for ${masked}, sending anyway`);
  }

  console.log(`[SMS] Sending to ${masked}`);

  // Twilio status callback URL — Advanced Opt-Out Messaging Services accept
  // the message synchronously and only mark it failed (with ErrorCode=21610)
  // asynchronously. Pointing statusCallback at /api/sms/status lets us learn
  // about the carrier-level opt-out and back-sync our DB.
  const baseUrl = process.env.BASE_URL
    || (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS.split(",")[0].trim()}` : null);
  const statusCallback = baseUrl ? `${baseUrl}/api/sms/status` : undefined;

  // Twilio error code for "Attempt to send to unsubscribed recipient".
  // When the carrier-level STOP registry rejects a message, our app's DB
  // is unaware. Back-sync the opt-out flag so future attempts are gated
  // at our level (saving cost + surfacing the state in our UI/logs).
  const TWILIO_OPTED_OUT_CODE = 21610;
  const isOptedOutError = (err: any): boolean =>
    err && (err.code === TWILIO_OPTED_OUT_CODE || err.status === TWILIO_OPTED_OUT_CODE);
  const backsyncOptOut = async (err: any): Promise<void> => {
    if (!isOptedOutError(err)) return;
    try {
      const { storage } = await import("./storage");
      await storage.setSmsOptOutByPhone(to, true);
      console.log(`[SMS] Carrier reported opt-out for ${masked} (code 21610), back-synced to DB`);
    } catch (e: any) {
      console.warn(`[SMS] Failed to back-sync carrier opt-out for ${masked}: ${e?.message || e}`);
    }
  };

  // Wrap each provider attempt with audit-log finalization.
  const finalizeSuccess = async (sid: string) => {
    await policy.markSendProviderResult(attemptId, "sent", { providerId: sid });
  };
  const finalizeFailure = async (msg: string) => {
    await policy.markSendProviderResult(attemptId, "failed", { errorMessage: msg });
  };
  const finalizeOptOut = async () => {
    await policy.markSendProviderResult(attemptId, "blocked_optout", { errorMessage: "carrier_opted_out" });
  };

  if (messagingServiceSid) {
    try {
      const message = await c.messages.create({ to, body, messagingServiceSid, statusCallback });
      console.log(`[SMS] Sent to ${masked} via messaging service: ${message.sid}`);
      await finalizeSuccess(message.sid);
      return { success: true, messageId: message.sid };
    } catch (error: any) {
      await backsyncOptOut(error);
      if (isOptedOutError(error)) {
        await finalizeOptOut();
        return { success: false, error: "Recipient opted out of SMS" };
      }
      console.warn(`[SMS] Messaging service failed for ${masked}: ${error.message}, trying fallback`);
      if (fromPhone) {
        try {
          const message = await c.messages.create({ to, body, from: fromPhone, statusCallback });
          console.log(`[SMS] Sent to ${masked} via phone fallback: ${message.sid}`);
          await finalizeSuccess(message.sid);
          return { success: true, messageId: message.sid };
        } catch (fallbackError: any) {
          await backsyncOptOut(fallbackError);
          if (isOptedOutError(fallbackError)) {
            await finalizeOptOut();
            return { success: false, error: "Recipient opted out of SMS" };
          }
          console.error(`[SMS] Phone fallback also failed for ${masked}:`, fallbackError.message);
          await finalizeFailure(fallbackError.message);
          return { success: false, error: fallbackError.message };
        }
      }
      await finalizeFailure(error.message);
      return { success: false, error: error.message };
    }
  }

  if (alphaSender) {
    try {
      const message = await c.messages.create({ to, body, from: alphaSender, statusCallback });
      console.log(`[SMS] Sent to ${masked} via alpha sender "${alphaSender}": ${message.sid}`);
      await finalizeSuccess(message.sid);
      return { success: true, messageId: message.sid };
    } catch (error: any) {
      await backsyncOptOut(error);
      if (isOptedOutError(error)) {
        await finalizeOptOut();
        return { success: false, error: "Recipient opted out of SMS" };
      }
      console.warn(`[SMS] Alpha sender "${alphaSender}" failed for ${masked}: ${error.message}, trying phone fallback`);
      if (fromPhone) {
        try {
          const message = await c.messages.create({ to, body, from: fromPhone, statusCallback });
          console.log(`[SMS] Sent to ${masked} via phone fallback: ${message.sid}`);
          await finalizeSuccess(message.sid);
          return { success: true, messageId: message.sid };
        } catch (fallbackError: any) {
          await backsyncOptOut(fallbackError);
          if (isOptedOutError(fallbackError)) {
            await finalizeOptOut();
            return { success: false, error: "Recipient opted out of SMS" };
          }
          console.error(`[SMS] Phone fallback also failed for ${masked}:`, fallbackError.message);
          await finalizeFailure(fallbackError.message);
          return { success: false, error: fallbackError.message };
        }
      }
      await finalizeFailure(error.message);
      return { success: false, error: error.message };
    }
  }

  if (fromPhone) {
    try {
      const message = await c.messages.create({ to, body, from: fromPhone, statusCallback });
      console.log(`[SMS] Sent to ${masked} via phone number: ${message.sid}`);
      await finalizeSuccess(message.sid);
      return { success: true, messageId: message.sid };
    } catch (error: any) {
      await backsyncOptOut(error);
      if (isOptedOutError(error)) {
        await finalizeOptOut();
        return { success: false, error: "Recipient opted out of SMS" };
      }
      console.error(`[SMS] Failed to send to ${masked}:`, error.message);
      await finalizeFailure(error.message);
      return { success: false, error: error.message };
    }
  }

  console.warn("[SMS] No sender configured");
  await policy.markSendProviderResult(attemptId, "provider_unconfigured", { errorMessage: "no_sender" });
  return { success: false, error: "No sender configured" };
}

export async function sendOtpSms(
  phone: string,
  code: string,
  options: SendSmsOptions = {},
): Promise<SendSmsResult> {
  const body = `Your StillHere verification code is: ${code}\n\nThis code expires in 10 minutes. If you did not request this, please ignore this message.`;
  return sendSms(phone, body, { purpose: "otp", ...options });
}

export async function sendMissedCheckinAlert(
  contactPhone: string,
  userName: string,
  link: string,
  options: SendSmsOptions = {},
): Promise<SendSmsResult> {
  const body = `StillHere Safety Alert\n\n${userName} has not responded to a safety check-in. We tried reaching them by app notification, SMS, and a phone call. None received a response.\n\nPlease try to reach ${userName} directly. If you have the StillHere app, open it for live status, location, and one-tap actions. If not, you can view status and respond from any browser:\n${link}\n\nLink expires in 24 hours.\n\nIf you are unable to reach them, please contact your local emergency services.`;
  return sendSms(contactPhone, body, { purpose: "missed_checkin_alert", ...options });
}

export async function sendSosAlert(
  contactPhone: string,
  userName: string,
  link: string,
  options: SendSmsOptions = {},
): Promise<SendSmsResult> {
  const body = `StillHere SOS Alert\n\n${userName} has activated an SOS in the StillHere app and is requesting help right now.\n\nPlease try to reach them immediately. If you have the StillHere app, open it for live location and one-tap actions. If not, view status and respond from any browser:\n${link}\n\nLink expires in 24 hours.\n\nIf you cannot reach them, please contact your local emergency services. StillHere is not an emergency response service.\n\nYou are receiving this because you are listed as an emergency contact for ${userName} on StillHere.`;
  return sendSms(contactPhone, body, { purpose: "sos_alert", ...options });
}

export async function sendTestMessage(
  contactPhone: string,
  userName: string,
  options: SendSmsOptions = {},
): Promise<SendSmsResult> {
  const body = `StillHere Test Message\n\n${userName} has added you as an emergency contact on StillHere, a personal safety app.\n\nThis is only a test. No action is needed.\n\nIn a real alert, we will attempt to send a message with a secure link to view their status and location. For the fullest experience (live location, push alerts, and one-tap response), install the StillHere app.`;
  return sendSms(contactPhone, body, { purpose: "contact_test", ...options });
}

export async function sendSafetyCircleRequest(
  contactPhone: string,
  userName: string,
  link: string,
  options: SendSmsOptions = {},
): Promise<SendSmsResult> {
  const body = `StillHere Safety Circle Request\n\n${userName} added you as a Safety Circle contact. If they miss a check-in or request help, StillHere may send you alerts.\n\nYou can view their secure contact link here:\n${link}\n\nNo account is required for this link. To accept or decline the request and receive app alerts, sign in to StillHere with this phone number.\n\nLink expires in 24 hours.`;
  return sendSms(contactPhone, body, { purpose: "contact_test", ...options });
}

export async function sendReminderSms(
  userPhone: string,
  link: string,
  smsCheckinEnabled: boolean = false,
  options: SendSmsOptions = {},
): Promise<SendSmsResult> {
  let body = `StillHere Check-in Reminder\n\nYou haven't completed your safety check-in yet.`;
  if (smsCheckinEnabled) {
    body += `\n\nReply YES to confirm you are safe. Reply NO if you need help and want StillHere to alert your Safety Circle. You can also check in from this link:\n${link}`;
  } else {
    body += `\n\nPlease open the app to check in. If you don't have the app handy, you can also check in from this link:\n${link}`;
  }
  return sendSms(userPhone, body, { purpose: "reminder", ...options });
}

export async function sendAllClearNotification(
  contactPhone: string,
  userName: string,
  link: string,
  options: SendSmsOptions = {},
): Promise<SendSmsResult> {
  const timeLabel = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  const body = `StillHere All Clear\n\n${userName} confirmed they are safe at ${timeLabel}. No action is needed.\n\nView their status in the StillHere app, or from any browser:\n${link}`;
  return sendSms(contactPhone, body, { purpose: "all_clear", ...options });
}

export async function sendContactRespondedNotification(
  userPhone: string,
  contactName: string,
  options: SendSmsOptions = {},
): Promise<SendSmsResult> {
  const body = `StillHere Update\n\n${contactName} acknowledged your alert and may be checking on you.`;
  return sendSms(userPhone, body, { purpose: "contact_responded", ...options });
}

export async function sendEscalationAlert(
  contactPhone: string,
  userName: string,
  link: string,
  reason: "sos" | "missed_checkin",
  options: SendSmsOptions = {},
): Promise<SendSmsResult> {
  const reasonText = reason === "sos"
    ? "activated an emergency SOS"
    : "has not responded to a safety check-in";
  const body = `StillHere Safety Alert\n\n${userName} ${reasonText}, and their primary emergency contact has not responded yet.\n\nPlease try to reach ${userName} as soon as possible. If you have the StillHere app, open it for live status and one-tap actions. If not, you can view status and respond from any browser:\n${link}\n\nLink expires in 24 hours.\n\nIf you cannot reach them, please contact your local emergency services.`;
  return sendSms(contactPhone, body, { purpose: "escalation_alert", ...options });
}

export async function sendNoResponseNotification(
  userPhone: string,
  options: SendSmsOptions = {},
): Promise<SendSmsResult> {
  const body = `StillHere Update\n\nWe are still attempting to reach your emergency contacts. No one has responded yet.\n\nIf you are in immediate danger, please call your local emergency number (e.g. 000, 911, 999, 112).`;
  return sendSms(userPhone, body, { purpose: "no_response", ...options });
}

export async function sendHandlingTimeoutAlert(
  contactPhone: string,
  userName: string,
  link: string,
  options: SendSmsOptions = {},
): Promise<SendSmsResult> {
  const body = `StillHere Follow-Up\n\n${userName}'s safety alert is still active and needs your attention.\n\nPlease confirm whether you have been able to reach them. Open the StillHere app for one-tap response, or use this link from any browser:\n${link}\n\nLink expires in 24 hours.\n\nIf you cannot reach them, please contact your local emergency services.`;
  return sendSms(contactPhone, body, { purpose: "handling_timeout", ...options });
}

export async function getTurnCredentials(): Promise<RTCIceServer[]> {
  const client = getClient();
  if (!client) {
    return [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ];
  }
  try {
    const token = await client.tokens.create({ ttl: 3600 });
    return token.iceServers as RTCIceServer[];
  } catch (error) {
    console.error("[TURN] Failed to get TURN credentials:", error);
    return [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ];
  }
}
