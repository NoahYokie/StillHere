import { db } from "./db";
import { authSessions, otpCodes, otpRateLimits, users, settings } from "@shared/schema";
import { eq, and, gt, gte } from "drizzle-orm";
import { randomBytes, timingSafeEqual, createHmac } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { addMinutes, addDays, subMinutes, subHours } from "date-fns";
import { sendOtpSms } from "./sms";

const SESSION_COOKIE_NAME = "stillhere_session";
const SESSION_EXPIRY_DAYS = 30;
const OTP_EXPIRY_MINUTES = 10;
const OTP_RATE_LIMIT_SECONDS = 30;
const OTP_RATE_LIMIT_HOURLY = 15;

// Staging environment configuration
const APP_ENV = process.env.APP_ENV || "staging";
const WHITELIST_NUMBERS = (process.env.WHITELIST_NUMBERS || "").split(",").map(n => n.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// Apple / Google Play store review login.
//
// Store reviewers cannot receive SMS OTPs (no real SIM, no real number).
// Instead we expose ONE dedicated review account whose login is gated by an
// env flag so it can be killed instantly if the credentials ever leak. The
// review user is marked isReviewAccount=true in the DB and never triggers
// real outbound SMS, push, or contact escalation (see sms.ts / push.ts /
// storage.getContacts).
//
// All three env vars must be present AND the flag must be exactly "true"
// (string compare, not truthy) for the review login to be accepted. The
// review code must be 8-10 digits to avoid collision with the 6-digit user
// OTP space and is compared with crypto.timingSafeEqual.
// ---------------------------------------------------------------------------
const REVIEW_LOGIN_ENABLED = process.env.ENABLE_APPLE_REVIEW_LOGIN === "true";
const REVIEW_LOGIN_PHONE_RAW = process.env.APPLE_REVIEW_PHONE || "";
const REVIEW_LOGIN_CODE = process.env.APPLE_REVIEW_CODE || "";

function isReviewLoginConfigured(): boolean {
  if (!REVIEW_LOGIN_ENABLED) return false;
  if (!REVIEW_LOGIN_PHONE_RAW || !REVIEW_LOGIN_CODE) return false;
  if (!/^\d{8,10}$/.test(REVIEW_LOGIN_CODE)) return false;
  return true;
}

function reviewCodeMatches(submitted: string): boolean {
  if (!REVIEW_LOGIN_CODE) return false;
  if (typeof submitted !== "string") return false;
  if (!/^\d{8,10}$/.test(submitted)) return false;
  const a = Buffer.from(submitted);
  const b = Buffer.from(REVIEW_LOGIN_CODE);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Generate 6-digit OTP using cryptographic randomness
function generateOtp(): string {
  const bytes = randomBytes(4);
  const num = bytes.readUInt32BE(0) % 900000 + 100000;
  return num.toString();
}

function hashOtp(code: string, phone: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET is required in production");
    }
    // Dev-only fallback - never used in production due to fail-fast above.
    return createHmac("sha256", "dev-only-do-not-use-in-prod")
      .update(`${phone}:${code}`)
      .digest("hex");
  }
  return createHmac("sha256", secret).update(`${phone}:${code}`).digest("hex");
}

// Generate session token
function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

// Allowed country codes for OTP
const ALLOWED_COUNTRIES = [
  "+61",  // Australia
  "+64",  // New Zealand
  "+1",   // USA/Canada
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
  "+81",  // Japan
  "+82",  // South Korea
  "+65",  // Singapore
  "+91",  // India
  "+420", // Czech Republic
  "+36",  // Hungary
  "+40",  // Romania
  "+385", // Croatia
];

