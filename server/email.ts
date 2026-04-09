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
  const issos = reason === "sos";
  const subject = issos
    ? `Urgent: ${userName} has activated an emergency SOS - StillHere`
    : `Safety Alert: ${userName} has not checked in - StillHere`;

  const body = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: ${issos ? "#dc2626" : "#f59e0b"}; color: white; padding: 16px 24px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 20px;">${issos ? "Emergency SOS Alert" : "Missed Checkin Alert"}</h1>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px; color: #111; margin-top: 0;">
          ${issos
            ? `<strong>${userName}</strong> has activated an emergency SOS on StillHere. This is an urgent request for help.`
            : `<strong>${userName}</strong> has not completed their scheduled safety checkin on StillHere.`}
        </p>
        <p style="font-size: 16px; color: #111;">Please respond as soon as possible:</p>
        <a href="${link}" style="display: inline-block; background: ${issos ? "#dc2626" : "#2563eb"}; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 16px;">View Status &amp; Respond</a>
        <p style="font-size: 14px; color: #666; margin-top: 24px;">If you cannot reach ${userName}, please contact your local emergency services immediately.</p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="font-size: 12px; color: #999;">You are receiving this email because you are registered as an emergency contact for ${userName} on StillHere. If you believe this was sent in error, please contact the person who added you.</p>
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
  const speedInfo = speedKmh ? ` while travelling at approximately ${Math.round(speedKmh)} km/h` : "";
  const subject = `Urgent: Possible vehicle crash detected for ${userName} - StillHere`;

  const body = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: #dc2626; color: white; padding: 16px 24px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 20px;">Vehicle Crash Alert</h1>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px; color: #111; margin-top: 0;">A possible vehicle crash has been detected for <strong>${userName}</strong>${speedInfo}.</p>
        <p style="font-size: 16px; color: #111;">Please respond immediately:</p>
        <a href="${link}" style="display: inline-block; background: #dc2626; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 16px;">View Status &amp; Respond</a>
        <p style="font-size: 14px; color: #666; margin-top: 24px;">If you cannot reach ${userName}, please contact your local emergency services immediately.</p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="font-size: 12px; color: #999;">You are receiving this email because you are registered as an emergency contact for ${userName} on StillHere.</p>
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
  const subject = `Location Update: ${userName} has left their "${zoneName}" zone - StillHere`;

  const body = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: #f59e0b; color: white; padding: 16px 24px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 20px;">Location Zone Alert</h1>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px; color: #111; margin-top: 0;"><strong>${userName}</strong> has left their designated "${zoneName}" zone.</p>
        <p style="font-size: 16px; color: #111;">This may not indicate an emergency. You are being notified as a precaution because ${userName} has set up location monitoring for this zone.</p>
        <p style="font-size: 14px; color: #666; margin-top: 24px;">If you are concerned, try reaching out to ${userName} directly.</p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="font-size: 12px; color: #999;">You are receiving this email because you are registered as an emergency contact for ${userName} on StillHere.</p>
      </div>
    </div>
  `;
  return sendEmail(contactEmail, subject, body);
}
