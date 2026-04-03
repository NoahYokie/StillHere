const SENDER_NAME = "StillHere";
const SENDER_EMAIL = process.env.EMAIL_FROM || "alerts@stillhere.health";

export interface SendEmailResult {
  success: boolean;
  error?: string;
}

export async function sendEmail(to: string, subject: string, body: string): Promise<SendEmailResult> {
  const masked = to.replace(/(.{2}).*(@.*)/, "$1***$2");
  console.log(`[EMAIL] Would send to ${masked}: ${subject} (${body.length} chars)`);
  return { success: true };
}

export async function sendEmergencyEmail(
  contactEmail: string,
  userName: string,
  link: string,
  reason: "sos" | "missed_checkin"
): Promise<SendEmailResult> {
  const reasonText = reason === "sos" ? "has requested help" : "hasn't checked in";
  const subject = `StillHere Alert: ${userName} ${reasonText}`;
  const body = `StillHere Alert\n\n${userName} ${reasonText}.\n\nView status and respond:\n${link}\n\nYou are receiving this because you are listed as an emergency contact.`;
  return sendEmail(contactEmail, subject, body);
}

export async function sendGeofenceEmail(
  contactEmail: string,
  userName: string,
  zoneName: string
): Promise<SendEmailResult> {
  const subject = `StillHere: ${userName} left their ${zoneName} zone`;
  const body = `StillHere Location Alert\n\n${userName} has left their "${zoneName}" zone.\n\nThis may not be an emergency, but you are being notified as their emergency contact.`;
  return sendEmail(contactEmail, subject, body);
}