// Normalize phone number to E.164 format
export function normalizePhone(phone: string): string {
  // Remove all non-digit characters except leading +
  let cleaned = phone.replace(/[^\d+]/g, "");
  
  // Already has + prefix - keep as is (international format)
  if (cleaned.startsWith("+")) {
    return cleaned;
  }
  
  // Handle common local formats by country
  
  // Australian mobile: 04XX XXXXXX (10 digits starting with 04)
  if (cleaned.startsWith("04") && cleaned.length === 10) {
    return "+61" + cleaned.slice(1);
  }
  
  // Australian landline: 02/03/07/08 XXXX XXXX (10 digits starting with 0)
  if (cleaned.length === 10 && /^0[2378]/.test(cleaned)) {
    return "+61" + cleaned.slice(1);
  }
  
  // UK mobile: 07XXX XXXXXX (11 digits starting with 07)
  if (cleaned.startsWith("07") && cleaned.length === 11) {
    return "+44" + cleaned.slice(1);
  }
  
  // France: 06/07 mobile numbers (10 digits)
  if (/^0[67]/.test(cleaned) && cleaned.length === 10) {
    return "+33" + cleaned.slice(1);
  }
  
  // Germany: 01x mobile numbers (11-12 digits starting with 01)
  if (/^01[567]/.test(cleaned) && (cleaned.length === 11 || cleaned.length === 12)) {
    return "+49" + cleaned.slice(1);
  }
  
  // Italy: 3xx mobile numbers (10 digits starting with 3)
  if (cleaned.startsWith("3") && cleaned.length === 10) {
    return "+39" + cleaned;
  }
  
  // Spain: 6/7 mobile numbers (9 digits)
  if (/^[67]/.test(cleaned) && cleaned.length === 9) {
    return "+34" + cleaned;
  }
  
  // Netherlands: 06 mobile numbers (10 digits)
  if (cleaned.startsWith("06") && cleaned.length === 10) {
    return "+31" + cleaned.slice(1);
  }
  
  // Belgium: 04 mobile numbers (10 digits)
  if (cleaned.startsWith("04") && cleaned.length === 10) {
    return "+32" + cleaned.slice(1);
  }
  
  // Switzerland: 07 mobile numbers (10 digits)
  if (cleaned.startsWith("07") && cleaned.length === 10) {
    return "+41" + cleaned.slice(1);
  }
  
  // Ireland: 08x mobile numbers (10 digits)
  if (/^08[3-9]/.test(cleaned) && cleaned.length === 10) {
    return "+353" + cleaned.slice(1);
  }
  
  // Sweden: 07 mobile numbers (10 digits)
  if (cleaned.startsWith("07") && cleaned.length === 10) {
    return "+46" + cleaned.slice(1);
  }
  
  // Norway: 4/9 mobile numbers (8 digits)
  if (/^[49]/.test(cleaned) && cleaned.length === 8) {
    return "+47" + cleaned;
  }
  
  // Denmark: 8-digit mobile numbers (various prefixes 2-9)
  if (/^[2-9]/.test(cleaned) && cleaned.length === 8) {
    return "+45" + cleaned;
  }
  
  // New Zealand: 02x mobile numbers (10-11 digits)
  if (/^02[0-9]/.test(cleaned) && (cleaned.length === 10 || cleaned.length === 11)) {
    return "+64" + cleaned.slice(1);
  }
  
  // India: 10-digit mobile numbers starting with 6-9
  if (/^[6-9]/.test(cleaned) && cleaned.length === 10) {
    return "+91" + cleaned;
  }
  
  // Japan: 0x0 mobile numbers (11 digits starting with 0)
  if (/^0[789]0/.test(cleaned) && cleaned.length === 11) {
    return "+81" + cleaned.slice(1);
  }
  
  // South Korea: 01x mobile numbers (10-11 digits)
  if (/^01[016789]/.test(cleaned) && (cleaned.length === 10 || cleaned.length === 11)) {
    return "+82" + cleaned.slice(1);
  }
  
  // Singapore: 8/9 digit mobile numbers (8 digits)
  if (/^[89]/.test(cleaned) && cleaned.length === 8) {
    return "+65" + cleaned;
  }
  
  // US/Canada: 10 digit number (no leading 0)
  if (cleaned.length === 10 && !cleaned.startsWith("0")) {
    return "+1" + cleaned;
  }
  
  // US/Canada: 11 digit number starting with 1
  if (cleaned.length === 11 && cleaned.startsWith("1")) {
    return "+" + cleaned;
  }
  
  // For all other formats, user must provide international format with +
  return "+" + cleaned;
}

