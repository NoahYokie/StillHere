const SENDER_NAME = "StillHere";
const SENDER_EMAIL = process.env.EMAIL_FROM || "alerts@stillhere.health";

export interface SendEmailResult {
  success: boolean;
  error?: string;
}

// Escape any user-controlled string before interpolating into an HTML email
// body or subject. Without this, a name/zone like `<script>...</script>` would
// land verbatim in the recipient's inbox (stored XSS in HTML email clients
// that render scripts/iframes, and unwanted markup in subject lines).
function esc(s: string | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Strip control chars + line breaks from anything used in a Subject: header
// to neutralize header injection (CR/LF would let an attacker add Bcc: etc.
// if a real SMTP transport is wired in later).
function safeSubject(s: string): string {
  return s.replace(/[\r\n\t\0]+/g, " ").slice(0, 200);
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
  const issos = reason === "sos";
  const safeName = esc(userName);
  const safeLink = esc(link);
  const subject = safeSubject(issos
    ? `Urgent: ${userName} has activated an emergency SOS - StillHere`
    : `Safety Alert: ${userName} has not checked in - StillHere`);

  const body = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: ${issos ? "#dc2626" : "#f59e0b"}; color: white; padding: 16px 24px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 20px;">${issos ? "Emergency SOS Alert" : "Missed Checkin Alert"}</h1>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px; color: #111; margin-top: 0;">
          ${issos
            ? `<strong>${safeName}</strong> has activated an emergency SOS on StillHere. This is an urgent request for help.`
            : `<strong>${safeName}</strong> has not responded to a scheduled safety check-in on StillHere. We have already tried reaching them by app notification, SMS, and phone call.`}
        </p>
        <p style="font-size: 16px; color: #111;">Please try to reach ${safeName} as soon as possible. For the fullest experience (live location, push alerts, and one-tap response), open the StillHere app. If you don't have it installed, you can also view status and respond from any browser using the secure link below:</p>
        <a href="${safeLink}" style="display: inline-block; background: ${issos ? "#dc2626" : "#2563eb"}; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 16px;">View Status &amp; Respond</a>
        <p style="font-size: 14px; color: #666; margin-top: 24px;">If you are unable to reach ${safeName}, please contact your local emergency services immediately.</p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="font-size: 12px; color: #999;">You are receiving this email because you are registered as an emergency contact for ${safeName} on StillHere. If you believe this was sent in error, please contact the person who added you.</p>
      </div>
    </div>
  `;
  return sendEmail(contactEmail, subject, body);
}

export async function sendCrashEmail(
  contactEmail: string,
  userName: string,
  link: string,
  speedKmh?: number
): Promise<SendEmailResult> {
  const safeName = esc(userName);
  const safeLink = esc(link);
  const speedInfo = speedKmh ? ` while travelling at approximately ${Math.round(speedKmh)} km/h` : "";
  const subject = safeSubject(`Urgent: Possible vehicle crash detected for ${userName} - StillHere`);

  const body = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: #dc2626; color: white; padding: 16px 24px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 20px;">Vehicle Crash Alert</h1>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px; color: #111; margin-top: 0;">A possible vehicle crash has been detected for <strong>${safeName}</strong>${speedInfo}.</p>
        <p style="font-size: 16px; color: #111;">Please respond immediately:</p>
        <a href="${safeLink}" style="display: inline-block; background: #dc2626; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 16px;">View Status &amp; Respond</a>
        <p style="font-size: 14px; color: #666; margin-top: 24px;">If you cannot reach ${safeName}, please contact your local emergency services immediately.</p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="font-size: 12px; color: #999;">You are receiving this email because you are registered as an emergency contact for ${safeName} on StillHere.</p>
      </div>
    </div>
  `;
  return sendEmail(contactEmail, subject, body);
}

export async function sendGeofenceEmail(
  contactEmail: string,
  userName: string,
  zoneName: string
): Promise<SendEmailResult> {
  const safeName = esc(userName);
  const safeZone = esc(zoneName);
  const subject = safeSubject(`Location Update: ${userName} has left their "${zoneName}" zone - StillHere`);

  const body = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: #f59e0b; color: white; padding: 16px 24px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 20px;">Location Zone Alert</h1>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px; color: #111; margin-top: 0;"><strong>${safeName}</strong> has left their designated "${safeZone}" zone.</p>
        <p style="font-size: 16px; color: #111;">This may not indicate an emergency. You are being notified as a precaution because ${safeName} has set up location monitoring for this zone.</p>
        <p style="font-size: 14px; color: #666; margin-top: 24px;">If you are concerned, try reaching out to ${safeName} directly.</p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="font-size: 12px; color: #999;">You are receiving this email because you are registered as an emergency contact for ${safeName} on StillHere.</p>
      </div>
    </div>
  `;
  return sendEmail(contactEmail, subject, body);
}
