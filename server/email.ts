import { Resend } from "resend";

const SENDER_NAME = "StillHere";
const SENDER_EMAIL = process.env.EMAIL_FROM || "alerts@stillhere.health";

// Public-facing brand URL used for the logo asset and unauthenticated links.
// Override via BRAND_BASE_URL if hosted elsewhere. Must be HTTPS.
const BRAND_BASE_URL = process.env.BRAND_BASE_URL || "https://stillhere.health";
// Use the 192x192 PWA icon — Gmail's image proxy renders it cleanly at 32px,
// the bare /favicon.png was too small and rendered as a blurry square.
const LOGO_URL = `${BRAND_BASE_URL}/icons/icon-192x192.png`;

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

// Per-email contextual data the renderer can use to show location/time.
export interface EmailContext {
  lat?: number | null;
  lng?: number | null;
  address?: string | null;          // optional reverse-geocoded address
  locationAt?: Date | null;         // when the location reading was taken
  timezone?: string | null;         // IANA tz of the subject user
}

// Escape any user-controlled string before interpolating into HTML/subject.
function esc(s: string | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Strip control chars from anything used in a Subject: header (defense-in-depth
// against header injection if a real SMTP transport is ever wired in).
function safeSubject(s: string): string {
  return s.replace(/[\r\n\t\0]+/g, " ").slice(0, 200);
}

// Render a date in the subject user's IANA timezone. Falls back to the
// recipient's offset (UTC) if no tz is known. Always includes the city
// abbreviation so it's unambiguous regardless of where the recipient lives.
function fmtLocalTime(d: Date, timezone?: string | null): string {
  const tz = timezone || "UTC";
  try {
    const date = d.toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric", timeZone: tz,
    });
    const time = d.toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", hour12: true,
      timeZone: tz, timeZoneName: "short",
    });
    return `${date}, ${time}`;
  } catch {
    return d.toUTCString();
  }
}