// Check if phone is from an allowed country
export function isAllowedCountry(phone: string): boolean {
  const normalized = normalizePhone(phone);
  return ALLOWED_COUNTRIES.some(code => normalized.startsWith(code));
}

// Check if phone is whitelisted in staging
export function isPhoneWhitelisted(phone: string): boolean {
  if (APP_ENV === "production") return true;
  if (WHITELIST_NUMBERS.length === 0) return true; // No whitelist = allow all for dev
  return WHITELIST_NUMBERS.includes(phone);
}

// Check if phone can receive OTP (country + whitelist)
export function canSendOtp(phone: string): { allowed: boolean; error?: string } {
  const normalized = normalizePhone(phone);
  
  // Check country allowlist
  if (!isAllowedCountry(normalized)) {
    return {
      allowed: false,
      error: "Please enter your number with country code (e.g., +33 for France, +49 for Germany).",
    };
  }
  
  // Check staging whitelist
  if (!isPhoneWhitelisted(normalized)) {
    return {
      allowed: false,
      error: "This version is in private testing. Your number is not on the test list.",
    };
  }
  
  return { allowed: true };
}

// Check rate limits for OTP requests
export async function checkOtpRateLimit(phone: string): Promise<{ 
  allowed: boolean; 
  reason?: string;
  waitSeconds?: number;
}> {
  const normalizedPhone = normalizePhone(phone);
  const now = new Date();
  
  // Check last request (60 second cooldown)
  const oneMinuteAgo = subMinutes(now, 1);
  const recentRequests = await db
    .select()
    .from(otpRateLimits)
    .where(
      and(
        eq(otpRateLimits.phone, normalizedPhone),
        gte(otpRateLimits.createdAt, oneMinuteAgo)
      )
    );
  
  if (recentRequests.length > 0) {
    const lastRequest = recentRequests[recentRequests.length - 1];
    const waitMs = OTP_RATE_LIMIT_SECONDS * 1000 - (now.getTime() - new Date(lastRequest.createdAt).getTime());
    const waitSeconds = Math.ceil(waitMs / 1000);
    return {
      allowed: false,
      reason: `Please wait ${waitSeconds} seconds before requesting another code.`,
      waitSeconds,
    };
  }
  
  // Check hourly limit (5 per hour)
  const oneHourAgo = subHours(now, 1);
  const hourlyRequests = await db
    .select()
    .from(otpRateLimits)
    .where(
      and(
        eq(otpRateLimits.phone, normalizedPhone),
        gte(otpRateLimits.createdAt, oneHourAgo)
      )
    );
  
  if (hourlyRequests.length >= OTP_RATE_LIMIT_HOURLY) {
    return {
      allowed: false,
      reason: "Too many code requests. Please try again in an hour.",
    };
  }
  
  return { allowed: true };
}

