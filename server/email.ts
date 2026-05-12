import { Resend } from "resend";
import { createHmac } from "crypto";

const SENDER_NAME = "StillHere";
const SENDER_EMAIL = process.env.EMAIL_FROM || "alerts@stillhere.health";

// Public-facing brand URL — must be HTTPS and externally reachable since
// email clients fetch images/links from outside our network.
const BRAND_BASE_URL = process.env.BRAND_BASE_URL || "https://stillhere.health";

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
  // True when sendEmail "succeeded" without actually contacting a provider —
  // dev-mode dry-runs (no RESEND_API_KEY) and policy-deduped repeats. Callers
  // that need to know whether bytes actually left the building (e.g. the
  // notifyContact fallback summary used to flip incidents.deliveryFailed /
  // incidents.degradedDelivery) MUST treat dryRun:true as non-delivery.
  dryRun?: boolean;
}

export interface EmailContext {
  lat?: number | null;
  lng?: number | null;
  address?: string | null;
  locationAt?: Date | null;
  timezone?: string | null;
}

function esc(s: string | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeSubject(s: string): string {
  return s.replace(/[\r\n\t\0]+/g, " ").slice(0, 200);
}

// "Australia/Melbourne" -> "Melbourne time"
// "America/New_York" -> "New York time"
// Falls back to "UTC" if the IANA tz can't be parsed.
function tzLabel(timezone?: string | null): string {
  if (!timezone) return "UTC";
  const parts = timezone.split("/");
  const city = parts[parts.length - 1].replace(/_/g, " ");
  return `${city} time`;
}

function fmtLocalTime(d: Date, timezone?: string | null): string {
  const tz = timezone || "UTC";
  try {
    const date = d.toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric", timeZone: tz,
    });
    const time = d.toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz,
    });
    return `${date}, ${time} (${tzLabel(timezone)})`;
  } catch {
    return d.toUTCString();
  }
}

