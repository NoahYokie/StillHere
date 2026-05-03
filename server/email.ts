import { Resend } from "resend";

const SENDER_NAME = "StillHere";
const SENDER_EMAIL = process.env.EMAIL_FROM || "alerts@stillhere.health";

// Public-facing brand URL used for the logo asset and the unauthenticated
// "view live status" page. Override via BRAND_BASE_URL if the app is hosted
// elsewhere. Must be HTTPS — Gmail blocks HTTP images by default.
const BRAND_BASE_URL = process.env.BRAND_BASE_URL || "https://stillhere.health";
const LOGO_URL = `${BRAND_BASE_URL}/favicon.png`;

// Lazy singleton: only construct the Resend client if a key is configured.
// Lets the app boot in dev/preview environments without RESEND_API_KEY set.
let resendClient: Resend | null | undefined;
function getResend(): Resend | null {
  if (resendClient !== undefined) return resendClient;
  const key = process.env.RESEND_API_KEY;
  resendClient = key ? new Resend(key) : null;
  return resendClient;
}

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
// to neutralize header injection (CR/LF would let an attacker add Bcc: etc.).
function safeSubject(s: string): string {
  return s.replace(/[\r\n\t\0]+/g, " ").slice(0, 200);
}

function fmtTimestamp(d: Date = new Date()): string {
  // "Sun, May 3 · 2:05 PM UTC" — explicit timezone keeps it unambiguous since
  // we don't know the recipient's locale.
  const datePart = d.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    timeZone: "UTC",
  });
  const timePart = d.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true,
    timeZone: "UTC",
  });
  return `${datePart} · ${timePart} UTC`;
}

type AlertLevel = "emergency" | "warning" | "info";

const LEVEL_STYLE: Record<AlertLevel, {
  emoji: string;
  label: string;
  badgeBg: string;
  badgeText: string;
  accent: string;
  ctaBg: string;
}> = {
  emergency: { emoji: "🚨", label: "URGENT",        badgeBg: "#fee2e2", badgeText: "#991b1b", accent: "#dc2626", ctaBg: "#dc2626" },
  warning:   { emoji: "⚠️", label: "SAFETY ALERT",  badgeBg: "#fef3c7", badgeText: "#92400e", accent: "#f59e0b", ctaBg: "#f59e0b" },
  info:      { emoji: "📍", label: "LOCATION UPDATE", badgeBg: "#dbeafe", badgeText: "#1e40af", accent: "#2563eb", ctaBg: "#2563eb" },
};

interface RenderArgs {
  level: AlertLevel;
  title: string;            // e.g. "Vehicle crash detected"
  userName: string;         // person whose safety triggered the alert
  eventLine: string;        // pre-escaped HTML, the "what happened" sentence(s)
  ctaUrl: string;
  ctaLabel: string;
  whyReceiving: string;     // pre-escaped HTML, "you are receiving this because…"
  emergencyHint?: boolean;  // include "if unable to reach, call local emergency services"
}