// Create and store OTP
export async function createOtp(phone: string): Promise<{ 
  success: boolean; 
  phone?: string; 
  error?: string;
  waitSeconds?: number;
}> {
  const normalizedPhone = normalizePhone(phone);
  
  // Store-review phone short-circuit: never send a real OTP SMS to the
  // reviewer's number. The reviewer enters the static review code (which
  // they were given by the listing) and is verified via the env-gated path
  // in verifyOtp. We return success so the client UI can advance to the
  // code-entry screen exactly like a real user.
  if (
    isReviewLoginConfigured() &&
    normalizedPhone === normalizePhone(REVIEW_LOGIN_PHONE_RAW)
  ) {
    console.log(`[AUTH] Store review OTP request accepted (no SMS sent) for ***${normalizedPhone.slice(-4)}`);
    return { success: true, phone: normalizedPhone };
  }

  // Check country and whitelist
  const canSend = canSendOtp(normalizedPhone);
  if (!canSend.allowed) {
    console.log(`[AUTH] Blocked: ***${normalizedPhone.slice(-4)} - ${canSend.error}`);
    return {
      success: false,
      error: canSend.error,
    };
  }
  
  // Check rate limits
  const rateLimitCheck = await checkOtpRateLimit(normalizedPhone);
  if (!rateLimitCheck.allowed) {
    return {
      success: false,
      error: rateLimitCheck.reason,
      waitSeconds: rateLimitCheck.waitSeconds,
    };
  }
  
  // Record this request for rate limiting
  await db.insert(otpRateLimits).values({
    phone: normalizedPhone,
  });
  
  const code = generateOtp();
  const hashedCode = hashOtp(code, normalizedPhone);
  const expiresAt = addMinutes(new Date(), OTP_EXPIRY_MINUTES);
  
  await db.insert(otpCodes).values({
    phone: normalizedPhone,
    code: hashedCode,
    expiresAt,
    used: false,
  });
  
  // Send OTP via SMS (Twilio if configured, otherwise logs to console)
  const smsResult = await sendOtpSms(normalizedPhone, code);
  
  if (!smsResult.success) {
    console.error(`[AUTH] Failed to send OTP SMS: ${smsResult.error}`);
  }
  
  console.log(`[AUTH] OTP created for ***${normalizedPhone.slice(-4)}, expires ${expiresAt.toLocaleTimeString()}`);
  
  return { success: true, phone: normalizedPhone };
}

