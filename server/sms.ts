import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromPhone = process.env.TWILIO_PHONE_NUMBER;

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
  
  try {
    const message = await client.messages.create({
      body,
      from: fromPhone,
      to,
    });
    
    console.log(`[SMS] Sent to ${to}, SID: ${message.sid}`);
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
  const body = `StillHere alert:\n${userName} hasn't checked in yet.\nTap here to see their status and check on them:\n${link}`;
  return sendSms(contactPhone, body);
}

export async function sendSosAlert(
  contactPhone: string,
  userName: string,
  link: string
): Promise<SendSmsResult> {
  const body = `StillHere alert:\n${userName} has asked for help.\nPlease check on them now:\n${link}`;
  return sendSms(contactPhone, body);
}

export async function sendTestMessage(
  contactPhone: string,
  userName: string
): Promise<SendSmsResult> {
  const body = `StillHere test:\nThis is a test message from ${userName}.\nNo action is needed.`;
  return sendSms(contactPhone, body);
}

export function isTwilioConfigured(): boolean {
  return !!(accountSid && authToken && fromPhone);
}
