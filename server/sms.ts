import twilio from "twilio";

let client: twilio.Twilio | null = null;
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

export async function sendSms(
  to: string,
  body: string
): Promise<SendSmsResult> {
  const c = getClient();
  if (!c) {
    console.warn("[SMS] Twilio not configured, skipping SMS");
    return { success: false, error: "Twilio not configured" };
  }

  const masked = `***${to.slice(-4)}`;
  console.log(`[SMS] Sending to ${masked}`);

  if (messagingServiceSid) {
    try {
      const message = await c.messages.create({ to, body, messagingServiceSid });
      console.log(`[SMS] Sent to ${masked} via messaging service: ${message.sid}`);
      return { success: true, messageId: message.sid };
    } catch (error: any) {
      console.warn(`[SMS] Messaging service failed for ${masked}: ${error.message}, trying fallback`);
      const fallbackFrom = fromPhone || alphaSender;
      if (fallbackFrom) {
        try {
          const message = await c.messages.create({ to, body, from: fallbackFrom });
          console.log(`[SMS] Sent to ${masked} via fallback: ${message.sid}`);
          return { success: true, messageId: message.sid };
        } catch (fallbackError: any) {
          console.error(`[SMS] Fallback also failed for ${masked}:`, fallbackError.message);
          return { success: false, error: fallbackError.message };
        }
      }
      return { success: false, error: error.message };
    }
  }

  const from = alphaSender || fromPhone;
  if (!from) {
    console.warn("[SMS] No sender configured");
    return { success: false, error: "No sender configured" };
  }

  try {
    const message = await c.messages.create({ to, body, from });
    console.log(`[SMS] Sent to ${masked}: ${message.sid}`);
    return { success: true, messageId: message.sid };
  } catch (error: any) {
    if (alphaSender && fromPhone && from === alphaSender) {
      console.warn(`[SMS] Alpha sender failed for ${masked}, retrying with phone number`);
      try {
        const message = await c.messages.create({ to, body, from: fromPhone });
        console.log(`[SMS] Sent to ${masked} via phone number: ${message.sid}`);
        return { success: true, messageId: message.sid };
      } catch (retryError: any) {
        console.error(`[SMS] Retry also failed for ${masked}:`, retryError.message);
        return { success: false, error: retryError.message };
      }
    }
    console.error(`[SMS] Failed to send to ${masked}:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function sendOtpSms(phone: string, code: string): Promise<SendSmsResult> {
  const body = `Your StillHere verification code is: ${code}\n\nThis code expires in 10 minutes. If you did not request this, please ignore this message.`;
  return sendSms(phone, body);
}

export async function sendMissedCheckinAlert(
  contactPhone: string,
  userName: string,
  link: string
): Promise<SendSmsResult> {
  const body = `STILLHERE SAFETY ALERT\n\n${userName} has not completed their scheduled safety checkin.\n\nPlease check on them and view their status:\n${link}\n\nIf you believe this is an emergency, please contact local emergency services.\n\nYou are receiving this message because you are registered as an emergency contact on StillHere.`;
  return sendSms(contactPhone, body);
}

export async function sendSosAlert(
  contactPhone: string,
  userName: string,
  link: string
): Promise<SendSmsResult> {
  const body = `STILLHERE EMERGENCY ALERT\n\n${userName} has activated an emergency SOS.\n\nThis is an urgent request for help. Please respond immediately:\n${link}\n\nIf you cannot reach them, please contact local emergency services.\n\nYou are receiving this message because you are registered as an emergency contact on StillHere.`;
  return sendSms(contactPhone, body);
}

export async function sendTestMessage(
  contactPhone: string,
  userName: string
): Promise<SendSmsResult> {
  const body = `StillHere Test Message\n\n${userName} has added you as an emergency contact on StillHere, a personal safety app.\n\nThis is a test message only. No action is needed.\n\nIn a real emergency, you would receive an alert with a link to view their status and location.`;
  return sendSms(contactPhone, body);
}

export async function sendReminderSms(
  userPhone: string,
  link: string,
  smsCheckinEnabled: boolean = false
): Promise<SendSmsResult> {
  let body = `StillHere Reminder\n\nYou have not completed your safety checkin yet.`;
  if (smsCheckinEnabled) {
    body += `\n\nReply YES to confirm you are safe, or tap the link below:\n${link}`;
  } else {
    body += `\n\nPlease open the app or tap the link below to check in:\n${link}`;
  }
  return sendSms(userPhone, body);
}

export async function sendAllClearNotification(
  contactPhone: string,
  userName: string,
  link: string
): Promise<SendSmsResult> {
  const body = `StillHere Update\n\n${userName} has confirmed they are safe. The previous alert has been resolved.\n\nNo further action is needed. You can view their current status:\n${link}`;
  return sendSms(contactPhone, body);
}

export async function sendContactRespondedNotification(
  userPhone: string,
  contactName: string
): Promise<SendSmsResult> {
  const body = `StillHere Update\n\n${contactName} has received your alert and is checking on you. Help is on the way.`;
  return sendSms(userPhone, body);
}

export async function sendEscalationAlert(
  contactPhone: string,
  userName: string,
  link: string,
  reason: "sos" | "missed_checkin"
): Promise<SendSmsResult> {
  const reasonText = reason === "sos"
    ? "activated an emergency SOS"
    : "not completed their safety checkin";
  const body = `STILLHERE ESCALATED ALERT\n\n${userName} has ${reasonText} and their primary emergency contact has not responded.\n\nYou are being contacted as a backup. Please respond urgently:\n${link}\n\nIf you cannot reach them, please contact local emergency services.\n\nYou are receiving this message because you are registered as an emergency contact on StillHere.`;
  return sendSms(contactPhone, body);
}

export async function sendNoResponseNotification(
  userPhone: string
): Promise<SendSmsResult> {
  const body = `StillHere Update\n\nWe are still attempting to reach your emergency contacts. No one has responded yet.\n\nIf you are in immediate danger, please call your local emergency number (e.g. 000, 911, 999, 112).`;
  return sendSms(userPhone, body);
}

export async function sendHandlingTimeoutAlert(
  contactPhone: string,
  userName: string,
  link: string
): Promise<SendSmsResult> {
  const body = `StillHere Follow-Up\n\n${userName}'s safety alert is still active and requires attention.\n\nPlease confirm you have been able to reach them:\n${link}\n\nIf you cannot reach them, please contact local emergency services.`;
  return sendSms(contactPhone, body);
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