// Verify OTP and create session
export async function verifyOtp(phone: string, code: string): Promise<{
  success: boolean;
  sessionToken?: string;
  userId?: string;
  isNewUser?: boolean;
  needsSetup?: boolean;
}> {
  const normalizedPhone = normalizePhone(phone);

  // Env-gated store-review login. The review phone can ONLY authenticate
  // when the flag is on AND the timing-safe code compare succeeds.
  // Real-user OTP flow is unchanged.
  let isReviewLogin = false;
  if (
    isReviewLoginConfigured() &&
    normalizedPhone === normalizePhone(REVIEW_LOGIN_PHONE_RAW)
  ) {
    if (reviewCodeMatches(code)) {
      isReviewLogin = true;
      // Log the event but never the code.
      console.log(`[AUTH] Store review login accepted for ***${normalizedPhone.slice(-4)}`);
    } else {
      console.warn(`[AUTH] Store review login REJECTED (bad code) for ***${normalizedPhone.slice(-4)}`);
      return { success: false };
    }
  }

  if (!isReviewLogin) {
    const hashedInput = hashOtp(code, normalizedPhone);

    const otpCandidates = await db
      .select()
      .from(otpCodes)
      .where(
        and(
          eq(otpCodes.phone, normalizedPhone),
          eq(otpCodes.used, false),
          gt(otpCodes.expiresAt, new Date())
        )
      )
      .limit(5);

    const otp = otpCandidates.find(candidate => {
      try {
        const a = Buffer.from(candidate.code);
        const b = Buffer.from(hashedInput);
        return a.length === b.length && timingSafeEqual(a, b);
      } catch {
        return false;
      }
    });

    if (!otp) {
      return { success: false };
    }

    await db.update(otpCodes).set({ used: true }).where(eq(otpCodes.id, otp.id));
  }
  
  // Find or create user by phone
  let [user] = await db
    .select()
    .from(users)
    .where(eq(users.phone, normalizedPhone))
    .limit(1);
  
  let isNewUser = false;
  let needsSetup = false;
  
  if (!user) {
    // Create new user with phone only (name will be set in setup).
    // Race-safe: if a parallel verifyOtp for the same phone wins the insert
    // first, our INSERT hits the users.phone UNIQUE constraint (Postgres
    // SQLSTATE 23505). In that case we re-select the row that won the race
    // instead of returning a duplicate-account error to the user.
    try {
      const [newUser] = await db
        .insert(users)
        .values({
          name: isReviewLogin ? "App Review" : "",
          phone: normalizedPhone,
          timezone: "Australia/Melbourne",
          isReviewAccount: isReviewLogin,
        })
        .returning();
      user = newUser;
      isNewUser = true;
      needsSetup = !isReviewLogin;

      // Create default settings
      await db.insert(settings).values({
        userId: user.id,
        checkinIntervalHours: 24,
        graceMinutes: 15,
        locationMode: "off",
      });
    } catch (err: any) {
      if (err?.code === "23505") {
        const [existing] = await db
          .select()
          .from(users)
          .where(eq(users.phone, normalizedPhone))
          .limit(1);
        if (!existing) {
          console.error("[AUTH] Race-condition recovery failed for phone ***" + normalizedPhone.slice(-4));
          return { success: false };
        }
        user = existing;
        needsSetup = !user.name || user.name.trim() === "";
      } else {
        throw err;
      }
    }
  } else {
    // Check if user needs setup (name not set)
    needsSetup = !user.name || user.name.trim() === "";
    // Self-heal: if a previously-created user matches the review phone but
    // the review flag is off (e.g. the row pre-dates this feature), flip
    // the flag on AND normalize their identity so the reviewer always lands
    // in the same clean state (skip name-setup, name = "App Review"). Only
    // when review login is the active code path.
    if (isReviewLogin && !user.isReviewAccount) {
      await db.update(users).set({
        isReviewAccount: true,
        name: "App Review",
      }).where(eq(users.id, user.id));
      user = { ...user, isReviewAccount: true, name: "App Review" };
      needsSetup = false;
    } else if (isReviewLogin) {
      needsSetup = false;
    }
  }

  // Create session
  const sessionToken = generateSessionToken();
  const expiresAt = addDays(new Date(), SESSION_EXPIRY_DAYS);
  
  await db.insert(authSessions).values({
    userId: user.id,
    token: sessionToken,
    expiresAt,
  });
  
  console.log(`[AUTH] User ***${normalizedPhone.slice(-4)} logged in (isNew: ${isNewUser})`);
  
  return {
    success: true,
    sessionToken,
    userId: user.id,
    isNewUser,
    needsSetup,
  };
}

// Get user from session token
export async function getUserFromSession(sessionToken: string): Promise<{
  userId: string;
  user: typeof users.$inferSelect;
} | null> {
  const [session] = await db
    .select()
    .from(authSessions)
    .where(
      and(
        eq(authSessions.token, sessionToken),
        gt(authSessions.expiresAt, new Date())
      )
    )
    .limit(1);
  
  if (!session) {
    return null;
  }
  
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  
  if (!user) {
    return null;
  }
  
  return { userId: user.id, user };
}

// Delete session (logout)
export async function deleteSession(sessionToken: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.token, sessionToken));
}

// Set session cookie
export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

// Clear session cookie
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}

// Get session token from request
export function getSessionToken(req: Request): string | null {
  return req.cookies?.[SESSION_COOKIE_NAME] || null;
}

// Auth middleware - attaches user to request
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const sessionToken = getSessionToken(req);
  
  if (sessionToken) {
    const result = await getUserFromSession(sessionToken);
    if (result) {
      (req as any).userId = result.userId;
      (req as any).user = result.user;
    }
  }
  
  next();
}

// Require auth middleware - returns 401 if not authenticated
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!(req as any).userId) {
    res.status(401).json({ error: "Not authenticated", requiresLogin: true });
    return;
  }
  next();
}