function fmtCoords(lat?: number | null, lng?: number | null): string | null {
  if (lat == null || lng == null) return null;
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

function gmapsUrl(lat?: number | null, lng?: number | null): string | null {
  if (lat == null || lng == null) return null;
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

// Build a signed URL to our /api/email/static-map proxy. HMAC matches the
// verification in server/routes.ts so randoms can't use us as a free proxy.
function signedMapImageUrl(lat: number, lng: number): string | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  const sig = createHmac("sha256", secret)
    .update(`map:${lat.toFixed(5)}:${lng.toFixed(5)}`)
    .digest("hex").slice(0, 32);
  return `${BRAND_BASE_URL}/api/email/static-map?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}&sig=${sig}`;
}

// Server-side reverse geocode with in-memory cache + 2s timeout. Best-effort —
// returns null if the API call fails or takes too long, so we never block
// sending an emergency email on a slow Google response.
const geocodeCache = new Map<string, { address: string | null; at: number }>();
const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000;

async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const cached = geocodeCache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < GEOCODE_TTL_MS) return cached.address;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const resp = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}&result_type=street_address|route|premise|locality`,
      { signal: ctrl.signal },
    );
    clearTimeout(timer);
    const data: any = await resp.json();
    let address: string | null = null;
    if (data?.status === "OK" && data?.results?.length) {
      address = data.results[0].formatted_address || null;
    }
    geocodeCache.set(cacheKey, { address, at: Date.now() });
    return address;
  } catch {
    return null;
  }
}

type AlertLevel = "emergency" | "warning" | "info";

const LEVEL: Record<AlertLevel, { label: string; accent: string; ctaBg: string; badgeBg: string; badgeText: string; logoBg: string }> = {
  emergency: { label: "Emergency",    accent: "#dc2626", ctaBg: "#dc2626", badgeBg: "#fee2e2", badgeText: "#991b1b", logoBg: "#dc2626" },
  warning:   { label: "Safety alert", accent: "#f59e0b", ctaBg: "#f59e0b", badgeBg: "#fef3c7", badgeText: "#92400e", logoBg: "#0f172a" },
  info:      { label: "Update",       accent: "#2563eb", ctaBg: "#2563eb", badgeBg: "#dbeafe", badgeText: "#1e40af", logoBg: "#0f172a" },
};

interface RenderArgs {
  level: AlertLevel;
  title: string;
  userName: string;
  eventLine: string;
  ctaUrl: string;
  ctaLabel: string;
  whyReceiving: string;
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
  const gmaps = gmapsUrl(context?.lat, context?.lng);
  const mapImg = (context?.lat != null && context?.lng != null)
    ? signedMapImageUrl(context.lat, context.lng) : null;
  const addressLine = context?.address?.trim() || coords;

  // Hosted PNG logo (icon-192) + adjacent wordmark. The wordmark text is the
  // alt text AND a visible sibling, so if the image fails to load the brand
  // is still legible. Width/height are explicit for Outlook/Gmail.
  const logoBlock = `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-block;vertical-align:middle;">
              <tr>
                <td style="vertical-align:middle;padding:0 8px 0 0;line-height:0;">
                  <img src="${BRAND_BASE_URL}/icons/icon-192x192.png" width="32" height="32" alt="StillHere" style="display:block;width:32px;height:32px;border:0;border-radius:7px;" />
                </td>
                <td style="vertical-align:middle;font-size:17px;font-weight:700;color:#0f172a;letter-spacing:-0.015em;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">StillHere</td>
              </tr>
            </table>`;

  const locationBlock = addressLine ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px 0;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;">
          <tr><td style="padding:14px 16px;">
            <p style="margin:0 0 4px 0;font-size:12px;color:#64748b;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;">Last known location</p>
            <p style="margin:0 0 2px 0;font-size:15px;color:#0f172a;line-height:1.4;font-weight:500;">${esc(addressLine)}</p>
            ${context?.address && coords ? `<p style="margin:2px 0 0 0;font-size:12px;color:#94a3b8;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${esc(coords)}</p>` : ""}
            ${locTime ? `<p style="margin:6px 0 0 0;font-size:12px;color:#64748b;">Reported ${locTime}</p>` : ""}
          </td></tr>
        </table>` : "";

  const mapBlock = (mapImg && gmaps) ? `
        <a href="${esc(gmaps)}" style="display:block;text-decoration:none;border-radius:10px;overflow:hidden;margin:0 0 18px 0;border:1px solid #e2e8f0;">
          <img src="${esc(mapImg)}" alt="Map showing ${safeName}'s last known location" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0;" />
        </a>` : "";

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
              <td align="left" style="vertical-align:middle;">${logoBlock}</td>
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
          ${mapBlock}
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
            <a href="${esc(BRAND_BASE_URL)}" style="color:#94a3b8;text-decoration:none;">stillhere.health</a> · Personal safety check ins
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// Resolve address before render (best-effort). Mutates context with the
// reverse-geocoded street address so the email shows it instead of bare coords.
async function enrichContext(context?: EmailContext): Promise<EmailContext | undefined> {
  if (!context) return context;
  if (context.address || context.lat == null || context.lng == null) return context;
  const address = await reverseGeocode(context.lat, context.lng);
  return { ...context, address: address || null };
}

export interface SendEmailOptions {
  // Why this email is going out. Drives audit + global circuit breaker.
  // Defaults to "system_alert" so legacy callers still record an audit row.
  purpose?: import("./outbound-policy").OutboundPurpose;
  userId?: string | null;
  incidentId?: string | null;
  dedupeKey?: string | null;
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  options: SendEmailOptions = {},
): Promise<SendEmailResult> {
  const masked = to.replace(/(.{2}).*(@.*)/, "$1***$2");

  // Best-effort audit: emails are incident-driven and we never want a logging
  // failure to drop a safety email, so we record outcome only.
  const policy = await import("./outbound-policy");
  const auditCtx: import("./outbound-policy").SendContext = {
    channel: "email",
    purpose: options.purpose || "system_alert",
    destination: to,
    userId: options.userId ?? null,
    incidentId: options.incidentId ?? null,
    dedupeKey: options.dedupeKey ?? null,
  };
  const recordOutcome = async (status: import("./outbound-policy").OutboundStatus, errorMessage?: string, providerId?: string) => {
    try { await policy.recordSendAttempt(auditCtx, status, { errorMessage, providerId }); } catch {}
  };

  // Phase 1.1: dedupe-loop protection for email. When the caller supplies a
  // dedupeKey (worker / sensor loops should always do so), collapse repeats
  // inside the 5-min window and propagate degraded state to the incident.
  if (options.dedupeKey) {
    try {
      const dec = await policy.enforceSendPolicy(auditCtx);
      if (dec.degraded && options.incidentId) {
        const { storage } = await import("./storage");
        await storage.updateIncident(options.incidentId, { degradedDelivery: true });
      }
      if (!dec.allowed && dec.reason === "duplicate") {
        console.log(`[EMAIL] Deduped (loop) to=${masked} key=${options.dedupeKey}`);
        return { success: true, dryRun: true };
      }
    } catch (e: any) {
      console.warn(`[EMAIL] policy check failed, sending anyway: ${e?.message || e}`);
    }
  }

  const client = getResend();
  if (!client) {
    console.log(`[EMAIL] (dry-run, RESEND_API_KEY not set) to=${masked} subject="${subject}" (${body.length} chars)`);
    await recordOutcome("provider_unconfigured", "resend_missing");
    return { success: true, dryRun: true };
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
      await recordOutcome("failed", error.message || String(error));
      return { success: false, error: error.message || String(error) };
    }
    console.log(`[EMAIL] sent to=${masked} id=${data?.id} subject="${subject}"`);
    await recordOutcome("sent", undefined, data?.id);
    return { success: true };
  } catch (err: any) {
    console.error(`[EMAIL] send threw to=${masked}:`, err?.message || err);
    await recordOutcome("failed", err?.message || String(err));
    return { success: false, error: err?.message || String(err) };
  }
}

export async function sendEmergencyEmail(
  contactEmail: string,
  userName: string,
  link: string,
  reason: "sos" | "missed_checkin",
  context?: EmailContext,
  options: SendEmailOptions = {},
): Promise<SendEmailResult> {
  const issos = reason === "sos";
  const safeName = esc(userName);
  const level: AlertLevel = issos ? "emergency" : "warning";
  const subject = safeSubject(issos
    ? `Urgent: ${userName} needs help (StillHere)`
    : `Safety alert: ${userName} missed a check in (StillHere)`);
  const title = issos ? "Emergency SOS activated" : "Missed safety check in";
  const eventLine = issos
    ? `<strong>${safeName}</strong> just activated an emergency SOS. We are contacting their Safety Circle right now by app, SMS, phone call, and email.`
    : `<strong>${safeName}</strong> hasn't responded to a scheduled safety check in. We are contacting their Safety Circle right now by app, SMS, phone call, and email.`;
  const whyReceiving = `You're listed as an emergency contact for <strong>${safeName}</strong> on StillHere. They asked us to notify you the moment a safety event is detected.`;

  const enriched = await enrichContext(context);
  const body = renderEmail({
    level, title, userName, eventLine,
    ctaUrl: link, ctaLabel: "View live location",
    whyReceiving, emergencyHint: true, context: enriched,
  });
  return sendEmail(contactEmail, subject, body, {
    purpose: issos ? "sos_alert" : "missed_checkin_alert",
    ...options,
  });
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
  const subject = safeSubject(`Urgent: Possible crash detected for ${userName} (StillHere)`);
  const eventLine = `A possible vehicle crash has been detected for <strong>${safeName}</strong>${speedInfo}. Their phone reported a sudden impact and stopped moving.`;
  const whyReceiving = `You're listed as an emergency contact for <strong>${safeName}</strong> on StillHere. We attempt to reach you when a possible crash is detected. StillHere is not an emergency response service.`;

  const enriched = await enrichContext(context);
  const body = renderEmail({
    level: "emergency", title: "Possible vehicle crash detected",
    userName, eventLine,
    ctaUrl: link, ctaLabel: "View live location",
    whyReceiving, emergencyHint: true, context: enriched,
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
  const subject = safeSubject(`${userName} left "${zoneName}" (StillHere)`);
  const eventLine = `<strong>${safeName}</strong> has left their <strong>"${safeZone}"</strong> zone. This may not indicate an emergency. You're being notified because ${safeName} set up location monitoring for this zone.`;
  const whyReceiving = `${safeName} added you as a trusted contact and enabled zone notifications for <strong>"${safeZone}"</strong>. Only zone exits are shared, never live coordinates.`;

  const enriched = await enrichContext(context);
  const body = renderEmail({
    level: "info", title: `Left "${zoneName}" zone`,
    userName, eventLine,
    ctaUrl: `${BRAND_BASE_URL}/family`, ctaLabel: "View live location",
    whyReceiving, emergencyHint: false, context: enriched,
  });
  return sendEmail(contactEmail, subject, body);
}
