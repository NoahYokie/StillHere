import { db } from "./db";
import { authSessions, otpCodes, otpRateLimits, users, settings } from "@shared/schema";
import { eq, and, gt, gte } from "drizzle-orm";
import { randomBytes } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { addMinutes, addDays, subMinutes, subHours } from "date-fns";

const SESSION_COOKIE_NAME = "stillhere_session";
const SESSION_EXPIRY_DAYS = 30;
const OTP_EXPIRY_MINUTES = 10;
const OTP_RATE_LIMIT_SECONDS = 60;
const OTP_RATE_LIMIT_HOURLY = 5;

// Staging environment configuration
const APP_ENV = process.env.APP_ENV || "staging";
const WHITELIST_NUMBERS = (process.env.WHITELIST_NUMBERS || "").split(",").map(n => n.trim()).filter(Boolean);

// Generate 6-digit OTP
function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Generate session token
function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

// Normalize phone number (basic E.164-ish format)
export function normalizePhone(phone: string): string {
  // Remove all non-digit characters except leading +
  let cleaned = phone.replace(/[^\d+]/g, "");
  
  // If starts with 0, assume Australian and convert to +61
  if (cleaned.startsWith("0")) {
    cleaned = "+61" + cleaned.slice(1);
  }
  
  // If no + prefix, add it
  if (!cleaned.startsWith("+")) {
    cleaned = "+" + cleaned;
  }
  
  return cleaned;
}

// Check if phone is whitelisted in staging
export function isPhoneWhitelisted(phone: string): boolean {
  if (APP_ENV === "production") return true;
  if (WHITELIST_NUMBERS.length === 0) return true; // No whitelist = allow all for dev
  return WHITELIST_NUMBERS.includes(phone);
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
  
  // Check staging whitelist
  if (!isPhoneWhitelisted(normalizedPhone)) {
    console.log(`[AUTH] Blocked non-whitelisted number in staging: ${normalizedPhone}`);
    return {
      success: false,
      error: "This version is in private testing. Your number is not on the test list.",
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
  const expiresAt = addMinutes(new Date(), OTP_EXPIRY_MINUTES);
  
  await db.insert(otpCodes).values({
    phone: normalizedPhone,
    code,
    expiresAt,
    used: false,
  });
  
  // Log the OTP for testing (in production, this would be sent via Twilio)
  console.log("\n========================================");
  console.log("OTP CODE (for testing)");
  console.log("========================================");
  console.log(`Phone: ${normalizedPhone}`);
  console.log(`Code: ${code}`);
  console.log(`Expires: ${expiresAt.toLocaleTimeString()}`);
  console.log(`Environment: ${APP_ENV}`);
  console.log("========================================\n");
  
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
  
  // Find valid OTP
  const [otp] = await db
    .select()
    .from(otpCodes)
    .where(
      and(
        eq(otpCodes.phone, normalizedPhone),
        eq(otpCodes.code, code),
        eq(otpCodes.used, false),
        gt(otpCodes.expiresAt, new Date())
      )
    )
    .limit(1);
  
  if (!otp) {
    return { success: false };
  }
  
  // Mark OTP as used
  await db.update(otpCodes).set({ used: true }).where(eq(otpCodes.id, otp.id));
  
  // Find or create user by phone
  let [user] = await db
    .select()
    .from(users)
    .where(eq(users.phone, normalizedPhone))
    .limit(1);
  
  let isNewUser = false;
  let needsSetup = false;
  
  if (!user) {
    // Create new user with phone only (name will be set in setup)
    const [newUser] = await db
      .insert(users)
      .values({
        name: "",
        phone: normalizedPhone,
        timezone: "Australia/Melbourne",
      })
      .returning();
    user = newUser;
    isNewUser = true;
    needsSetup = true;
    
    // Create default settings
    await db.insert(settings).values({
      userId: user.id,
      checkinIntervalHours: 24,
      graceMinutes: 15,
      locationMode: "off",
    });
  } else {
    // Check if user needs setup (name not set)
    needsSetup = !user.name || user.name.trim() === "";
  }
  
  // Create session
  const sessionToken = generateSessionToken();
  const expiresAt = addDays(new Date(), SESSION_EXPIRY_DAYS);
  
  await db.insert(authSessions).values({
    userId: user.id,
    token: sessionToken,
    expiresAt,
  });
  
  console.log(`\n[AUTH] User ${user.phone} logged in (isNew: ${isNewUser})\n`);
  
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
