import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromPhone = process.env.TWILIO_PHONE_NUMBER;

const ALPHA_SENDER_ID = "StillHere";

const ALPHA_SUPPORTED_PREFIXES = [
  "+61",  // Australia
  "+44",  // UK
  "+33",  // France
  "+49",  // Germany
  "+39",  // Italy
  "+34",  // Spain
  "+31",  // Netherlands
  "+32",  // Belgium
  "+43",  // Austria
  "+41",  // Switzerland
  "+353", // Ireland
  "+48",  // Poland
  "+46",  // Sweden
  "+47",  // Norway
  "+45",  // Denmark
  "+358", // Finland
  "+351", // Portugal
  "+30",  // Greece
];

function supportsAlphaSenderId(phone: string): boolean {
  return ALPHA_SUPPORTED_PREFIXES.some(prefix => phone.startsWith(prefix));
}

let twilioClient: twilio.Twilio | null = null;

function getClient(): twilio.Twilio | null {
  if (!accountSid || !authToken) {
    console.warn("[SMS] Twilio credentials not configured - messages will be logged only");
    return null;
  }
  
  if (!twilioClient) {
    twilioClient = twilio(accountSid, authToken);
  }
  
  return twilioClient;
}

export interface SendSmsResult {
  success: boolean;
  error?: string;
  messageId?: string;
}

export async function sendSms(to: string, body: string): Promise<SendSmsResult> {
  const client = getClient();
  
  if (!client || !fromPhone) {
    console.log("\n========================================");
    console.log("[SMS - NO TWILIO] Message would be sent:");
    console.log(`To: ${to}`);
    console.log(`From: ${fromPhone || "(not configured)"}`);
    console.log(`Body:\n${body}`);
    console.log("========================================\n");
    return { success: true, messageId: "console-only" };
  }
  
  // Use alphanumeric sender if configured via TWILIO_ALPHA_SENDER, otherwise use phone number
  // Alphanumeric sender requires Twilio Messaging Service setup and only works outside US/Canada
  // Note: Australia requires pre-registration for Alpha Sender IDs
  const alphaSender = process.env.TWILIO_ALPHA_SENDER;
  const useAlpha = alphaSender && supportsAlphaSenderId(to);
  
  try {
    // Try alpha sender first if configured
    if (useAlpha) {
      try {
        const message = await client.messages.create({
          body,
          from: alphaSender,
          to,
        });
        console.log(`[SMS] Sent to ${to} from "${alphaSender}", SID: ${message.sid}`);
        return { success: true, messageId: message.sid };
      } catch (alphaError: any) {
        console.log(`[SMS] Alpha sender failed, falling back to phone number: ${alphaError.message}`);
      }
    }
    
    // Fall back to phone number
    const message = await client.messages.create({
      body,
      from: fromPhone,
      to,
    });
    
    console.log(`[SMS] Sent to ${to} from "${fromPhone}", SID: ${message.sid}`);
    return { success: true, messageId: message.sid };
  } catch (error: any) {
    console.error(`[SMS] Failed to send to ${to}:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function sendOtpSms(phone: string, code: string): Promise<SendSmsResult> {
  const body = `Your StillHere code is: ${code}\nThis code expires in 10 minutes.`;
  return sendSms(phone, body);
}

export async function sendMissedCheckinAlert(
  contactPhone: string,
  userName: string,
  link: string
): Promise<SendSmsResult> {
  const body = `StillHere Alert\n\n${userName} hasn't checked in.\n\nView status and location:\n${link}\n\nYou are receiving this because you are an emergency contact.`;
  return sendSms(contactPhone, body);
}

export async function sendSosAlert(
  contactPhone: string,
  userName: string,
  link: string
): Promise<SendSmsResult> {
  const body = `StillHere Alert\n\n${userName} has requested help.\n\nView status and location:\n${link}\n\nYou are receiving this because you are an emergency contact.`;
  return sendSms(contactPhone, body);
}

export async function sendTestMessage(
  contactPhone: string,
  userName: string
): Promise<SendSmsResult> {
  const body = `StillHere test:\nThis is a test message from ${userName}.\nNo action is needed.`;
  return sendSms(contactPhone, body);
}

export async function sendReminderSms(
  userPhone: string,
  link: string
): Promise<SendSmsResult> {
  const body = `StillHere reminder:\nYou haven't checked in yet.\nTap below to let us know you're OK:\n${link}`;
  return sendSms(userPhone, body);
}

export async function sendAllClearNotification(
  contactPhone: string,
  userName: string,
  link: string
): Promise<SendSmsResult> {
  const body = `StillHere Update\n\n${userName} is OK now.\n\nNo action needed. You can view their status:\n${link}`;
  return sendSms(contactPhone, body);
}

export function isTwilioConfigured(): boolean {
  return !!(accountSid && authToken && fromPhone);
}
