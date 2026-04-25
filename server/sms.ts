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
      if (fromPhone) {
        try {
          const message = await c.messages.create({ to, body, from: fromPhone });
          console.log(`[SMS] Sent to ${masked} via phone fallback: ${message.sid}`);
          return { success: true, messageId: message.sid };
        } catch (fallbackError: any) {
          console.error(`[SMS] Phone fallback also failed for ${masked}:`, fallbackError.message);
          return { success: false, error: fallbackError.message };
        }
      }
      return { success: false, error: error.message };
    }
  }

  if (alphaSender) {
    try {
      const message = await c.messages.create({ to, body, from: alphaSender });
      console.log(`[SMS] Sent to ${masked} via alpha sender "${alphaSender}": ${message.sid}`);
      return { success: true, messageId: message.sid };
    } catch (error: any) {
      console.warn(`[SMS] Alpha sender "${alphaSender}" failed for ${masked}: ${error.message}, trying phone fallback`);
      if (fromPhone) {
        try {
          const message = await c.messages.create({ to, body, from: fromPhone });
          console.log(`[SMS] Sent to ${masked} via phone fallback: ${message.sid}`);
          return { success: true, messageId: message.sid };
        } catch (fallbackError: any) {
          console.error(`[SMS] Phone fallback also failed for ${masked}:`, fallbackError.message);
          return { success: false, error: fallbackError.message };
        }
      }
      return { success: false, error: error.message };
    }
  }

  if (fromPhone) {
    try {
      const message = await c.messages.create({ to, body, from: fromPhone });
      console.log(`[SMS] Sent to ${masked} via phone number: ${message.sid}`);
      return { success: true, messageId: message.sid };
    } catch (error: any) {
      console.error(`[SMS] Failed to send to ${masked}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  console.warn("[SMS] No sender configured");
  return { success: false, error: "No sender configured" };
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
  const body = `StillHere Safety Alert\n\n${userName} has not responded to a safety check-in. We tried reaching them by app notification, SMS, and a phone call — none received a response.\n\nPlease try to reach ${userName} directly. If you have the StillHere app, open it for live status, location, and one-tap actions. If not, you can view status and respond from any browser:\n${link}\n\nIf you are unable to reach them, please contact your local emergency services.`;
  return sendSms(contactPhone, body);
}

export async function sendSosAlert(
  contactPhone: string,
  userName: string,
  link: string
): Promise<SendSmsResult> {
  const body = `StillHere EMERGENCY\n\n${userName} has activated an emergency SOS and is requesting help right now.\n\nPlease try to reach them immediately. If you have the StillHere app, open it for live location and one-tap actions. If not, view status and respond from any browser:\n${link}\n\nIf you cannot reach them, please contact your local emergency services.\n\nYou are receiving this because you are listed as an emergency contact for ${userName} on StillHere.`;
  return sendSms(contactPhone, body);
}

export async function sendTestMessage(
  contactPhone: string,
  userName: string
): Promise<SendSmsResult> {
  const body = `StillHere — Test Message\n\n${userName} has added you as an emergency contact on StillHere, a personal safety app.\n\nThis is only a test. No action is needed.\n\nIn a real alert, you will receive a message with a secure link to view their status and location. For the fullest experience — live location, push alerts, and one-tap response — install the StillHere app.`;
  return sendSms(contactPhone, body);
}

export async function sendReminderSms(
  userPhone: string,
  link: string,
  smsCheckinEnabled: boolean = false
): Promise<SendSmsResult> {
  let body = `StillHere — Check-in Reminder\n\nYou haven't completed your safety check-in yet.`;
  if (smsCheckinEnabled) {
    body += `\n\nReply YES to confirm you are safe, or open the app. If you don't have the app handy, you can also check in from this link:\n${link}`;
  } else {
    body += `\n\nPlease open the app to check in. If you don't have the app handy, you can also check in from this link:\n${link}`;
  }
  return sendSms(userPhone, body);
}

export async function sendAllClearNotification(
  contactPhone: string,
  userName: string,
  link: string
): Promise<SendSmsResult> {
  const timeLabel = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  const body = `StillHere — All Clear\n\n${userName} confirmed they are safe at ${timeLabel}. No action is needed.\n\nView their status in the StillHere app, or from any browser:\n${link}`;
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
    : "has not responded to a safety check-in";
  const body = `StillHere Safety Alert\n\n${userName} ${reasonText}, and their primary emergency contact has not responded yet.\n\nPlease try to reach ${userName} as soon as possible. If you have the StillHere app, open it for live status and one-tap actions. If not, you can view status and respond from any browser:\n${link}\n\nIf you cannot reach them, please contact your local emergency services.`;
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
  const body = `StillHere — Follow-Up\n\n${userName}'s safety alert is still active and needs your attention.\n\nPlease confirm whether you have been able to reach them. Open the StillHere app for one-tap response, or use this link from any browser:\n${link}\n\nIf you cannot reach them, please contact your local emergency services.`;
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