function fmtCoords(lat?: number | null, lng?: number | null): string | null {
  if (lat == null || lng == null) return null;
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

function mapsUrl(lat?: number | null, lng?: number | null): string | null {
  if (lat == null || lng == null) return null;
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

type AlertLevel = "emergency" | "warning" | "info";

const LEVEL: Record<AlertLevel, { label: string; accent: string; ctaBg: string; badgeBg: string; badgeText: string }> = {
  emergency: { label: "Emergency",   accent: "#dc2626", ctaBg: "#dc2626", badgeBg: "#fee2e2", badgeText: "#991b1b" },
  warning:   { label: "Safety alert", accent: "#f59e0b", ctaBg: "#f59e0b", badgeBg: "#fef3c7", badgeText: "#92400e" },
  info:      { label: "Update",       accent: "#2563eb", ctaBg: "#2563eb", badgeBg: "#dbeafe", badgeText: "#1e40af" },
};

interface RenderArgs {
  level: AlertLevel;
  title: string;
  userName: string;
  eventLine: string;        // pre-formatted, can include <strong>
  ctaUrl: string;
  ctaLabel: string;
  whyReceiving: string;     // pre-formatted
  emergencyHint?: boolean;
  context?: EmailContext;
}

function renderEmail({ level, title, userName, eventLine, ctaUrl, ctaLabel, whyReceiving, emergencyHint, context }: RenderArgs): string {
  const style = LEVEL[level];
  const safeName = esc(userName);
  const safeUrl = esc(ctaUrl);
  const safeCta = esc(ctaLabel);
  const tz = context?.timezone || null;
  const eventTime = esc(fmtLocalTime(new Date(), tz));
  const locTime = context?.locationAt ? esc(fmtLocalTime(context.locationAt, tz)) : null;

  const coords = fmtCoords(context?.lat, context?.lng);
  const gmaps = mapsUrl(context?.lat, context?.lng);
  const addressOrCoords = context?.address?.trim() || coords;

  const locationBlock = (addressOrCoords && gmaps) ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px 0;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;">
          <tr><td style="padding:14px 16px;">
            <p style="margin:0 0 4px 0;font-size:12px;color:#64748b;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;">Last known location</p>
            <p style="margin:0 0 2px 0;font-size:15px;color:#0f172a;line-height:1.4;">${esc(addressOrCoords)}</p>
            ${locTime ? `<p style="margin:0;font-size:12px;color:#64748b;">Reported ${locTime}</p>` : ""}
          </td></tr>
        </table>` : "";

  const fallbackLink = gmaps ? `
          <p style="margin:12px 0 0 0;font-size:14px;line-height:1.5;color:#475569;text-align:center;">
            Or <a href="${esc(gmaps)}" style="color:${style.accent};text-decoration:underline;font-weight:500;">open in Google Maps</a>
          </p>` : "";

  const emergencyHintHtml = emergencyHint ? `
          <p style="margin:14px 0 0 0;font-size:14px;line-height:1.5;color:#0f172a;text-align:center;">
            If you can't reach <strong>${safeName}</strong>, <strong>call emergency services immediately</strong>.
          </p>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;color:#0f172a;">
  <div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#f3f4f6;line-height:1px;">
    ${esc(eventLine.replace(/<[^>]+>/g, ""))}
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(15,23,42,0.06);overflow:hidden;">

        <tr><td style="padding:14px 22px;border-bottom:1px solid #f1f5f9;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td align="left" style="vertical-align:middle;">
                <img src="${esc(LOGO_URL)}" width="32" height="32" alt="StillHere" style="display:inline-block;vertical-align:middle;border-radius:7px;border:0;">
                <span style="display:inline-block;vertical-align:middle;margin-left:10px;font-size:16px;font-weight:700;color:#0f172a;letter-spacing:-0.01em;">StillHere</span>
              </td>
              <td align="right" style="vertical-align:middle;">
                <span style="display:inline-block;background:${style.badgeBg};color:${style.badgeText};font-size:11px;font-weight:600;letter-spacing:0.04em;padding:5px 10px;border-radius:9999px;">${style.label}</span>
              </td>
            </tr>
          </table>
        </td></tr>

        <tr><td style="height:3px;background:${style.accent};line-height:3px;font-size:0;">&nbsp;</td></tr>

        <tr><td style="padding:26px 24px 6px 24px;">
          <h1 style="margin:0 0 4px 0;font-size:22px;line-height:1.25;color:#0f172a;font-weight:700;letter-spacing:-0.01em;">${esc(title)}</h1>
          <p style="margin:0 0 18px 0;font-size:13px;color:#64748b;">${eventTime}</p>
          <p style="margin:0 0 8px 0;font-size:14px;color:#475569;">Person at risk: <strong style="color:#0f172a;">${safeName}</strong></p>
          <p style="margin:0 0 22px 0;font-size:16px;line-height:1.55;color:#1e293b;">${eventLine}</p>
          ${locationBlock}
        </td></tr>

        <tr><td style="padding:0 24px 26px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td align="center">
              <a href="${safeUrl}" style="display:block;background:${style.ctaBg};color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:14px 24px;border-radius:10px;line-height:1.2;text-align:center;">${safeCta}</a>
            </td></tr>
          </table>
          ${fallbackLink}
          ${emergencyHintHtml}
        </td></tr>

        <tr><td style="padding:18px 24px 22px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;">
          <p style="margin:0 0 6px 0;font-size:12px;line-height:1.55;color:#475569;">
            <strong style="color:#334155;">Why am I receiving this?</strong> ${whyReceiving}
          </p>
          <p style="margin:0;font-size:11px;line-height:1.55;color:#94a3b8;">
            StillHere only emails you when a real safety event is detected. Your details are never shared. Reply STOP to be removed, or ask <strong>${safeName}</strong> to remove you in their app.
          </p>
        </td></tr>

        <tr><td align="center" style="padding:14px 24px 18px 24px;">
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
  reason: "sos" | "missed_checkin",
  context?: EmailContext,
): Promise<SendEmailResult> {
  const issos = reason === "sos";
  const safeName = esc(userName);
  const level: AlertLevel = issos ? "emergency" : "warning";
  const subject = safeSubject(issos
    ? `Urgent: ${userName} needs help — StillHere`
    : `Safety alert: ${userName} missed a check-in — StillHere`);

  const title = issos ? "Emergency SOS activated" : "Missed safety check-in";
  const eventLine = issos
    ? `<strong>${safeName}</strong> just activated an emergency SOS. We've already tried reaching them by app push, SMS, and phone call.`
    : `<strong>${safeName}</strong> hasn't responded to a scheduled safety check-in. We've already tried reaching them by app push, SMS, and phone call.`;
  const ctaLabel = "View live status";
  const whyReceiving = `You're listed as an emergency contact for <strong>${safeName}</strong> on StillHere. They asked us to notify you the moment a safety event is detected.`;

  const body = renderEmail({
    level, title, userName, eventLine,
    ctaUrl: link, ctaLabel,
    whyReceiving,
    emergencyHint: true,
    context,
  });
  return sendEmail(contactEmail, subject, body);
}

export async function sendCrashEmail(
  contactEmail: string,
  userName: string,
  link: string,
  speedKmh?: number,
  context?: EmailContext,
): Promise<SendEmailResult> {
  const safeName = esc(userName);
  const speedInfo = speedKmh ? ` while travelling at about <strong>${Math.round(speedKmh)} km/h</strong>` : "";
  const subject = safeSubject(`Urgent: Possible crash detected for ${userName} — StillHere`);

  const eventLine = `A possible vehicle crash has been detected for <strong>${safeName}</strong>${speedInfo}. Their phone reported a sudden impact and stopped moving.`;
  const whyReceiving = `You're listed as an emergency contact for <strong>${safeName}</strong> on StillHere. We notify you immediately when crash-detection is triggered.`;

  const body = renderEmail({
    level: "emergency",
    title: "Possible vehicle crash detected",
    userName,
    eventLine,
    ctaUrl: link,
    ctaLabel: "View live location",
    whyReceiving,
    emergencyHint: true,
    context,
  });
  return sendEmail(contactEmail, subject, body);
}

export async function sendGeofenceEmail(
  contactEmail: string,
  userName: string,
  zoneName: string,
  context?: EmailContext,
): Promise<SendEmailResult> {
  const safeName = esc(userName);
  const safeZone = esc(zoneName);
  const subject = safeSubject(`${userName} left "${zoneName}" — StillHere`);

  const eventLine = `<strong>${safeName}</strong> has left their <strong>"${safeZone}"</strong> zone. This may not indicate an emergency — you're being notified because ${safeName} set up location monitoring for this zone.`;
  const whyReceiving = `${safeName} added you as a trusted contact and enabled zone notifications for <strong>"${safeZone}"</strong>. Only zone exits are shared, never live coordinates.`;

  const body = renderEmail({
    level: "info",
    title: `Left "${zoneName}" zone`,
    userName,
    eventLine,
    ctaUrl: `${BRAND_BASE_URL}/family`,
    ctaLabel: "View live location",
    whyReceiving,
    emergencyHint: false,
    context,
  });
  return sendEmail(contactEmail, subject, body);
}