function renderEmail({ level, title, userName, eventLine, ctaUrl, ctaLabel, whyReceiving, emergencyHint }: RenderArgs): string {
  const style = LEVEL_STYLE[level];
  const safeName = esc(userName);
  const safeUrl = esc(ctaUrl);
  const safeCta = esc(ctaLabel);
  const ts = esc(fmtTimestamp());

  // Mobile-first, table-based for Outlook/Gmail compatibility. Inline styles
  // only — most email clients strip <style> blocks. Max width 560px, generous
  // line-height, 16px+ body font, 48px touch-target button.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(title)} - StillHere</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#f3f4f6;line-height:1px;">
    ${esc(eventLine.replace(/<[^>]+>/g, ""))} — open to view live status.
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(15,23,42,0.06);overflow:hidden;">
        <!-- Header: logo + brand wordmark + level badge -->
        <tr><td style="padding:16px 24px;border-bottom:1px solid #f1f5f9;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td align="left" style="vertical-align:middle;">
                <img src="${esc(LOGO_URL)}" width="28" height="28" alt="StillHere" style="display:inline-block;vertical-align:middle;border-radius:6px;">
                <span style="display:inline-block;vertical-align:middle;margin-left:10px;font-size:15px;font-weight:700;color:#0f172a;letter-spacing:-0.01em;">StillHere</span>
              </td>
              <td align="right" style="vertical-align:middle;">
                <span style="display:inline-block;background:${style.badgeBg};color:${style.badgeText};font-size:11px;font-weight:700;letter-spacing:0.06em;padding:5px 10px;border-radius:9999px;text-transform:uppercase;">${style.emoji} ${style.label}</span>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Accent bar in level color -->
        <tr><td style="height:3px;background:${style.accent};line-height:3px;font-size:0;">&nbsp;</td></tr>

        <!-- Main content -->
        <tr><td style="padding:28px 24px 8px 24px;">
          <h1 style="margin:0 0 6px 0;font-size:22px;line-height:1.25;color:#0f172a;font-weight:700;letter-spacing:-0.01em;">${esc(title)}</h1>
          <p style="margin:0 0 18px 0;font-size:13px;color:#64748b;line-height:1.4;">${ts}</p>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px 18px;margin:0 0 22px 0;">
            <p style="margin:0 0 4px 0;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Subject</p>
            <p style="margin:0;font-size:18px;color:#0f172a;font-weight:700;line-height:1.3;">${safeName}</p>
          </div>
          <p style="margin:0 0 24px 0;font-size:16px;line-height:1.55;color:#1e293b;">${eventLine}</p>
        </td></tr>

        <!-- CTA button -->
        <tr><td style="padding:0 24px 28px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td align="center">
              <a href="${safeUrl}" style="display:block;background:${style.ctaBg};color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:14px 24px;border-radius:10px;line-height:1.2;text-align:center;min-height:20px;">${safeCta} →</a>
            </td></tr>
          </table>
          ${emergencyHint ? `<p style="margin:14px 0 0 0;font-size:13px;line-height:1.5;color:#475569;text-align:center;">If you cannot reach <strong>${safeName}</strong>, please contact your local emergency services immediately.</p>` : ""}
        </td></tr>

        <!-- Compliance / trust footer -->
        <tr><td style="padding:18px 24px 22px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;">
          <p style="margin:0 0 8px 0;font-size:12px;line-height:1.55;color:#475569;">
            <strong style="color:#334155;">Why am I receiving this?</strong> ${whyReceiving}
          </p>
          <p style="margin:0;font-size:11px;line-height:1.55;color:#94a3b8;">
            StillHere only sends emails when a real safety event is detected. We never share your contact details with third parties. Reply STOP to be removed as an emergency contact, or ask <strong>${safeName}</strong> to remove you in their app.
          </p>
        </td></tr>

        <!-- Brand footer -->
        <tr><td align="center" style="padding:16px 24px 20px 24px;">
          <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.4;">
            <a href="${esc(BRAND_BASE_URL)}" style="color:#94a3b8;text-decoration:none;">stillhere.health</a> · Personal safety check-ins
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendEmail(to: string, subject: string, body: string): Promise<SendEmailResult> {
  const masked = to.replace(/(.{2}).*(@.*)/, "$1***$2");
  const client = getResend();
  if (!client) {
    console.log(`[EMAIL] (dry-run, RESEND_API_KEY not set) to=${masked} subject="${subject}" (${body.length} chars)`);
    return { success: true };
  }
  try {
    const { data, error } = await client.emails.send({
      from: `${SENDER_NAME} <${SENDER_EMAIL}>`,
      to: [to],
      subject,
      html: body,
    });
    if (error) {
      console.error(`[EMAIL] send failed to=${masked}:`, error.message || error);
      return { success: false, error: error.message || String(error) };
    }
    console.log(`[EMAIL] sent to=${masked} id=${data?.id} subject="${subject}"`);
    return { success: true };
  } catch (err: any) {
    console.error(`[EMAIL] send threw to=${masked}:`, err?.message || err);
    return { success: false, error: err?.message || String(err) };
  }
}

export async function sendEmergencyEmail(
  contactEmail: string,
  userName: string,
  link: string,
  reason: "sos" | "missed_checkin"
): Promise<SendEmailResult> {
  const issos = reason === "sos";
  const safeName = esc(userName);
  const level: AlertLevel = issos ? "emergency" : "warning";
  const subject = safeSubject(issos
    ? `🚨 URGENT: ${userName} needs help — StillHere`
    : `⚠️ Safety Alert: ${userName} missed a check-in — StillHere`);

  const title = issos ? "Emergency SOS activated" : "Missed safety check-in";
  const eventLine = issos
    ? `<strong>${safeName}</strong> just activated an emergency SOS on StillHere. This is an urgent request for help. Push, SMS, and a phone call have already been attempted.`
    : `<strong>${safeName}</strong> hasn't responded to a scheduled safety check-in. We've already tried reaching them by app push, SMS, and phone call.`;
  const ctaLabel = issos ? "View Live Location" : "View Live Status";
  const whyReceiving = `You are listed as an emergency contact for <strong>${safeName}</strong> on StillHere. They asked us to notify you the moment a safety event is detected.`;

  const body = renderEmail({
    level, title, userName, eventLine,
    ctaUrl: link, ctaLabel,
    whyReceiving,
    emergencyHint: true,
  });
  return sendEmail(contactEmail, subject, body);
}

export async function sendCrashEmail(
  contactEmail: string,
  userName: string,
  link: string,
  speedKmh?: number
): Promise<SendEmailResult> {
  const safeName = esc(userName);
  const speedInfo = speedKmh ? ` while travelling at approximately <strong>${Math.round(speedKmh)} km/h</strong>` : "";
  const subject = safeSubject(`🚨 URGENT: Possible crash detected for ${userName} — StillHere`);

  const eventLine = `A possible vehicle crash has been detected for <strong>${safeName}</strong>${speedInfo}. Their phone reported a sudden impact and stopped moving. Please respond as soon as possible.`;
  const whyReceiving = `You are listed as an emergency contact for <strong>${safeName}</strong> on StillHere. We notify you immediately when crash-detection is triggered.`;

  const body = renderEmail({
    level: "emergency",
    title: "Possible vehicle crash detected",
    userName,
    eventLine,
    ctaUrl: link,
    ctaLabel: "View Live Location",
    whyReceiving,
    emergencyHint: true,
  });
  return sendEmail(contactEmail, subject, body);
}

export async function sendGeofenceEmail(
  contactEmail: string,
  userName: string,
  zoneName: string
): Promise<SendEmailResult> {
  const safeName = esc(userName);
  const safeZone = esc(zoneName);
  const subject = safeSubject(`📍 Location Update: ${userName} left "${zoneName}" — StillHere`);

  const eventLine = `<strong>${safeName}</strong> has left their designated <strong>"${safeZone}"</strong> zone. This may not indicate an emergency — you're being notified because ${safeName} set up location monitoring for this zone.`;
  const whyReceiving = `${safeName} added you as a trusted contact and enabled location-zone notifications for <strong>"${safeZone}"</strong>. Only zone exits are shared, never live coordinates.`;

  const body = renderEmail({
    level: "info",
    title: `Left "${zoneName}" zone`,
    userName,
    eventLine,
    ctaUrl: `${BRAND_BASE_URL}/family`,
    ctaLabel: "View Live Location",
    whyReceiving,
    emergencyHint: false,
  });
  return sendEmail(contactEmail, subject, body);
}
