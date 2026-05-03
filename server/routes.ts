import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import rateLimit from "express-rate-limit";
import { storage } from "./storage";
import { processLocationContext, getUserContext, getRecentContextEvents } from "./context-processor";
import { notifyConcern, notifyRecovery, notifySubjectConfirmation } from "./notification-engine";
import { addMinutes, addHours, addDays } from "date-fns";
import { db } from "./db";
import { eq, and, lt, gte, desc, isNull, sql } from "drizzle-orm";
import { users, settings, authSessions, safeWalks, watcherNotificationPrefs, incidents, checkins, contextEvents, contacts, type FamilyRole } from "@shared/schema";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { randomBytes } from "crypto";
import {
  createOtp,
  verifyOtp,
  deleteSession,
  setSessionCookie,
  clearSessionCookie,
  getSessionToken,
  getUserFromSession,
  normalizePhone,
} from "./auth";
import {
  sendSosAlert,
  sendMissedCheckinAlert,
  sendTestMessage,
  sendReminderSms,
  sendAllClearNotification,
  sendEscalationAlert,
  sendHandlingTimeoutAlert,
  isTwilioConfigured,
  getTurnCredentials,
  sendSms,
  verifyTwilioSignature,
  escapeXml,
} from "./sms";
import {
  isPushConfigured,
  getVapidPublicKey,
  sendReminderPush,
  sendPushNotification,
} from "./push";
import { emitToUser, isUserOnline } from "./socket";
import { sendEmergencyEmail, sendGeofenceEmail, sendCrashEmail } from "./email";

// Helper to get userId from session
const getUserId = (req: Request): string | null => {
  return (req as any).userId || null;
};

const getBaseUrl = (): string => {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) {
    const firstDomain = domains.split(",")[0].trim();
    return `https://${firstDomain}`;
  }
  return "https://stillhere.health";
};

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatContextEvent(type: string, placeName: string | null, detail: string | null): string {
  if (detail) return detail;
  const place = placeName || "nearby";
  switch (type) {
    case "dwell_start": return `Settled in at ${place}`;
    case "dwell_end": return `Left ${place}`;
    case "trip_start": return placeName ? `Left ${place}` : "Heading out";
    case "trip_end": return placeName ? `Arrived at ${place}` : "Arrived safely";
    default: return type;
  }
}

function detectActivity(speedMs: number | null | undefined): string {
  if (speedMs == null || speedMs < 0.5) return "stationary";
  const kmh = speedMs * 3.6;
  if (kmh < 7) return "walking";
  if (kmh < 20) return "running";
  if (kmh < 35) return "cycling";
  return "driving";
}

type CheckinMethod = "app" | "sms" | "call";

interface ResolveOptions {
  resolvedBy?: "user" | "watcher";
  resolverName?: string;
  skipCreateCheckin?: boolean;
}

async function resolveCheckin(userId: string, method: CheckinMethod, options?: ResolveOptions): Promise<{ resolved: boolean; hadIncident: boolean }> {
  const user = await storage.getUser(userId);
  if (!user) {
    console.error(`[RESOLVE] User not found: ${userId}`);
    return { resolved: false, hadIncident: false };
  }

  const resolvedBy = options?.resolvedBy || "user";
  const resolverName = options?.resolverName;

  if (!options?.skipCreateCheckin) {
    const checkinMethod = method === "call" ? "auto" : method === "app" ? "button" : method;
    await storage.createCheckin(userId, checkinMethod as any, {});
    await storage.resetReminderState(userId);
    console.log(`[RESOLVE] Check-in recorded for ${user.name} via ${method}`);
  } else {
    console.log(`[RESOLVE] Skipped duplicate check-in creation for ${user.name} (already created by caller)`);
  }

  if (user.safetyState === "concern" || user.safetyState === "quiet") {
    await storage.updateSafetyState(userId, "active", `Confirmed safe via ${method}`);
    console.log(`[RESOLVE] Safety state restored: ${user.safetyState} → active`);
  }

  const openIncident = await storage.getOpenIncident(userId);
  let hadIncident = false;
  let smsSuccess = 0;
  let smsFailed = 0;

  if (openIncident) {
    hadIncident = true;
    await storage.updateIncident(openIncident.id, {
      status: "resolved",
      resolvedAt: new Date(),
    });
    console.log(`[RESOLVE] Incident ${openIncident.id} resolved (${openIncident.reason})`);

    const session = await storage.getActiveLocationSession(userId);
    if (session) {
      await storage.endLocationSession(session.id);
      console.log(`[RESOLVE] Location session ended`);
    }

    const baseUrl = getBaseUrl();
    const timeLabel = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    const contactsWithTokens = await storage.getContactTokensForUser(userId);
    console.log(`[ALL-CLEAR] Preparing to send all-clear SMS. userId=${userId}, incidentId=${openIncident.id}, method=${method}, contactsWithTokens=${contactsWithTokens.length}`);

    const smsDedup = new Set<string>();

    if (contactsWithTokens.length === 0) {
      const allContacts = await storage.getContacts(userId);
      console.log(`[ALL-CLEAR] WARNING: No active tokens found. Total contacts=${allContacts.length}. Tokens may have been revoked early.`);
      for (const contact of allContacts) {
        const normalizedPhone = normalizePhone(contact.phone);
        if (smsDedup.has(normalizedPhone)) {
          console.log(`[NOTIFY] Suppressed RECOVERY_SMS to ***${contact.phone.slice(-4)} (Role: WATCHER, reason: duplicate phone)`);
          continue;
        }
        try {
          const allClearResult = await sendAllClearNotification(normalizedPhone, user.name, `${baseUrl}/`);
          smsSuccess++;
          smsDedup.add(normalizedPhone);
          console.log(`[NOTIFY] Sent RECOVERY_SMS to ***${contact.phone.slice(-4)} (Role: WATCHER, channel: sms)`);
          console.log(JSON.stringify({ event: "CONTACT_SENT", type: "recovery", role: "WATCHER", contactName: contact.name, userId, method, timestamp: new Date().toISOString() }));
        } catch (err: any) {
          smsFailed++;
          console.error(`[ALL-CLEAR] FAILED (fallback) to ${contact.name} (***${contact.phone.slice(-4)}): ${err?.message || err}`);
        }
      }
    } else {
      for (const { contact, token } of contactsWithTokens) {
        const normalizedPhone = normalizePhone(contact.phone);
        if (smsDedup.has(normalizedPhone)) {
          console.log(`[NOTIFY] Suppressed RECOVERY_SMS to ***${contact.phone.slice(-4)} (Role: WATCHER, reason: duplicate phone)`);
          continue;
        }
        try {
          const link = `${baseUrl}/emergency/${token}`;
          const allClearResult = await sendAllClearNotification(normalizedPhone, user.name, link);
          smsSuccess++;
          smsDedup.add(normalizedPhone);
          console.log(`[NOTIFY] Sent RECOVERY_SMS to ***${contact.phone.slice(-4)} (Role: WATCHER, channel: sms)`);
          console.log(JSON.stringify({ event: "CONTACT_SENT", type: "recovery", role: "WATCHER", contactName: contact.name, userId, method, timestamp: new Date().toISOString() }));
        } catch (err: any) {
          smsFailed++;
          console.error(`[ALL-CLEAR] FAILED to ${contact.name} (***${contact.phone.slice(-4)}): ${err?.message || err}`);
        }
      }
    }
    console.log(`[ALL-CLEAR] Complete: ${smsSuccess} success, ${smsFailed} failed`);

    await storage.revokeAllTokensForUser(userId);
    console.log(`[RESOLVE] Emergency tokens revoked`);
  }

  let watcherNotified = false;
  try {
    await notifyRecovery(userId, user.name, resolvedBy, resolverName, method);
    watcherNotified = true;
  } catch (err) {
    console.error(`[RESOLVE] notifyRecovery failed:`, err);
  }

  try {
    await notifySubjectConfirmation(userId, method, hadIncident);
  } catch (err) {
    console.error(`[RESOLVE] Subject confirmation failed:`, err);
  }

  const timeStr = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  const methodLabel = resolvedBy === "watcher" 
    ? `Confirmed safe by ${resolverName || "a watcher"}`
    : method === "call" ? "Confirmed safe by phone call" 
    : method === "sms" ? "Confirmed safe by SMS" 
    : "Confirmed safe in app";
  const watcherContacts = await storage.getContactsLinkedToUser(userId);
  for (const contact of watcherContacts) {
    if (contact.linkedUserId) {
      emitToUser(contact.linkedUserId, "concern:resolved", {
        userId,
        userName: user.name,
        resolvedBy,
        resolvedByName: resolverName,
        method,
        methodLabel,
        timeLabel: `at ${timeStr}`,
        resolvedAt: new Date().toISOString(),
      });
    }
  }

  console.log(JSON.stringify({
    event: "SAFETY_RESOLVED",
    userId,
    userName: user.name,
    method,
    resolvedBy,
    resolverName: resolverName || null,
    hadIncident,
    safetyStateRestored: user.safetyState !== "active",
    smsAllClearSent: hadIncident ? smsSuccess > 0 : false,
    smsAllClearCount: hadIncident ? smsSuccess : 0,
    smsAllClearFailed: hadIncident ? smsFailed : 0,
    watcherNotified,
    watcherCount: watcherContacts.filter(c => c.linkedUserId).length,
    incidentResolved: hadIncident,
    tokensRevoked: hadIncident,
    timestamp: new Date().toISOString(),
  }));

  console.log(`[RESOLVE] Complete: ${user.name} confirmed safe via ${method}, incident=${hadIncident}`);
  return { resolved: true, hadIncident };
}

async function notifyContact(
  contact: { id: string; phone: string; name: string; linkedUserId: string | null; userId: string; email?: string | null },
  userName: string,
  link: string,
  reason: "sos" | "missed_checkin",
  sendSmsFn: (phone: string, userName: string, link: string) => Promise<any>
): Promise<void> {
  const normalizedPhone = normalizePhone(contact.phone);
  await sendSmsFn(normalizedPhone, userName, link);
  console.log(`[NOTIFY] Sent SMS to contact`);

  if (contact.email) {
    try {
      await sendEmergencyEmail(contact.email, userName, link, reason);
      console.log(`[NOTIFY] Also sent email to contact`);
    } catch (e) {
      console.error(`[NOTIFY] Email failed:`, e);
    }
  }

  if (contact.linkedUserId) {
    await sendPushNotification(contact.linkedUserId, {
      title: reason === "sos" ? `Emergency: ${userName} needs help` : `Safety Alert: ${userName} has not checked in`,
      body: reason === "sos"
        ? `${userName} has activated an emergency SOS and needs immediate assistance. Open the app to respond.`
        : `${userName} has not completed their scheduled safety checkin. Open the app to respond.`,
      url: "/watched",
      tag: "emergency-alert",
    });
    try {
      const alertContent = reason === "sos"
        ? `${userName} has activated an emergency SOS. Please check on them immediately.`
        : `${userName} has not completed their safety checkin. Please check on them.`;
      await storage.saveMessage(contact.userId, contact.linkedUserId, alertContent);
      emitToUser(contact.linkedUserId, "message:new", {
        type: "emergency-alert",
        userName,
        reason,
      });
    } catch (err: any) {
      console.error(`[NOTIFY] Push/message to linked contact ${contact.name} failed:`, err?.message || err);
    }
    console.log(`[NOTIFY] Also sent push notification to contact (in-app user)`);
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // ============================================
  // HEALTH CHECK (public)
  // ============================================
  
  app.get("/api/health", (req, res) => {
    res.json({ 
      ok: true, 
      port: process.env.PORT || 5000,
      timestamp: new Date().toISOString(),
    });
  });

  // Stripe billing routes (checkout, portal, products, /api/billing/me).
  // The webhook is registered earlier in server/index.ts with raw body parsing.
  const { registerStripeRoutes } = await import("./stripeRoutes");
  registerStripeRoutes(app);
  // RevenueCat routes for iOS/Android in-app purchases.
  const { registerRevenueCatRoutes } = await import("./revenuecatRoutes");
  registerRevenueCatRoutes(app);
  
  // ============================================
  // AUTH ROUTES (public)
  // ============================================

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many authentication attempts, please try again later" },
  });

  // Send OTP code
  app.post("/api/auth/send-code", authLimiter, async (req, res) => {
    try {
      const { phone } = req.body;
      
      if (!phone) {
        return res.status(400).json({ error: "Phone number is required" });
      }

      const { normalizePhone } = await import("./auth");
      const normalizedPhone = normalizePhone(phone);
      if (normalizedPhone === "+15550001234") {
        return res.json({ success: true, phone: normalizedPhone });
      }
      
      const result = await createOtp(phone);
      
      if (!result.success) {
        return res.status(429).json({ 
          error: result.error,
          waitSeconds: result.waitSeconds,
        });
      }
      
      res.json({ success: true, phone: result.phone });
    } catch (error) {
      console.error("Error sending OTP:", error);
      res.status(500).json({ error: "Failed to send code" });
    }
  });
  
  // Verify OTP code  -  rate limited to prevent brute force
  const verifyAttempts = new Map<string, { count: number; resetAt: number }>();
  const MAX_VERIFY_ATTEMPTS = 5;
  const VERIFY_WINDOW_MS = 10 * 60 * 1000;

  app.post("/api/auth/verify-code", authLimiter, async (req, res) => {
    try {
      const { phone, code } = req.body;
      
      if (!phone || !code) {
        return res.status(400).json({ error: "Phone and code are required" });
      }

      const normalizedPhone = normalizePhone(phone);
      const now = Date.now();
      const attempts = verifyAttempts.get(normalizedPhone);
      if (attempts && now < attempts.resetAt) {
        if (attempts.count >= MAX_VERIFY_ATTEMPTS) {
          return res.status(429).json({ error: "Too many attempts. Please request a new code." });
        }
      } else {
        verifyAttempts.set(normalizedPhone, { count: 0, resetAt: now + VERIFY_WINDOW_MS });
      }
      
      const result = await verifyOtp(phone, code);
      
      if (!result.success) {
        const entry = verifyAttempts.get(normalizedPhone)!;
        entry.count++;
        return res.status(401).json({ error: "Invalid or expired code" });
      }
      
      verifyAttempts.delete(normalizedPhone);
      
      // Set session cookie
      setSessionCookie(res, result.sessionToken!);

      // Backfill: link any existing contacts that have this phone number
      if (result.userId) {
        try {
          const allContacts = await storage.findContactsByPhone(normalizedPhone);
          for (const contact of allContacts) {
            if (contact.userId !== result.userId && !contact.linkedUserId) {
              await storage.linkContactToUser(contact.id, result.userId);
            }
          }
        } catch (err: any) {
          console.error(`[AUTH] Contact backfill failed for ${normalizedPhone}:`, err?.message || err);
        }
      }
      
      res.json({
        success: true,
        userId: result.userId,
        isNewUser: result.isNewUser,
        needsSetup: result.needsSetup,
      });
    } catch (error) {
      console.error("Error verifying OTP:", error);
      res.status(500).json({ error: "Failed to verify code" });
    }
  });
  
  // Get current auth status
  app.get("/api/auth/me", async (req, res) => {
    try {
      const userId = getUserId(req);
      
      if (!userId) {
        return res.json({ authenticated: false });
      }
      
      const user = (req as any).user;
      const needsSetup = !user?.name || user.name.trim() === "";
      
      res.json({
        authenticated: true,
        userId,
        user: {
          id: user.id,
          name: user.name,
          phone: user.phone,
        },
        needsSetup,
      });
    } catch (error) {
      console.error("Error getting auth status:", error);
      res.status(500).json({ error: "Failed to get auth status" });
    }
  });
  
  // Logout
  app.post("/api/auth/logout", async (req, res) => {
    try {
      const sessionToken = getSessionToken(req);
      
      if (sessionToken) {
        await deleteSession(sessionToken);
      }
      
      clearSessionCookie(res);
      res.json({ success: true });
    } catch (error) {
      console.error("Error logging out:", error);
      res.status(500).json({ error: "Failed to logout" });
    }
  });

  // ============================================
  // ACCOUNT DELETION
  // ============================================
  
  app.delete("/api/account", async (req, res) => {
    try {
      const user = await getUserFromSession(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      await db.delete(users).where(eq(users.id, user.id));

      const sessionToken = getSessionToken(req);
      if (sessionToken) {
        await deleteSession(sessionToken);
      }
      clearSessionCookie(res);

      console.log(`[AUTH] Account deleted for user ***${user.phone?.slice(-4)}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting account:", error);
      res.status(500).json({ error: "Failed to delete account" });
    }
  });

  // ============================================
  // PASSKEY (WebAuthn) ROUTES
  // ============================================

  const RP_NAME = "StillHere";
  const getRpId = (req: Request): string => {
    const host = req.hostname;
    return host.includes("localhost") ? "localhost" : host;
  };
  const getOrigin = (req: Request): string => {
    return `${req.protocol}://${req.hostname}${req.hostname === "localhost" ? ":5000" : ""}`;
  };

  const challengeStore = new Map<string, { challenge: string; expiresAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of Array.from(challengeStore.entries())) {
      if (now > v.expiresAt) challengeStore.delete(k);
    }
  }, 60_000);

  app.post("/api/auth/passkey/register-options", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const user = (req as any).user;
      const existingPasskeys = await storage.getPasskeysByUserId(userId);

      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: getRpId(req),
        userName: user.phone || user.name || userId,
        userDisplayName: user.name || "StillHere User",
        userID: new TextEncoder().encode(userId),
        attestationType: "none",
        excludeCredentials: existingPasskeys.map((pk) => ({
          id: pk.credentialId,
          transports: pk.transports ? (JSON.parse(pk.transports) as AuthenticatorTransport[]) : undefined,
        })),
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "preferred",
        },
      });

      challengeStore.set(`reg:${userId}`, {
        challenge: options.challenge,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      res.json(options);
    } catch (error) {
      console.error("Error generating passkey registration options:", error);
      res.status(500).json({ error: "Failed to generate options" });
    }
  });

  app.post("/api/auth/passkey/register-verify", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const stored = challengeStore.get(`reg:${userId}`);
      if (!stored) return res.status(400).json({ error: "No challenge found. Please try again." });
      challengeStore.delete(`reg:${userId}`);

      const verification = await verifyRegistrationResponse({
        response: req.body,
        expectedChallenge: stored.challenge,
        expectedOrigin: getOrigin(req),
        expectedRPID: getRpId(req),
      });

      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ error: "Verification failed" });
      }

      const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

      await storage.createPasskey({
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: req.body.response?.transports ? JSON.stringify(req.body.response.transports) : undefined,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
      });

      console.log(`[AUTH] Passkey registered for user ${userId}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Error verifying passkey registration:", error);
      res.status(500).json({ error: "Failed to verify registration" });
    }
  });

  app.post("/api/auth/passkey/auth-options", authLimiter, async (req, res) => {
    try {
      const options = await generateAuthenticationOptions({
        rpID: getRpId(req),
        userVerification: "preferred",
      });

      const txnId = randomBytes(32).toString("hex");
      challengeStore.set(`auth:${txnId}`, {
        challenge: options.challenge,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      res.cookie("__passkey_txn", txnId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 5 * 60 * 1000,
        path: "/",
      });

      res.json(options);
    } catch (error) {
      console.error("Error generating passkey auth options:", error);
      res.status(500).json({ error: "Failed to generate options" });
    }
  });

  app.post("/api/auth/passkey/auth-verify", authLimiter, async (req, res) => {
    try {
      const txnId = req.cookies?.["__passkey_txn"];
      if (!txnId) return res.status(400).json({ error: "Session expired. Please try again." });

      const stored = challengeStore.get(`auth:${txnId}`);
      if (!stored) return res.status(400).json({ error: "Challenge expired. Please try again." });
      challengeStore.delete(`auth:${txnId}`);
      res.clearCookie("__passkey_txn", { path: "/" });

      const credentialId = req.body.id;
      const passkey = await storage.getPasskeyByCredentialId(credentialId);
      if (!passkey) return res.status(400).json({ error: "Passkey not found" });

      const verification = await verifyAuthenticationResponse({
        response: req.body,
        expectedChallenge: stored.challenge,
        expectedOrigin: getOrigin(req),
        expectedRPID: getRpId(req),
        credential: {
          id: passkey.credentialId,
          publicKey: Buffer.from(passkey.publicKey, "base64url"),
          counter: passkey.counter,
          transports: passkey.transports ? (JSON.parse(passkey.transports) as AuthenticatorTransport[]) : undefined,
        },
      });

      if (!verification.verified) {
        return res.status(401).json({ error: "Authentication failed" });
      }

      await storage.updatePasskeyCounter(passkey.credentialId, verification.authenticationInfo.newCounter);

      const user = await storage.getUser(passkey.userId);
      if (!user) return res.status(401).json({ error: "User not found" });

      const sessionToken = randomBytes(32).toString("hex");
      const expiresAt = addDays(new Date(), 30);

      await db.insert(authSessions).values({
        userId: user.id,
        token: sessionToken,
        expiresAt,
      });

      setSessionCookie(res, sessionToken);

      const needsSetup = !user.name || user.name.trim() === "";

      console.log(`[AUTH] Passkey login for user ***${(user.phone || user.id).slice(-4)}`);

      res.json({
        success: true,
        userId: user.id,
        isNewUser: false,
        needsSetup,
      });
    } catch (error) {
      console.error("Error verifying passkey auth:", error);
      res.status(500).json({ error: "Failed to verify authentication" });
    }
  });

  app.get("/api/auth/passkeys", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const pks = await storage.getPasskeysByUserId(userId);
      res.json(pks.map((pk) => ({
        id: pk.id,
        deviceType: pk.deviceType,
        backedUp: pk.backedUp,
        createdAt: pk.createdAt,
      })));
    } catch (error) {
      console.error("Error listing passkeys:", error);
      res.status(500).json({ error: "Failed to list passkeys" });
    }
  });

  app.delete("/api/auth/passkeys/:id", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      await storage.deletePasskey(req.params.id, userId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting passkey:", error);
      res.status(500).json({ error: "Failed to delete passkey" });
    }
  });

  // ============================================
  // USER SETUP (requires auth)
  // ============================================
  
  // Update user profile (name setup)
  app.post("/api/setup", async (req, res) => {
    try {
      const userId = getUserId(req);
      
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      
      const { name } = req.body;
      
      if (!name || typeof name !== "string" || name.trim() === "") {
        return res.status(400).json({ error: "Name is required" });
      }
      
      const cleanName = name
        .replace(/[\x00-\x1F\x7F]/g, "")
        .trim()
        .slice(0, 80);
      
      if (cleanName === "") {
        return res.status(400).json({ error: "Name is required" });
      }
      
      // Update user name
      const { eq } = await import("drizzle-orm");
      const [updatedUser] = await db
        .update(users)
        .set({ name: cleanName })
        .where(eq(users.id, userId))
        .returning();
      
      console.log(`[AUTH] User setup complete for ***${(updatedUser.phone || updatedUser.id).slice(-4)}`);
      
      res.json({ success: true, user: updatedUser });
    } catch (error) {
      console.error("Error setting up user:", error);
      res.status(500).json({ error: "Failed to setup user" });
    }
  });

  // ============================================
  // PROTECTED ROUTES (require auth)
  // ============================================

  app.post("/api/heartbeat", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const { lat, lng, acc, batt, chg, net, tz } = req.body || {};
      await storage.recordHeartbeat(
        userId,
        typeof lat === "number" ? lat : undefined,
        typeof lng === "number" ? lng : undefined,
        typeof acc === "number" ? acc : undefined,
        typeof batt === "number" ? batt : undefined,
        typeof chg === "boolean" ? chg : undefined,
        typeof net === "string" ? net : undefined,
      );
      let user = await storage.getUser(userId);
      if (typeof tz === "string" && tz.includes("/") && user && user.timezone !== tz) {
        await storage.updateUser(userId, { timezone: tz });
        user = { ...user, timezone: tz };
      }
      if (user?.safetyState === "quiet") {
        const openIncident = await storage.getOpenIncident(userId);
        if (openIncident) {
          console.log(`[HEARTBEAT] User ${userId} resumed with open incident  -  routing through resolveCheckin`);
          await resolveCheckin(userId, "app");
        } else {
          await storage.updateSafetyState(userId, "active", "Heartbeat resumed");
          console.log(`[HEARTBEAT] Safety state restored for ${userId}: quiet → active (no incident)`);
          notifyRecovery(userId, user.name, "user", undefined, "heartbeat").catch((err) => {
            console.error(`[HEARTBEAT] notifyRecovery failed for ${userId}:`, err?.message || err);
          });
        }
      }
      res.json({ ok: true });
    } catch (error) {
      console.error("Error recording heartbeat:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/concern/resolve", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const openIncident = await storage.getOpenIncident(userId);
      if (user.safetyState !== "concern" && user.safetyState !== "quiet" && !openIncident) {
        console.log(`[RESOLVE] Concern resolve skipped for ${user.name}: safetyState=${user.safetyState}, no open incident`);
        return res.json({ success: true, alreadySafe: true });
      }

      const result = await resolveCheckin(userId, "app");
      console.log(`[RESOLVE] Concern self-resolve: ${user.name}, hadIncident=${result.hadIncident}`);

      res.json({ success: true });
    } catch (error) {
      console.error("Error resolving concern:", error);
      res.status(500).json({ error: "Failed to resolve concern" });
    }
  });

  app.post("/api/concern/resolve-watcher/:userId", async (req, res) => {
    try {
      const watcherId = getUserId(req);
      if (!watcherId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const targetUserId = req.params.userId;
      const linkedContacts = await storage.getContactsLinkedToUser(targetUserId);
      const isWatcher = linkedContacts.some(c => c.linkedUserId === watcherId);
      if (!isWatcher) return res.status(403).json({ error: "Not authorized" });

      const user = await storage.getUser(targetUserId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const openIncident = await storage.getOpenIncident(targetUserId);
      if (user.safetyState !== "concern" && user.safetyState !== "quiet" && !openIncident) {
        console.log(`[RESOLVE] Watcher resolve skipped for ${user.name}: safetyState=${user.safetyState}, no open incident`);
        return res.json({ success: true, alreadySafe: true });
      }

      const watcher = await storage.getUser(watcherId);
      const result = await resolveCheckin(targetUserId, "app", {
        resolvedBy: "watcher",
        resolverName: watcher?.name || undefined,
      });
      console.log(`[RESOLVE] Watcher resolve: ${user.name} marked safe by ${watcher?.name}, hadIncident=${result.hadIncident}`);

      emitToUser(targetUserId, "concern:resolved", {
        userId: targetUserId,
        resolvedBy: "watcher",
        resolvedByName: watcher?.name,
        resolvedAt: new Date().toISOString(),
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error resolving concern as watcher:", error);
      res.status(500).json({ error: "Failed to resolve concern" });
    }
  });

  app.get("/api/concern/timeline/:userId", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const targetUserId = req.params.userId;
      const isSelf = currentUserId === targetUserId;
      if (!isSelf) {
        const linkedContacts = await storage.getContactsLinkedToUser(targetUserId);
        const isWatcher = linkedContacts.some(c => c.linkedUserId === currentUserId);
        if (!isWatcher) return res.status(403).json({ error: "Not authorized" });
      }

      const user = await storage.getUser(targetUserId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const timeline: { type: string; time: string; detail: string }[] = [];

      if (user.safetyStateChangedAt) {
        timeline.push({
          type: "state_change",
          time: user.safetyStateChangedAt.toISOString(),
          detail: user.safetyState === "concern"
            ? "Concern triggered  -  no heartbeat received"
            : user.safetyState === "quiet"
              ? "Went quiet  -  waiting for response"
              : `Status: ${user.safetyState}  -  ${user.safetyStateReason || ""}`,
        });
      }

      const reminderTimeline = await storage.getReminderTimeline(targetUserId);
      for (const entry of reminderTimeline) {
        timeline.push(entry);
      }

      const openIncident = await storage.getOpenIncident(targetUserId);
      if (openIncident) {
        timeline.push({
          type: "incident",
          time: openIncident.createdAt.toISOString(),
          detail: openIncident.reason === "sos"
            ? "SOS alert triggered"
            : "Missed check-in alert triggered",
        });
      }

      timeline.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

      res.json({
        userId: targetUserId,
        userName: user.name,
        safetyState: user.safetyState,
        safetyStateReason: user.safetyStateReason,
        safetyStateChangedAt: user.safetyStateChangedAt,
        lastHeartbeatAt: user.lastHeartbeatAt,
        timeline,
      });
    } catch (error) {
      console.error("Error fetching concern timeline:", error);
      res.status(500).json({ error: "Failed to fetch concern timeline" });
    }
  });

  // Get user status
  app.get("/api/status", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const status = await storage.getUserStatus(userId);
      res.json(status);
    } catch (error) {
      console.error("Error getting status:", error);
      res.status(500).json({ error: "Failed to get status" });
    }
  });

  // Check in
  app.post("/api/checkin", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const method = req.body?.method === "auto" ? "auto" : "button";
      let location: { lat?: number; lng?: number; timezone?: string } = {};
      if (req.body?.lat != null && req.body?.lng != null) {
        const lat = parseFloat(req.body.lat);
        const lng = parseFloat(req.body.lng);
        if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
          location.lat = lat;
          location.lng = lng;
        }
      }
      if (req.body?.timezone && typeof req.body.timezone === "string" && req.body.timezone.length <= 100) {
        location.timezone = req.body.timezone;
      }
      const hasLocation = location.lat != null || location.timezone;
      const checkin = await storage.createCheckin(userId, method, hasLocation ? location as any : undefined);
      
      // Reset reminder state when user checks in
      await storage.resetReminderState(userId);

      const user = await storage.getUser(userId);
      if (user && (user.safetyState === "concern" || user.safetyState === "quiet")) {
        console.log(`[CHECKIN] User ${user.name} checked in while safetyState=${user.safetyState}  -  routing through resolveCheckin`);
        await resolveCheckin(userId, "app", { skipCreateCheckin: true });
      } else {
        const openIncident = await storage.getOpenIncident(userId);
        if (openIncident) {
          console.log(`[CHECKIN] User ${user?.name} checked in with open incident (state=${user?.safetyState})  -  routing through resolveCheckin`);
          await resolveCheckin(userId, "app", { skipCreateCheckin: true });
        }
      }
      
      res.json({ success: true, checkin });
    } catch (error) {
      console.error("Error checking in:", error);
      res.status(500).json({ error: "Failed to check in" });
    }
  });

  // SOS - immediate incident (supports both cookie auth and bearer token for watch)
  app.post("/api/sos", async (req, res) => {
    try {
      let userId = getUserId(req);
      if (!userId) {
        const bearerToken = req.headers["authorization"]?.replace("Bearer ", "");
        if (bearerToken) {
          const result = await getUserFromSession(bearerToken);
          if (result) userId = result.userId;
        }
      }
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      
      // Prevent duplicate incidents
      const existingIncident = await storage.getOpenIncident(userId);
      if (existingIncident) {
        return res.json({ success: true, incident: existingIncident, alreadyActive: true });
      }
      
      // Capture moment-of-SOS location from request body if provided
      const sosLat = typeof req.body?.lat === "number" && isFinite(req.body.lat) ? req.body.lat : null;
      const sosLng = typeof req.body?.lng === "number" && isFinite(req.body.lng) ? req.body.lng : null;
      const sosAccuracy = typeof req.body?.accuracy === "number" && isFinite(req.body.accuracy) ? req.body.accuracy : null;
      const hasLocation = sosLat !== null && sosLng !== null;

      // Create SOS incident and set safety state to concern
      let incident = await storage.createIncident(userId, "sos");
      await storage.updateSafetyState(userId, "concern", "SOS triggered");

      // Auto-post into family chat with push fan-out (best-effort, never blocks SOS).
      // Done early so family is paged even if downstream contact escalation hits errors.
      const sosUser = await storage.getUser(userId);
      broadcastToFamily(
        userId,
        `${sosUser?.name || "A family member"} triggered SOS. Please check on them right now.`,
        "panic",
        hasLocation ? { lat: sosLat, lng: sosLng, kind: "sos" } : { kind: "sos" },
        {
          title: `SOS - ${sosUser?.name || "Family member"}`,
          body: "SOS triggered. Tap to open the family map.",
          url: "/family",
          tag: "family-sos",
        },
      ).catch(() => {});

      // Snapshot moment-of-SOS location to user record so the emergency page has it immediately
      if (hasLocation) {
        await db.update(users).set({
          lastLat: sosLat,
          lastLng: sosLng,
          lastLocationAt: new Date(),
        }).where(eq(users.id, userId));
      }

      // Get contacts sorted by priority
      const contacts = await storage.getContacts(userId);
      const settings = await storage.getSettings(userId);

      // Create location session if allowed, seeded with the moment-of-SOS coordinates
      if (settings?.locationMode === "emergency_only" || settings?.locationMode === "both") {
        await storage.createLocationSession(
          userId,
          "emergency",
          incident.id,
          hasLocation ? { lat: sosLat!, lng: sosLng!, accuracy: sosAccuracy } : undefined,
        );
      }
      
      // Generate fresh tokens for this emergency
      const tokens = await storage.regenerateTokensForUser(userId);
      const user = await storage.getUser(userId);
      const baseUrl = getBaseUrl();
      
      const now = new Date();
      const sortedContacts = [...contacts].sort((a, b) => a.priority - b.priority);
      const firstContact = sortedContacts[0];
      
      if (firstContact) {
        const token = tokens.find(t => t.contact.id === firstContact.id);
        if (token) {
          const link = `${baseUrl}/emergency/${token.token}`;
          console.log(`[SOS] Alerting Contact #${firstContact.priority}`);
          await notifyContact(firstContact, user?.name || "User", link, "sos", sendSosAlert);
          console.log("[SOS] Alert sent\n");
        }
      }
      
      const sosSettings = await storage.getSettings(userId);
      incident = await storage.updateIncident(incident.id, {
        escalationLevel: 1,
        lastEscalationStep: "contact_1",
        notifiedContactIds: JSON.stringify(firstContact ? [firstContact.id] : []),
        lastContactNotifiedAt: now,
        contact1NotifiedAt: now,
        nextActionAt: addMinutes(now, sosSettings?.escalationMinutes || 20),
      });
      
      notifyConcern(userId, user?.name || "Someone", "sos").catch((err) => {
        console.error(`[SOS] notifyConcern failed for ${user?.name}:`, err?.message || err);
      });

      res.json({ success: true, incident });
    } catch (error) {
      console.error("Error sending SOS:", error);
      res.status(500).json({ error: "Failed to send SOS" });
    }
  });

  app.post("/api/resolve-alert", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      
      const openIncident = await storage.getOpenIncident(userId);
      if (!openIncident) {
        return res.status(404).json({ error: "No active alert" });
      }
      
      const result = await resolveCheckin(userId, "app");
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error resolving alert:", error);
      res.status(500).json({ error: "Failed to resolve alert" });
    }
  });

  // Update settings
  app.post("/api/settings", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const { checkinIntervalHours, graceMinutes, locationMode, reminderMode, preferredCheckinTime, timezone, autoCheckin, fallDetection, discreetSos, smsCheckinEnabled, escalationMinutes, allowReports, drivingSafety, speedLimitKmh, autoWellnessCall } = req.body;
      
      if (checkinIntervalHours !== undefined && (typeof checkinIntervalHours !== "number" || checkinIntervalHours < 12 || checkinIntervalHours > 48)) {
        return res.status(400).json({ error: "Checkin interval must be between 12 and 48 hours" });
      }
      if (graceMinutes !== undefined && (typeof graceMinutes !== "number" || graceMinutes < 10 || graceMinutes > 30)) {
        return res.status(400).json({ error: "Grace period must be between 10 and 30 minutes" });
      }
      if (locationMode !== undefined && !["off", "emergency_only", "both"].includes(locationMode)) {
        return res.status(400).json({ error: "Invalid location mode" });
      }
      if (reminderMode !== undefined && !["none", "one", "two"].includes(reminderMode)) {
        return res.status(400).json({ error: "Invalid reminder mode" });
      }
      if (autoCheckin !== undefined && typeof autoCheckin !== "boolean") {
        return res.status(400).json({ error: "Auto checkin must be a boolean" });
      }
      if (fallDetection !== undefined && typeof fallDetection !== "boolean") {
        return res.status(400).json({ error: "Fall detection must be a boolean" });
      }
      if (discreetSos !== undefined && typeof discreetSos !== "boolean") {
        return res.status(400).json({ error: "Discreet SOS must be a boolean" });
      }
      if (smsCheckinEnabled !== undefined && typeof smsCheckinEnabled !== "boolean") {
        return res.status(400).json({ error: "SMS checkin must be a boolean" });
      }
      if (escalationMinutes !== undefined && (typeof escalationMinutes !== "number" || ![5, 10, 15, 20, 30, 45, 60].includes(escalationMinutes))) {
        return res.status(400).json({ error: "Escalation minutes must be 5, 10, 15, 20, 30, 45, or 60" });
      }
      if (allowReports !== undefined && typeof allowReports !== "boolean") {
        return res.status(400).json({ error: "Allow reports must be a boolean" });
      }
      if (drivingSafety !== undefined && typeof drivingSafety !== "boolean") {
        return res.status(400).json({ error: "Driving safety must be a boolean" });
      }
      if (speedLimitKmh !== undefined && (typeof speedLimitKmh !== "number" || speedLimitKmh < 20 || speedLimitKmh > 300)) {
        return res.status(400).json({ error: "Speed limit must be between 20 and 300 km/h" });
      }
      if (autoWellnessCall !== undefined && typeof autoWellnessCall !== "boolean") {
        return res.status(400).json({ error: "Auto wellness call must be a boolean" });
      }
      
      const updates: any = {};
      if (checkinIntervalHours !== undefined) updates.checkinIntervalHours = checkinIntervalHours;
      if (graceMinutes !== undefined) updates.graceMinutes = graceMinutes;
      if (locationMode !== undefined) updates.locationMode = locationMode;
      if (reminderMode !== undefined) updates.reminderMode = reminderMode;
      if (preferredCheckinTime !== undefined) updates.preferredCheckinTime = preferredCheckinTime;
      if (autoCheckin !== undefined) updates.autoCheckin = autoCheckin;
      if (fallDetection !== undefined) updates.fallDetection = fallDetection;
      if (discreetSos !== undefined) updates.discreetSos = discreetSos;
      if (smsCheckinEnabled !== undefined) updates.smsCheckinEnabled = smsCheckinEnabled;
      if (escalationMinutes !== undefined) updates.escalationMinutes = escalationMinutes;
      if (allowReports !== undefined) updates.allowReports = allowReports;
      if (drivingSafety !== undefined) updates.drivingSafety = drivingSafety;
      if (speedLimitKmh !== undefined) updates.speedLimitKmh = speedLimitKmh;
      if (autoWellnessCall !== undefined) updates.autoWellnessCall = autoWellnessCall;
      
      // Update user timezone if provided
      if (timezone) {
        await storage.updateUser(userId, { timezone });
      }
      
      const settings = await storage.updateSettings(userId, updates);
      res.json({ success: true, settings });
    } catch (error) {
      console.error("Error updating settings:", error);
      res.status(500).json({ error: "Failed to update settings" });
    }
  });

  // Pause alerts
  app.post("/api/settings/pause", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const { pauseUntil } = req.body;
      
      const settings = await storage.updateSettings(userId, {
        pauseUntil: pauseUntil ? new Date(pauseUntil) : null,
      });
      res.json({ success: true, settings });
    } catch (error) {
      console.error("Error pausing alerts:", error);
      res.status(500).json({ error: "Failed to pause alerts" });
    }
  });

  app.post("/api/sharing-mode", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const { mode } = req.body;
      if (!["precise", "area", "presence", "paused"].includes(mode)) {
        return res.status(400).json({ error: "Invalid sharing mode" });
      }
      const user = await storage.updateUser(userId, { sharingMode: mode } as any);
      res.json({ success: true, sharingMode: user.sharingMode });
    } catch (error) {
      console.error("Error updating sharing mode:", error);
      res.status(500).json({ error: "Failed to update sharing mode" });
    }
  });

  app.post("/api/sleep-hours", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const { sleepStart, sleepEnd } = req.body;
      if (!sleepStart || !sleepEnd) return res.status(400).json({ error: "sleepStart and sleepEnd required" });
      const user = await storage.updateUser(userId, { sleepStart, sleepEnd } as any);
      res.json({ success: true, sleepStart: user.sleepStart, sleepEnd: user.sleepEnd });
    } catch (error) {
      console.error("Error updating sleep hours:", error);
      res.status(500).json({ error: "Failed to update sleep hours" });
    }
  });

  app.get("/api/my-protection", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      const userContacts = await storage.getContacts(userId);
      const watchers = userContacts.filter(c => !c.softDeletedAt).map(c => ({
        id: c.id,
        name: c.name,
        circleRole: c.circleRole || "primary",
        linkedUserId: c.linkedUserId,
      }));
      const isLearning = user.learningModeUntil ? new Date() < user.learningModeUntil : false;
      const learningDaysLeft = isLearning && user.learningModeUntil
        ? Math.ceil((user.learningModeUntil.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : 0;
      res.json({
        sharingMode: user.sharingMode || "precise",
        watchers,
        sleepStart: user.sleepStart || "22:30",
        sleepEnd: user.sleepEnd || "07:00",
        isLearning,
        learningDaysLeft,
        setupConfirmed: !!user.setupConfirmedAt,
      });
    } catch (error) {
      console.error("Error fetching protection info:", error);
      res.status(500).json({ error: "Failed to fetch protection info" });
    }
  });

  app.get("/api/guardian-view-preview", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      const userSettings = await storage.getSettings(userId);
      const lastCheckin = await storage.getLastCheckin(userId);
      const openIncident = await storage.getOpenIncident(userId);
      const mode = (user.sharingMode as string) || "precise";
      const isConcern = user.safetyState === "concern";
      const hideLocation = (mode === "presence" || mode === "paused") && !isConcern;
      const obfuscateLocation = mode === "area" && !isConcern;

      function obfuscateCoordPreview(value: number, seed: string): number {
        let hash = 0;
        for (let i = 0; i < seed.length; i++) {
          hash = ((hash << 5) - hash) + seed.charCodeAt(i);
          hash |= 0;
        }
        const offset = ((hash % 2000) - 1000) / 100000;
        return Math.round((value + offset) * 100) / 100;
      }

      const rawLat = user.lastHeartbeatLat ? Number(user.lastHeartbeatLat) : null;
      const rawLng = user.lastHeartbeatLng ? Number(user.lastHeartbeatLng) : null;

      res.json({
        userName: user.name,
        safetyState: user.safetyState,
        safetyStateReason: user.safetyStateReason,
        sharingMode: mode,
        lastCheckinAt: lastCheckin?.createdAt || null,
        hasOpenIncident: !!openIncident,
        lastHeartbeatAt: user.lastHeartbeatAt || null,
        lastHeartbeatLat: hideLocation ? null : obfuscateLocation && rawLat != null ? obfuscateCoordPreview(rawLat, userId + "lat") : (rawLat ?? null),
        lastHeartbeatLng: hideLocation ? null : obfuscateLocation && rawLng != null ? obfuscateCoordPreview(rawLng, userId + "lng") : (rawLng ?? null),
        batteryLevel: user.batteryLevel ?? null,
        batteryCharging: user.batteryCharging ?? null,
        networkType: user.networkType ?? null,
      });
    } catch (error) {
      console.error("Error fetching guardian view preview:", error);
      res.status(500).json({ error: "Failed to fetch guardian view" });
    }
  });

  app.post("/api/contacts/:contactId/role", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const { contactId } = req.params;
      const { role } = req.body;
      if (!["primary", "backup", "support"].includes(role)) {
        return res.status(400).json({ error: "Invalid role" });
      }
      const contact = await storage.getContact(contactId);
      if (!contact || contact.userId !== userId) {
        return res.status(404).json({ error: "Contact not found" });
      }
      const [updated] = await db.update(contacts).set({ circleRole: role }).where(eq(contacts.id, contactId)).returning();
      res.json({ success: true, contact: updated });
    } catch (error) {
      console.error("Error updating contact role:", error);
      res.status(500).json({ error: "Failed to update role" });
    }
  });

  app.post("/api/incidents/:incidentId/claim", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const { incidentId } = req.params;
      const incident = await db.select().from(incidents).where(eq(incidents.id, incidentId)).limit(1);
      if (!incident.length) return res.status(404).json({ error: "Incident not found" });
      if (incident[0].status === "resolved") return res.status(400).json({ error: "Already resolved" });
      if (incident[0].claimedByContactId) return res.status(400).json({ error: "Already claimed" });

      const linkedContacts = await db.select().from(contacts).where(
        and(eq(contacts.userId, incident[0].userId), eq(contacts.linkedUserId, userId), isNull(contacts.softDeletedAt))
      );
      if (!linkedContacts.length) return res.status(403).json({ error: "Not authorized" });

      const [updated] = await db.update(incidents).set({
        claimedByContactId: linkedContacts[0].id,
        claimedAt: new Date(),
      }).where(eq(incidents.id, incidentId)).returning();

      const claimer = await storage.getUser(userId);
      const otherWatchers = await storage.getContactsLinkedToUser(incident[0].userId);
      for (const wc of otherWatchers) {
        if (wc.linkedUserId && wc.linkedUserId !== userId) {
          await sendPushNotification(wc.linkedUserId, {
            title: "Being handled",
            body: `${claimer?.name || "Someone"} is handling this now. No action needed from you.`,
            url: "/watched",
            tag: `claim-${incidentId}`,
          });
        }
      }
      const { emitToUser } = await import("./socket");
      emitToUser(incident[0].userId, "incident:claimed", { incidentId, claimedBy: claimer?.name });
      for (const wc of otherWatchers) {
        if (wc.linkedUserId) emitToUser(wc.linkedUserId, "incident:claimed", { incidentId, claimedBy: claimer?.name });
      }

      console.log(`[CLAIM] Incident ${incidentId} claimed by ${claimer?.name} (${userId})`);
      res.json({ success: true, incident: updated });
    } catch (error) {
      console.error("Error claiming incident:", error);
      res.status(500).json({ error: "Failed to claim incident" });
    }
  });

  app.post("/api/safety-drill", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const existingOpen = await storage.getOpenIncident(userId);
      if (existingOpen && !existingOpen.isDrill) {
        return res.status(400).json({ error: "Your Safety Circle is currently responding to an active alert. Please wait until it's resolved before running a test." });
      }
      if (existingOpen && existingOpen.isDrill) {
        await db.update(incidents).set({ status: "resolved", resolvedAt: new Date() }).where(eq(incidents.id, existingOpen.id));
      }

      const [drill] = await db.insert(incidents).values({
        userId,
        status: "open",
        reason: "test",
        isDrill: true,
        startedAt: new Date(),
      }).returning();

      const watcherContacts = await storage.getContactsLinkedToUser(userId);
      for (const wc of watcherContacts) {
        if (wc.linkedUserId && wc.linkedUserId !== userId) {
          await sendPushNotification(wc.linkedUserId, {
            title: `${user.name} is testing their Safety Circle`,
            body: `${user.name} wants to make sure you're ready. Tap to confirm you've got their back.`,
            url: `/watched?drill=${drill.id}`,
            tag: `drill-${drill.id}`,
          });
        }
      }

      setTimeout(async () => {
        try {
          const current = await db.select().from(incidents).where(eq(incidents.id, drill.id)).limit(1);
          if (current.length && current[0].status === "open") {
            await db.update(incidents).set({ status: "resolved", resolvedAt: new Date() }).where(eq(incidents.id, drill.id));
            const acknowledged = current[0].drillAcknowledgedByContactId != null;
            for (const wc of watcherContacts) {
              if (wc.linkedUserId && wc.linkedUserId !== userId) {
                await sendPushNotification(wc.linkedUserId, {
                  title: "Safety Circle ready",
                  body: `You're all set. If ${user.name} ever needs you, we'll guide you  -  just like this.`,
                  url: "/watched",
                  tag: `drill-done-${drill.id}`,
                });
              }
            }
            await sendPushNotification(userId, {
              title: "Your Safety Circle is ready",
              body: acknowledged
                ? "Your Safety Circle is ready. If you ever need them, they'll know exactly what to do."
                : "Your Safety Circle has been tested. If you ever need them, they'll know exactly what to do.",
              url: "/",
              tag: `drill-done-${drill.id}`,
            });
          }
        } catch (err) {
          console.error("[DRILL] Auto-resolve error:", err);
        }
      }, 60000);

      console.log(`[DRILL] Safety drill started by ${user.name} (${userId}), incidentId=${drill.id}`);
      res.json({ success: true, drillId: drill.id });
    } catch (error) {
      console.error("Error starting safety drill:", error);
      res.status(500).json({ error: "Failed to start drill" });
    }
  });

  app.post("/api/safety-drill/:drillId/acknowledge", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const drillId = req.params.drillId;

      const ackResult = await db.transaction(async (tx) => {
        const lockResult = await tx.execute(sql`SELECT id, user_id, status, is_drill, started_at, drill_responses, drill_acknowledged_by_contact_id FROM incidents WHERE id = ${drillId} FOR UPDATE`);
        const locked: any = (lockResult as any).rows?.[0];
        if (!locked || !locked.is_drill) return { error: { status: 404, body: { error: "This safety test is no longer available." } } };
        if (locked.status !== "open") return { error: { status: 400, body: { error: "This safety test has already finished." } } };

        const contactList = await storage.getContacts(locked.user_id);
        const watcherContact = contactList.find(c => c.linkedUserId === userId);
        if (!watcherContact) return { error: { status: 403, body: { error: "Not a linked watcher for this user" } } };

        let responses: Array<{ contactId: string; contactName: string; role: string; respondedAt: string; responseTimeMs: number }> = [];
        try {
          const parsed = JSON.parse(locked.drill_responses || "[]");
          responses = Array.isArray(parsed)
            ? parsed.filter((r: any) => r && typeof r === "object" && typeof r.contactId === "string")
            : [];
        } catch {
          responses = [];
        }
        if (responses.some(r => r.contactId === watcherContact.id)) {
          return { error: { status: 400, body: { error: "You've already confirmed for this drill.", alreadyAcknowledged: true } } };
        }

        const respondedAt = new Date();
        const startedAtMs = locked.started_at ? new Date(locked.started_at).getTime() : respondedAt.getTime();
        responses.push({
          contactId: watcherContact.id,
          contactName: watcherContact.name,
          role: (watcherContact.circleRole as string) || "primary",
          respondedAt: respondedAt.toISOString(),
          responseTimeMs: Math.max(0, respondedAt.getTime() - startedAtMs),
        });

        const updates: any = { drillResponses: JSON.stringify(responses) };
        if (!locked.drill_acknowledged_by_contact_id) {
          updates.drillAcknowledgedAt = respondedAt;
          updates.drillAcknowledgedByContactId = watcherContact.id;
        }
        await tx.update(incidents).set(updates).where(eq(incidents.id, drillId));
        return { ok: { drillUserId: locked.user_id as string, watcherContact, responses, respondedAt } };
      });

      if ("error" in ackResult && ackResult.error) {
        return res.status(ackResult.error.status).json(ackResult.error.body);
      }
      const okResult = (ackResult as any).ok;
      const drill = { id: drillId, userId: okResult.drillUserId };
      const watcherContact = okResult.watcherContact;
      const responses = okResult.responses;
      const respondedAt: Date = okResult.respondedAt;
      const watcherUser = await storage.getUser(userId);
      const watcherName = watcherUser?.name || watcherContact.name;

      await sendPushNotification(drill.userId, {
        title: "Guardian ready",
        body: `${watcherName} confirmed they're ready. Your Safety Circle is prepared.`,
        url: `/safety-circle/drill?id=${drillId}`,
        tag: `drill-ack-${drillId}`,
      });

      const io = (req as any).io;
      if (io) {
        io.to(`user:${drill.userId}`).emit("drill:acknowledged", {
          drillId,
          acknowledgedBy: watcherName,
          acknowledgedAt: respondedAt.toISOString(),
          responseCount: responses.length,
        });
      }

      console.log(`[DRILL] Acknowledged by ${userId} for drill ${drillId} (response ${responses.length})`);
      res.json({ success: true, responseCount: responses.length });
    } catch (error) {
      console.error("Error acknowledging drill:", error);
      res.status(500).json({ error: "Failed to acknowledge drill" });
    }
  });

  app.get("/api/safety-drill/:drillId", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const drillId = req.params.drillId;
      const [drill] = await db.select().from(incidents).where(eq(incidents.id, drillId)).limit(1);
      if (!drill || !drill.isDrill) return res.status(404).json({ error: "Drill not found" });

      const isOwner = drill.userId === userId;
      let isLinkedWatcher = false;
      if (!isOwner) {
        const contactList = await storage.getContacts(drill.userId);
        isLinkedWatcher = contactList.some(c => c.linkedUserId === userId);
      }
      if (!isOwner && !isLinkedWatcher) return res.status(403).json({ error: "Forbidden" });

      let responses: Array<{ contactId: string; contactName: string; role: string; respondedAt: string; responseTimeMs: number }> = [];
      try {
        const parsed = JSON.parse(drill.drillResponses || "[]");
        responses = Array.isArray(parsed) ? parsed.filter(r => r && typeof r === "object" && r.contactId) : [];
      } catch { responses = [] }

      const allContacts = await storage.getContacts(drill.userId);
      const watchersWithLink = allContacts.filter(c => c.linkedUserId);

      const guardians = watchersWithLink.map(c => {
        const r = responses.find(x => x.contactId === c.id);
        return {
          contactId: c.id,
          name: c.name,
          role: c.circleRole,
          responded: !!r,
          respondedAt: r?.respondedAt || null,
          responseTimeMs: r?.responseTimeMs || null,
        };
      });

      res.json({
        drillId: drill.id,
        status: drill.status,
        startedAt: drill.startedAt,
        resolvedAt: drill.resolvedAt,
        guardians,
        totalGuardians: watchersWithLink.length,
        respondedCount: responses.length,
      });
    } catch (error) {
      console.error("Error fetching drill:", error);
      res.status(500).json({ error: "Failed to fetch drill" });
    }
  });

  app.get("/api/safety-circle/readiness", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const contactList = await storage.getContacts(userId);
      const now = Date.now();

      // Pull recent drill acks (last 30 days) so we can credit guardians who confirmed
      // a drill even if they haven't sent a heartbeat. Drill acks are the strongest
      // signal that a guardian is reachable and responsive.
      const drillCutoff = new Date(now - 30 * 24 * 60 * 60 * 1000);
      const recentDrills = await db
        .select({ drillResponses: incidents.drillResponses })
        .from(incidents)
        .where(and(eq(incidents.userId, userId), eq(incidents.isDrill, true), gte(incidents.startedAt, drillCutoff)));
      const lastAckByContact = new Map<string, number>();
      for (const d of recentDrills) {
        try {
          const responses = JSON.parse(d.drillResponses || "[]");
          if (Array.isArray(responses)) {
            for (const r of responses) {
              if (r && typeof r === "object" && typeof r.contactId === "string" && typeof r.respondedAt === "string") {
                const t = Date.parse(r.respondedAt);
                if (!isNaN(t)) {
                  const prev = lastAckByContact.get(r.contactId) || 0;
                  if (t > prev) lastAckByContact.set(r.contactId, t);
                }
              }
            }
          }
        } catch { /* ignore malformed JSON */ }
      }

      const guardians = await Promise.all(contactList.map(async (c) => {
        let lastActiveAt: string | null = null;
        let readiness: "ready" | "idle" | "needs_attention" | "unknown" = "unknown";
        let lastActiveSource: "heartbeat" | "drill" | null = null;

        if (c.linkedUserId) {
          const linkedUser = await storage.getUser(c.linkedUserId);
          const heartbeatMs = linkedUser?.lastHeartbeatAt ? new Date(linkedUser.lastHeartbeatAt).getTime() : 0;
          const drillAckMs = lastAckByContact.get(c.id) || 0;
          const mostRecent = Math.max(heartbeatMs, drillAckMs);

          if (mostRecent > 0) {
            lastActiveAt = new Date(mostRecent).toISOString();
            lastActiveSource = drillAckMs >= heartbeatMs ? "drill" : "heartbeat";
            const ageMs = now - mostRecent;
            if (ageMs < 24 * 60 * 60 * 1000) readiness = "ready";
            else if (ageMs < 7 * 24 * 60 * 60 * 1000) readiness = "idle";
            else readiness = "needs_attention";
          }
        }
        return {
          id: c.id,
          name: c.name,
          phone: c.phone,
          role: (c.circleRole as string) || "primary",
          linked: !!c.linkedUserId,
          readiness,
          lastActiveAt,
          lastActiveSource,
        };
      }));
      const ready = guardians.filter(g => g.readiness === "ready").length;
      res.json({
        guardians,
        totalCount: guardians.length,
        readyCount: ready,
      });
    } catch (error) {
      console.error("Error fetching circle readiness:", error);
      res.status(500).json({ error: "Failed to fetch readiness" });
    }
  });

  app.get("/api/heartbeat/recommended-interval", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      const battery = user.batteryLevel ?? 100;
      const charging = user.batteryCharging ?? false;
      let intervalMs = 60000;
      let reason = "normal";
      if (battery < 10 && !charging) {
        intervalMs = 300000;
        reason = "critical_battery";
      } else if (battery < 30 && !charging) {
        intervalMs = 120000;
        reason = "low_battery";
      } else if (charging) {
        intervalMs = 60000;
        reason = "charging";
      }
      res.json({ intervalMs, reason });
    } catch (error) {
      res.status(500).json({ error: "Failed to get interval" });
    }
  });

  // Save contacts (supports both legacy 2-contact format and new array format)
  app.post("/api/contacts", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }

      const contactLimit = await storage.getContactLimit(userId);

      // New array format: { contacts: [{ name, phone, priority }] }
      if (req.body.contacts && Array.isArray(req.body.contacts)) {
        const contactsList = req.body.contacts as { name: string; phone: string; email?: string | null; priority: number }[];
        
        if (contactsList.length === 0) {
          return res.status(400).json({ error: "At least one contact is required" });
        }
        if (contactsList.length > contactLimit) {
          return res.status(403).json({ error: `Free plan allows ${contactLimit} contacts. Upgrade to premium for unlimited contacts.`, contactLimit });
        }
        for (const c of contactsList) {
          if (!c.name?.trim() || !c.phone?.trim()) {
            return res.status(400).json({ error: "Each contact must have a name and phone number" });
          }
        }

        const ownerUser = await storage.getUser(userId);
        const savedContacts = await storage.saveContactsList(userId, contactsList.map((c, i) => ({
          name: c.name.trim(),
          phone: normalizePhone(c.phone),
          email: c.email?.trim() || null,
          priority: c.priority || (i + 1),
        })));

        for (const contact of savedContacts) {
          const normalizedContactPhone = normalizePhone(contact.phone);
          const linkedUser = await storage.getUserByPhone(normalizedContactPhone);
          if (linkedUser && linkedUser.id !== userId) {
            await storage.linkContactToUser(contact.id, linkedUser.id);
            const roleLabel = contact.priority === 1 ? "Primary" : contact.priority === 2 ? "Backup" : "Support";
            await sendPushNotification(linkedUser.id, {
              title: "You're now a guardian",
              body: `${ownerUser?.name || "Someone"} added you as their ${roleLabel} Guardian. If we can't reach them, we'll guide you. You won't need to figure anything out.`,
              url: "/watched",
              tag: `guardian-briefing-${contact.id}`,
            });
            console.log(`[GUARDIAN] Briefing sent to ${linkedUser.name} (${roleLabel}) for ${ownerUser?.name}`);
          } else {
            await storage.linkContactToUser(contact.id, null);
          }
        }

        if (!ownerUser?.setupConfirmedAt && savedContacts.length > 0) {
          await db.update(users).set({ setupConfirmedAt: new Date() }).where(eq(users.id, userId));
          const primaryContact = savedContacts[0];
          await sendPushNotification(userId, {
            title: "You're protected",
            body: `${primaryContact.name} is now watching over you. You're all set.`,
            url: "/",
            tag: "setup-confirmed",
          });
          console.log(`[SETUP] Confirmation sent to ${ownerUser?.name}`);
        }

        const updatedContacts = await storage.getContacts(userId);

        const tokens = await storage.getContactTokensForUser(userId);
        if (tokens.length > 0) {
          console.log(`[CONTACTS] ${tokens.length} contact token(s) generated`);
        }

        return res.json({ success: true, contacts: updatedContacts });
      }

      // Legacy 2-contact format
      const { contact1Name, contact1Phone, contact2Name, contact2Phone } = req.body;
      
      if (!contact1Name || !contact1Phone) {
        return res.status(400).json({ error: "Contact 1 is required" });
      }
      
      const savedContacts = await storage.upsertContacts(userId, {
        contact1: {
          name: contact1Name,
          phone: normalizePhone(contact1Phone),
          priority: 1,
          canViewLocation: true,
        },
        contact2: contact2Name && contact2Phone ? {
          name: contact2Name,
          phone: normalizePhone(contact2Phone),
          priority: 2,
          canViewLocation: true,
        } : undefined,
      });
      
      const tokens = await storage.getContactTokensForUser(userId);
      if (tokens.length > 0) {
        console.log(`[CONTACTS] ${tokens.length} contact token(s) generated`);
      }
      
      res.json({ success: true, contacts: savedContacts });
    } catch (error) {
      console.error("Error saving contacts:", error);
      res.status(500).json({ error: "Failed to save contacts" });
    }
  });

  // Run test
  app.post("/api/test", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      
      // Create test incident
      const incident = await storage.createIncident(userId, "test");
      
      // Get contacts
      const contacts = await storage.getContacts(userId);
      
      // Get user
      const user = await storage.getUser(userId);
      
      // Send test SMS to all contacts in parallel
      console.log("\n[TEST] Sending test notifications...");
      await Promise.all(contacts.map(contact => 
        sendTestMessage(contact.phone, user?.name || "User")
      ));
      console.log("[TEST] Notifications sent\n");
      
      // Immediately resolve the test incident
      await storage.updateIncident(incident.id, {
        status: "resolved",
        resolvedAt: new Date(),
      });
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error running test:", error);
      res.status(500).json({ error: "Failed to run test" });
    }
  });

  // ============================================
  // WEARABLE / WATCH ENDPOINTS (token auth via header)
  // ============================================

  app.post("/api/checkin/quick", async (req, res) => {
    try {
      const token = req.headers["authorization"]?.replace("Bearer ", "");
      if (!token) {
        return res.status(401).json({ error: "Missing Authorization header" });
      }
      const result = await getUserFromSession(token);
      if (!result) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }
      let location: { lat?: number; lng?: number; timezone?: string } = {};
      if (req.body?.lat != null && req.body?.lng != null) {
        const lat = parseFloat(req.body.lat);
        const lng = parseFloat(req.body.lng);
        if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
          location.lat = lat;
          location.lng = lng;
        }
      }
      if (req.body?.timezone && typeof req.body.timezone === "string" && req.body.timezone.length <= 100) {
        location.timezone = req.body.timezone;
      }
      const hasLocation = location.lat != null || location.timezone;
      const checkin = await storage.createCheckin(result.userId, "auto", hasLocation ? location as any : undefined);
      await storage.resetReminderState(result.userId);

      const wearUser = await storage.getUser(result.userId);
      if (wearUser && (wearUser.safetyState === "concern" || wearUser.safetyState === "quiet")) {
        await resolveCheckin(result.userId, "app", { skipCreateCheckin: true });
      } else {
        const openInc = await storage.getOpenIncident(result.userId);
        if (openInc) {
          await resolveCheckin(result.userId, "app", { skipCreateCheckin: true });
        }
      }

      res.json({ ok: true, checkinId: checkin.id, at: checkin.createdAt });
    } catch (error) {
      console.error("Error in quick checkin:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.get("/api/status/simple", async (req, res) => {
    try {
      const token = req.headers["authorization"]?.replace("Bearer ", "");
      if (!token) {
        return res.status(401).json({ error: "Missing Authorization header" });
      }
      const result = await getUserFromSession(token);
      if (!result) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }
      const status = await storage.getUserStatus(result.userId);
      const incident = await storage.getOpenIncident(result.userId);
      const isOverdue = status.nextCheckinDue ? new Date() > new Date(status.nextCheckinDue) : false;
      res.json({
        ok: true,
        name: result.user.name,
        lastCheckin: status.lastCheckin?.createdAt || null,
        nextDue: status.nextCheckinDue || null,
        isOverdue,
        hasActiveIncident: !!incident,
      });
    } catch (error) {
      console.error("Error in simple status:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  // ============================================
  // HEART RATE ENDPOINTS (wearable token auth)
  // ============================================

  app.post("/api/heartrate", async (req, res) => {
    try {
      const token = req.headers["authorization"]?.replace("Bearer ", "");
      if (!token) {
        return res.status(401).json({ error: "Missing Authorization header" });
      }
      const result = await getUserFromSession(token);
      if (!result) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      const { readings } = req.body;
      if (!Array.isArray(readings) || readings.length === 0) {
        return res.status(400).json({ error: "readings array required" });
      }
      if (readings.length > 100) {
        return res.status(400).json({ error: "Max 100 readings per request" });
      }

      const validated = [];
      for (const r of readings) {
        const bpm = Number(r.bpm);
        if (!Number.isInteger(bpm) || bpm < 20 || bpm > 300) {
          continue;
        }
        const recordedAt = new Date(r.recordedAt);
        if (isNaN(recordedAt.getTime())) {
          continue;
        }
        const allowedSources = ["watch", "phone", "manual"];
        const source = allowedSources.includes(r.source) ? r.source : "watch";
        validated.push({ bpm, recordedAt, source });
      }

      if (validated.length === 0) {
        return res.status(400).json({ error: "No valid readings" });
      }

      const saved = await storage.saveHeartRateReadings(result.userId, validated);

      const latestBpm = validated[validated.length - 1].bpm;
      let alert = null;
      if (latestBpm > 120) {
        const existing = await storage.getActiveHeartRateAlerts(result.userId);
        const hasHighAlert = existing.some(a => a.alertType === "high");
        if (!hasHighAlert) {
          alert = await storage.createHeartRateAlert(result.userId, "high", latestBpm);
          console.log(`[HeartRate] HIGH alert for user (bpm: ${latestBpm})`);
        }
      } else if (latestBpm < 40) {
        const existing = await storage.getActiveHeartRateAlerts(result.userId);
        const hasLowAlert = existing.some(a => a.alertType === "low");
        if (!hasLowAlert) {
          alert = await storage.createHeartRateAlert(result.userId, "low", latestBpm);
          console.log(`[HeartRate] LOW alert for user (bpm: ${latestBpm})`);
        }
      }

      res.json({ ok: true, saved: saved.length, alert: alert ? alert.alertType : null });
    } catch (error) {
      console.error("Error saving heart rate:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.get("/api/heartrate/latest", async (req, res) => {
    try {
      const token = req.headers["authorization"]?.replace("Bearer ", "");
      if (!token) {
        return res.status(401).json({ error: "Missing Authorization header" });
      }
      const result = await getUserFromSession(token);
      if (!result) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      const latest = await storage.getLatestHeartRate(result.userId);
      const alerts = await storage.getActiveHeartRateAlerts(result.userId);

      res.json({
        ok: true,
        heartRate: latest ? { bpm: latest.bpm, recordedAt: latest.recordedAt, source: latest.source } : null,
        alerts: alerts.map(a => ({ id: a.id, type: a.alertType, bpm: a.bpm, createdAt: a.createdAt })),
      });
    } catch (error) {
      console.error("Error getting heart rate:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.get("/api/heartrate/history", async (req, res) => {
    try {
      const token = req.headers["authorization"]?.replace("Bearer ", "");
      if (!token) {
        return res.status(401).json({ error: "Missing Authorization header" });
      }
      const result = await getUserFromSession(token);
      if (!result) {
        return res.status(401).json({ error: "Invalid or expired token" });
      }

      const rawHours = Number(req.query.hours) || 24;
      const hours = Math.max(1, Math.min(rawHours, 168));
      const history = await storage.getHeartRateHistory(result.userId, hours);

      const limitedHistory = history.slice(0, 500);

      res.json({
        ok: true,
        readings: limitedHistory.map(r => ({ bpm: r.bpm, recordedAt: r.recordedAt, source: r.source })),
        count: limitedHistory.length,
        total: history.length,
      });
    } catch (error) {
      console.error("Error getting heart rate history:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  // ============================================
  // PUBLIC ROUTES (no auth required)
  // ============================================

  const emergencyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
  });

  // Contact page - get data
  app.get("/api/emergency/:token", emergencyLimiter, async (req, res) => {
    try {
      const token = req.params.token as string;
      const data = await storage.getContactPageData(token);
      
      if (!data) {
        return res.status(404).json({ error: "Invalid or expired link" });
      }
      
      res.json(data);
    } catch (error) {
      console.error("Error getting contact page data:", error);
      res.status(500).json({ error: "Failed to get data" });
    }
  });

  // Contact takes responsibility
  app.post("/api/emergency/:token/handle", emergencyLimiter, async (req, res) => {
    try {
      const token = req.params.token as string;
      const data = await storage.getContactPageData(token);
      
      if (!data) {
        return res.status(404).json({ error: "Invalid or expired link" });
      }
      
      if (!data.incident || data.incident.status === "resolved") {
        return res.status(400).json({ error: "No active incident" });
      }
      
      // Update incident
      const incident = await storage.updateIncident(data.incident.id, {
        status: "paused",
        handledByContactId: data.contact.id,
        nextActionAt: addMinutes(new Date(), 45),
      });
      
      console.log(`[INCIDENT] Contact handling incident for user`);
      
      // User will see in-app banner that contact responded (no SMS needed)
      
      res.json({ success: true, incident });
    } catch (error) {
      console.error("Error handling incident:", error);
      res.status(500).json({ error: "Failed to handle incident" });
    }
  });

  // Contact escalates (manual escalation - "I can't help")
  app.post("/api/emergency/:token/escalate", emergencyLimiter, async (req, res) => {
    try {
      const token = req.params.token as string;
      const data = await storage.getContactPageData(token);
      
      if (!data) {
        return res.status(404).json({ error: "Invalid or expired link" });
      }
      
      if (!data.incident || data.incident.status === "resolved") {
        return res.status(400).json({ error: "No active incident" });
      }
      
      const now = new Date();
      
      const contacts = await storage.getContacts(data.user.id);
      const tokens = await storage.getContactTokensForUser(data.user.id);
      const baseUrl = getBaseUrl();
      const sortedContacts = [...contacts].sort((a, b) => a.priority - b.priority);
      const firstContact = sortedContacts[0];

      const escalateSettings = await storage.getSettings(data.user.id);
      const incident = await storage.updateIncident(data.incident.id, {
        status: "open",
        handledByContactId: null,
        escalationLevel: 1,
        notifiedContactIds: JSON.stringify(firstContact ? [firstContact.id] : []),
        lastContactNotifiedAt: now,
        allContactsNotifiedAt: null,
        userNotifiedNoResponseAt: null,
        contact1NotifiedAt: now,
        contact2NotifiedAt: null,
        nextActionAt: addMinutes(now, escalateSettings?.escalationMinutes || 20),
      });
      
      console.log(`[INCIDENT] Contact escalated incident for user`);
      
      if (firstContact) {
        const tokenData = tokens.find(t => t.contact.id === firstContact.id);
        if (tokenData) {
          const link = `${baseUrl}/emergency/${tokenData.token}`;
          console.log(`[ESCALATION] Re-notifying Contact #${firstContact.priority}`);
          const reason = data.incident!.reason as "sos" | "missed_checkin";
          const smsFn = reason === "sos" ? sendSosAlert : sendMissedCheckinAlert;
          await notifyContact(firstContact, data.user.name, link, reason, smsFn);
          console.log("[ESCALATION] Contact re-notified, escalation will continue via cron\n");
        }
      }
      
      res.json({ success: true, incident });
    } catch (error) {
      console.error("Error escalating:", error);
      res.status(500).json({ error: "Failed to escalate" });
    }
  });

  // Location update (requires auth)
  app.post("/api/location/update", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const { lat, lng, accuracy } = req.body;
      
      const session = await storage.getActiveLocationSession(userId);
      if (!session) {
        return res.status(400).json({ error: "No active location session" });
      }
      
      const updated = await storage.updateLocationSession(session.id, lat, lng, accuracy);
      res.json({ success: true, session: updated });
    } catch (error) {
      console.error("Error updating location:", error);
      res.status(500).json({ error: "Failed to update location" });
    }
  });

  // ============================================
  // PUSH NOTIFICATION ROUTES
  // ============================================

  app.get("/api/push/vapid-key", (req, res) => {
    res.json({ key: getVapidPublicKey(), configured: isPushConfigured() });
  });

  app.post("/api/push/subscribe", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }

      const { subscription } = req.body;
      if (!subscription || !subscription.endpoint || !subscription.keys) {
        return res.status(400).json({ error: "Invalid push subscription" });
      }

      await storage.savePushSubscription(
        userId,
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth
      );

      console.log(`[PUSH] Subscription saved for user ${userId}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving push subscription:", error);
      res.status(500).json({ error: "Failed to save subscription" });
    }
  });

  app.post("/api/push/unsubscribe", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }

      const { endpoint } = req.body;
      if (!endpoint) {
        return res.status(400).json({ error: "Endpoint is required" });
      }

      await storage.deletePushSubscriptionForUser(userId, endpoint);
      console.log(`[PUSH] Subscription removed for user ${userId}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Error removing push subscription:", error);
      res.status(500).json({ error: "Failed to remove subscription" });
    }
  });

  // ============================================
  // VOIP TOKEN REGISTRATION
  // ============================================

  app.post("/api/voip-token", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const { token, platform } = req.body;
      if (!token || !platform || !["ios", "android"].includes(platform)) {
        return res.status(400).json({ error: "Invalid token or platform" });
      }
      await storage.saveVoipToken(userId, token, platform);
      console.log(`[VOIP] Token registered for ${userId} (${platform})`);
      res.json({ success: true });
    } catch (error) {
      console.error("[VOIP] Token registration error:", error);
      res.status(500).json({ error: "Failed to register token" });
    }
  });

  app.delete("/api/voip-token", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const { token } = req.body;
      if (!token) {
        return res.status(400).json({ error: "Token required" });
      }
      await storage.deleteVoipToken(userId, token);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete token" });
    }
  });

  // ============================================
  // TURN CREDENTIALS FOR VIDEO CALLS
  // ============================================

  app.get("/api/turn-credentials", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const iceServers = await getTurnCredentials();
      console.log(`[TURN] Serving ${iceServers.length} ICE servers to ${userId}: ${iceServers.map((s: any) => typeof s.urls === 'string' ? s.urls.split('?')[0] : s.urls?.[0]?.split('?')[0]).join(', ')}`);
      res.json({ iceServers });
    } catch (error) {
      console.error("Error fetching TURN credentials:", error);
      res.json({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
        ],
      });
    }
  });

  // ============================================
  // WATCHER & MESSAGING ROUTES
  // ============================================

  // Throttle the alert/system endpoints separately from regular chat
  // (10 SOS broadcasts per 5 min, 60 system messages per 5 min  -  generous
  // for legit safety use, restrictive enough to prevent spam abuse).
  // Defined here so all messaging routes below can reference them.
  const sosLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many SOS attempts. Please wait before trying again." },
  });
  const systemMessageLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many safety messages. Please wait before sending more." },
  });

  // Per-user dedupe window for SOS broadcasts: a single user cannot fire a
  // fresh SOS more than once every 60 seconds.
  const SOS_DEDUPE_MS = 60 * 1000;
  const recentSosByUser = new Map<string, { at: number; sentCount: number }>();

  // Presence: returns whether the target user is online (active socket OR
  // recent heartbeat within last 2 min) plus a last-seen timestamp.
  // Used by the chat header to show "Active now" / "Last seen 5m ago".
  app.get("/api/users/:userId/presence", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const targetUserId = req.params.userId;
      // Auth: must share a Safety Circle relationship
      if (currentUserId !== targetUserId) {
        const myContacts = await storage.getContacts(currentUserId);
        const theirContacts = await storage.getContacts(targetUserId);
        const hasRelationship =
          myContacts.some((c) => c.linkedUserId === targetUserId) ||
          theirContacts.some((c) => c.linkedUserId === currentUserId);
        if (!hasRelationship) return res.status(403).json({ error: "Not authorized" });
      }

      const { isUserOnline } = await import("./socket");
      const target = await storage.getUser(targetUserId);
      if (!target) return res.status(404).json({ error: "User not found" });

      const socketOnline = isUserOnline(targetUserId);
      const lastHeartbeat = target.lastHeartbeatAt ? new Date(target.lastHeartbeatAt) : null;
      const heartbeatRecent = lastHeartbeat ? Date.now() - lastHeartbeat.getTime() < 2 * 60 * 1000 : false;

      res.json({
        online: socketOnline || heartbeatRecent,
        lastSeenAt: lastHeartbeat ? lastHeartbeat.toISOString() : null,
      });
    } catch (error) {
      console.error("Error getting presence:", error);
      res.status(500).json({ error: "Failed to get presence" });
    }
  });

  // Atomic "Share live location with this person" action: starts a real live
  // location session for the requested duration AND posts a structured system
  // message into the conversation so the recipient sees a beautiful card with
  // live status + Open-in-Maps + countdown  -  not a raw URL.
  app.post("/api/messages/:userId/share-location", systemMessageLimiter, async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const receiverId = req.params.userId;
      const { lat, lng, accuracy, durationMinutes } = req.body || {};

      // Sharing location with yourself is meaningless and would be confusing,
      // so reject it cleanly rather than letting a self-row through.
      if (receiverId === currentUserId) {
        return res.status(400).json({ error: "Cannot share location with yourself" });
      }
      if (typeof lat !== "number" || typeof lng !== "number" || isNaN(lat) || isNaN(lng)) {
        return res.status(400).json({ error: "lat and lng are required and must be numbers" });
      }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return res.status(400).json({ error: "lat/lng out of range" });
      }
      const duration = Math.min(Math.max(parseInt(durationMinutes ?? 30, 10) || 30, 5), 240);

      const myContacts = await storage.getContacts(currentUserId);
      const theirContacts = await storage.getContacts(receiverId);
      const hasRelationship =
        myContacts.some((c) => c.linkedUserId === receiverId) ||
        theirContacts.some((c) => c.linkedUserId === currentUserId);
      if (!hasRelationship) {
        return res.status(403).json({ error: "Not authorized to share location with this user" });
      }

      // Reuse the existing live-location infrastructure so the recipient can
      // open the standard /watched live view and see real updates.
      const expiresAt = new Date(Date.now() + duration * 60 * 1000);
      let share: any = null;
      let liveSessionFailed = false;
      try {
        share = await storage.startLiveLocationShare(currentUserId, expiresAt);
        // Seed the share with the current location so the watcher sees a pin immediately
        await storage.updateLiveLocation(
          share.id,
          currentUserId,
          lat,
          lng,
          typeof accuracy === "number" ? accuracy : null,
          null,
          null,
          null,
        );
      } catch (err: any) {
        console.error("[SHARE-LOC] live-location session creation failed:", err?.message || err);
        liveSessionFailed = true;
        // Continue  -  we still post a message card with the snapshot location,
        // but mark it as stopped + fallback so the UI doesn't pretend it's live.
      }

      const sender = await storage.getUser(currentUserId);
      const senderName = sender?.name || "Someone";
      // If the live session failed, mark the card as stopped/fallback so the
      // recipient sees a static location snapshot, not a fake pulsing "Live" badge.
      const meta: Record<string, any> = {
        kind: "live_location" as const,
        lat,
        lng,
        accuracy: typeof accuracy === "number" ? accuracy : null,
        shareId: share?.id || null,
        expiresAt: liveSessionFailed ? new Date(0).toISOString() : expiresAt.toISOString(),
        durationMinutes: duration,
        ...(liveSessionFailed ? { stopped: true, fallback: true } : {}),
      };

      const msg = await storage.saveMessage(
        currentUserId,
        receiverId,
        liveSessionFailed
          ? `${senderName} shared a snapshot of their location.`
          : `${senderName} is sharing their live location for ${duration} minutes.`,
        { messageType: "system_info", meta },
      );

      const { emitToUser } = await import("./socket");
      emitToUser(receiverId, "message:new", { ...msg, senderName });
      emitToUser(currentUserId, "message:sent", msg);

      res.json(msg);
    } catch (error) {
      console.error("Error sharing live location in chat:", error);
      res.status(500).json({ error: "Failed to share live location" });
    }
  });

  app.get("/api/users/:userId/profile", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const targetUserId = req.params.userId;
      if (currentUserId === targetUserId) {
        const user = await storage.getUser(targetUserId);
        if (!user) return res.status(404).json({ error: "User not found" });
        return res.json({ id: user.id, name: user.name });
      }
      const myContacts = await storage.getContacts(currentUserId);
      const hasAsContact = myContacts.some(c => c.linkedUserId === targetUserId);
      if (!hasAsContact) {
        const theirContacts = await storage.getContacts(targetUserId);
        const isContactOf = theirContacts.some(c => c.linkedUserId === currentUserId);
        if (!isContactOf) {
          return res.status(403).json({ error: "Not authorized" });
        }
      }
      const user = await storage.getUser(targetUserId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json({ id: user.id, name: user.name });
    } catch (error) {
      console.error("Error fetching user profile:", error);
      res.status(500).json({ error: "Failed to fetch user profile" });
    }
  });

  app.get("/api/conversations", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const conversations = await storage.getConversations(userId);
      res.json(conversations);
    } catch (error) {
      console.error("Error getting conversations:", error);
      res.status(500).json({ error: "Failed to get conversations" });
    }
  });

  app.post("/api/users/public-key", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const { publicKey } = req.body;
      if (!publicKey || typeof publicKey !== "string" || publicKey.length > 2000) {
        return res.status(400).json({ error: "Invalid public key" });
      }
      await storage.updateUser(userId, { publicKey } as any);
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving public key:", error);
      res.status(500).json({ error: "Failed to save public key" });
    }
  });

  app.get("/api/messages/unread/count", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const count = await storage.getUnreadCount(userId);
      res.json({ count });
    } catch (error) {
      console.error("Error getting unread count:", error);
      res.status(500).json({ error: "Failed to get unread count" });
    }
  });

  app.get("/api/watched-users", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const watched = await storage.getWatchedUsers(userId);
      res.json(watched);
    } catch (error) {
      console.error("Error fetching watched users:", error);
      res.status(500).json({ error: "Failed to fetch watched users" });
    }
  });

  app.post("/api/watched-users/:contactId/opt-out", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const { contactId } = req.params;
      const contact = await storage.getContact(contactId);
      if (!contact) {
        return res.status(404).json({ error: "Contact not found" });
      }
      if (contact.linkedUserId !== userId) {
        return res.status(403).json({ error: "Not authorized" });
      }
      if (contact.softDeletedAt) {
        return res.status(400).json({ error: "Already removed" });
      }
      const updated = await storage.softDeleteContact(contactId, "watcher");
      const owner = await storage.getUser(contact.userId);
      const watcher = await storage.getUser(userId);
      if (owner) {
        const { emitToUser } = await import("./socket");
        emitToUser(contact.userId, "contact:opted-out", {
          contactId,
          contactName: watcher?.name || contact.name,
        });
        await sendPushNotification(contact.userId, {
          title: "Emergency Contact Update",
          body: `${watcher?.name || contact.name} has removed themselves as your emergency contact. We recommend adding a replacement to keep your safety network active.`,
          url: "/settings",
          tag: "contact-opted-out",
        });
      }
      res.json({ success: true, contact: updated });
    } catch (error) {
      console.error("Error opting out:", error);
      res.status(500).json({ error: "Failed to opt out" });
    }
  });

  app.get("/api/watched-users/removed", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const removed = await storage.getSoftDeletedContactsByWatcher(userId);
      res.json(removed);
    } catch (error) {
      console.error("Error fetching removed contacts:", error);
      res.status(500).json({ error: "Failed to fetch removed contacts" });
    }
  });

  app.post("/api/watched-users/:contactId/restore", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const { contactId } = req.params;
      const contact = await storage.getContact(contactId);
      if (!contact) {
        return res.status(404).json({ error: "Contact not found" });
      }
      if (contact.linkedUserId !== userId) {
        return res.status(403).json({ error: "Not authorized" });
      }
      if (!contact.softDeletedAt) {
        return res.status(400).json({ error: "Contact is not removed" });
      }
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      if (contact.softDeletedAt < thirtyDaysAgo) {
        return res.status(410).json({ error: "Removal has expired and cannot be reversed" });
      }
      const updated = await storage.restoreContact(contactId);
      res.json({ success: true, contact: updated });
    } catch (error) {
      console.error("Error restoring contact:", error);
      res.status(500).json({ error: "Failed to restore" });
    }
  });

  app.get("/api/contacts/removed", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const removed = await storage.getSoftDeletedContacts(userId);
      res.json(removed);
    } catch (error) {
      console.error("Error fetching removed contacts:", error);
      res.status(500).json({ error: "Failed to fetch removed contacts" });
    }
  });

  app.post("/api/contacts/:contactId/restore", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const { contactId } = req.params;
      const contact = await storage.getContact(contactId);
      if (!contact) {
        return res.status(404).json({ error: "Contact not found" });
      }
      if (contact.userId !== userId) {
        return res.status(403).json({ error: "Not authorized" });
      }
      if (!contact.softDeletedAt) {
        return res.status(400).json({ error: "Contact is not removed" });
      }
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      if (contact.softDeletedAt < thirtyDaysAgo) {
        return res.status(410).json({ error: "Removal has expired and cannot be reversed" });
      }
      const activeContacts = await storage.getContacts(userId);
      const contactLimit = await storage.getContactLimit(userId);
      if (activeContacts.length >= contactLimit) {
        return res.status(409).json({ error: "Contact limit reached. Remove an existing contact before restoring." });
      }
      const priorityConflict = activeContacts.find(c => c.priority === contact.priority);
      if (priorityConflict) {
        const nextPriority = activeContacts.length + 1;
        contact.priority = nextPriority;
      }
      const updated = await storage.restoreContact(contactId);
      res.json({ success: true, contact: updated });
    } catch (error) {
      console.error("Error restoring contact:", error);
      res.status(500).json({ error: "Failed to restore" });
    }
  });

  app.get("/api/messages/:userId", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const otherUserId = req.params.userId;
      const msgs = await storage.getMessages(currentUserId, otherUserId);
      res.json(msgs);
    } catch (error) {
      console.error("Error fetching messages:", error);
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  });

  // Broadcast a system_alert message to every member of the user's Safety Circle.
  // Used by the in-chat "Trigger SOS" quick action  -  also triggers the standard
  // SOS incident pipeline if one is not already open. MUST be registered before
  // POST /api/messages/:userId so Express does not match "sos" as a userId param.
  app.post("/api/messages/sos", sosLimiter, async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }

      // Dedupe: if this user fired an SOS within the last 60s, do not re-broadcast.
      const recent = recentSosByUser.get(userId);
      if (recent && Date.now() - recent.at < SOS_DEDUPE_MS) {
        return res.json({
          success: true,
          sentCount: recent.sentCount,
          deduped: true,
          retryAfterMs: SOS_DEDUPE_MS - (Date.now() - recent.at),
        });
      }

      const user = await storage.getUser(userId);
      const userName = user?.name || "Someone";

      // Broadcast a system_alert to every linked Safety Circle member
      const contacts = await storage.getContacts(userId);
      const linked = contacts.filter((c) => c.linkedUserId);
      const alertContent = `${userName} triggered an SOS. They need help right now.`;
      const meta = { kind: "sos", triggeredAt: new Date().toISOString() };

      const { emitToUser } = await import("./socket");
      const created: any[] = [];
      for (const contact of linked) {
        try {
          const msg = await storage.saveMessage(userId, contact.linkedUserId!, alertContent, {
            messageType: "system_alert",
            meta,
          });
          emitToUser(contact.linkedUserId!, "message:new", { ...msg, senderName: userName });
          emitToUser(userId, "message:sent", msg);
          created.push(msg);
        } catch (err: any) {
          console.error(`[SOS-MSG] Failed for contact ${contact.id}:`, err?.message || err);
        }
      }

      recentSosByUser.set(userId, { at: Date.now(), sentCount: created.length });

      // Trigger the standard SOS incident flow (idempotent  -  will no-op if already open).
      // Wrapped so any failure here cannot lose the broadcast result.
      try {
        const existingIncident = await storage.getOpenIncident(userId);
        if (!existingIncident) {
          await storage.createIncident(userId, "sos");
          await storage.updateSafetyState(userId, "concern", "SOS triggered from messages");
          notifyConcern(userId, userName, "sos").catch(() => {});
        }
      } catch (err: any) {
        console.error("[SOS-MSG] Incident creation failed:", err?.message || err);
      }

      res.json({ success: true, sentCount: created.length });
    } catch (error) {
      console.error("Error broadcasting SOS message:", error);
      res.status(500).json({ error: "Failed to broadcast SOS" });
    }
  });

  app.post("/api/messages/:userId", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const { content } = req.body;
      if (!content?.trim()) {
        return res.status(400).json({ error: "Message content is required" });
      }
      const receiverId = req.params.userId;

      const myContacts = await storage.getContacts(currentUserId);
      const theirContacts = await storage.getContacts(receiverId);
      const hasRelationship = myContacts.some(c => c.linkedUserId === receiverId) ||
                               theirContacts.some(c => c.linkedUserId === currentUserId);
      if (!hasRelationship) {
        return res.status(403).json({ error: "Not authorized to message this user" });
      }

      const msg = await storage.saveMessage(currentUserId, receiverId, content.trim());

      const { emitToUser, isUserOnline } = await import("./socket");
      const sender = await storage.getUser(currentUserId);
      emitToUser(receiverId, "message:new", { ...msg, senderName: sender?.name || "Someone" });

      if (!isUserOnline(receiverId)) {
        const pushBody = content.substring(0, 100);
        await sendPushNotification(receiverId, {
          title: `Message from ${sender?.name || "Someone"}`,
          body: pushBody,
          url: `/chat/${currentUserId}`,
          tag: "new-message",
        });
      }

      res.json(msg);
    } catch (error) {
      console.error("Error sending message:", error);
      res.status(500).json({ error: "Failed to send message" });
    }
  });

  // Post a system_safe or system_info message into a conversation.
  // Either party in the Safety Circle relationship may post these.
  // system_alert may NOT be created via this endpoint  -  those only come from the
  // SOS pipeline above so they cannot be spoofed by chat actions.
  app.post("/api/messages/:userId/system", systemMessageLimiter, async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const receiverId = req.params.userId;
      const { type, content, meta } = req.body || {};

      if (type !== "system_safe" && type !== "system_info") {
        return res.status(400).json({ error: "Invalid system message type" });
      }
      if (!content || typeof content !== "string" || !content.trim() || content.length > 500) {
        return res.status(400).json({ error: "Invalid content" });
      }

      const myContacts = await storage.getContacts(currentUserId);
      const theirContacts = await storage.getContacts(receiverId);
      const hasRelationship =
        myContacts.some((c) => c.linkedUserId === receiverId) ||
        theirContacts.some((c) => c.linkedUserId === currentUserId);
      if (!hasRelationship) {
        return res.status(403).json({ error: "Not authorized to message this user" });
      }

      const msg = await storage.saveMessage(currentUserId, receiverId, content.trim(), {
        messageType: type,
        meta: meta && typeof meta === "object" ? meta : undefined,
      });

      const { emitToUser } = await import("./socket");
      const sender = await storage.getUser(currentUserId);
      emitToUser(receiverId, "message:new", { ...msg, senderName: sender?.name || "Someone" });
      emitToUser(currentUserId, "message:sent", msg);

      res.json(msg);
    } catch (error) {
      console.error("Error posting system message:", error);
      res.status(500).json({ error: "Failed to post system message" });
    }
  });

  app.post("/api/messages/:userId/read", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const senderId = req.params.userId;
      await storage.markMessagesRead(senderId, currentUserId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error marking messages read:", error);
      res.status(500).json({ error: "Failed to mark messages read" });
    }
  });

  // ============================================
  // DRIVING SAFETY ENDPOINTS
  // ============================================

  const isValidLat = (v: any) => typeof v === "number" && v >= -90 && v <= 90;
  const isValidLng = (v: any) => typeof v === "number" && v >= -180 && v <= 180;
  const isValidSpeed = (v: any) => typeof v === "number" && v >= 0 && v <= 500;
  const isValidDistance = (v: any) => typeof v === "number" && v >= 0 && v <= 100000;

  app.post("/api/drive/start", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const existing = await storage.getActiveDriveSession(userId);
      if (existing) return res.status(400).json({ error: "Drive session already active", session: existing });

      const { lat, lng } = req.body || {};
      const validLat = lat !== undefined && isValidLat(lat) ? lat : undefined;
      const validLng = lng !== undefined && isValidLng(lng) ? lng : undefined;
      const session = await storage.createDriveSession(userId, validLat, validLng);
      res.json(session);
    } catch (error) {
      console.error("Error starting drive session:", error);
      res.status(500).json({ error: "Failed to start drive session" });
    }
  });

  app.post("/api/drive/end", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const session = await storage.getActiveDriveSession(userId);
      if (!session) return res.status(404).json({ error: "No active drive session" });

      const { maxSpeedKmh, avgSpeedKmh, distanceKm, lat, lng } = req.body || {};
      const updated = await storage.updateDriveSession(session.id, {
        endedAt: new Date(),
        ...(isValidSpeed(maxSpeedKmh) && { maxSpeedKmh }),
        ...(isValidSpeed(avgSpeedKmh) && { avgSpeedKmh }),
        ...(isValidDistance(distanceKm) && { distanceKm }),
        ...(isValidLat(lat) && { endLat: lat }),
        ...(isValidLng(lng) && { endLng: lng }),
      });
      res.json(updated);
    } catch (error) {
      console.error("Error ending drive session:", error);
      res.status(500).json({ error: "Failed to end drive session" });
    }
  });

  app.get("/api/drive/active", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const session = await storage.getActiveDriveSession(userId);
      res.json({ session: session || null });
    } catch (error) {
      console.error("Error getting active drive session:", error);
      res.status(500).json({ error: "Failed to get active drive session" });
    }
  });

  app.post("/api/drive/speed", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const { speedKmh, lat, lng, maxSpeedKmh, avgSpeedKmh, distanceKm } = req.body;
      if (!isValidSpeed(speedKmh)) return res.status(400).json({ error: "Valid speed is required" });

      const session = await storage.getActiveDriveSession(userId);
      if (session) {
        const updateData: any = {};
        if (isValidSpeed(maxSpeedKmh)) updateData.maxSpeedKmh = maxSpeedKmh;
        if (isValidSpeed(avgSpeedKmh)) updateData.avgSpeedKmh = avgSpeedKmh;
        if (isValidDistance(distanceKm)) updateData.distanceKm = distanceKm;
        if (Object.keys(updateData).length > 0) {
          await storage.updateDriveSession(session.id, updateData);
        }
      }

      if (session && lat != null && lng != null) {
        const speedMps = speedKmh / 3.6;
        let activity = "stationary";
        if (speedMps >= 11) activity = "driving";
        else if (speedMps >= 8) activity = "cycling";
        else if (speedMps >= 5) activity = "running";
        else if (speedMps >= 0.5) activity = "walking";
        await storage.addTripPoint({
          tripId: session.id,
          tripType: "drive",
          userId,
          lat, lng,
          speed: speedMps,
          activity,
        });
      }

      const userSettings = await storage.getSettings(userId);
      const speedLimit = userSettings?.speedLimitKmh || 120;

      if (speedKmh > speedLimit) {
        const alert = await storage.createSpeedAlert(
          userId,
          session?.id || null,
          speedKmh,
          speedLimit,
          lat,
          lng
        );
        return res.json({ alert, overSpeed: true, speedKmh, speedLimit });
      }

      res.json({ overSpeed: false, speedKmh, speedLimit });
    } catch (error) {
      console.error("Error logging speed:", error);
      res.status(500).json({ error: "Failed to log speed" });
    }
  });

  app.post("/api/drive/crash", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const { lat, lng, speedKmh, impactForce } = req.body;

      const session = await storage.getActiveDriveSession(userId);
      if (session) {
        await storage.updateDriveSession(session.id, {
          crashDetected: true,
          endedAt: new Date(),
          ...(lng !== undefined && { endLng: lng }),
          ...(lat !== undefined && { endLat: lat }),
        });
      }

      const user = await storage.getUser(userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const existingIncident = await storage.getOpenIncident(userId);
      if (existingIncident) {
        return res.json({ incident: existingIncident, message: "Incident already open" });
      }

      const incident = await storage.createIncident(userId, "sos");
      await storage.updateSafetyState(userId, "concern", "Crash detected");
      notifyConcern(userId, user.name, "crash_detection").catch((err) => {
        console.error(`[CRASH] notifyConcern failed for ${user.name}:`, err?.message || err);
      });
      // Auto-post into family chat with push fan-out
      broadcastToFamily(
        userId,
        speedKmh
          ? `Possible crash detected for ${user.name} (around ${Math.round(speedKmh)} km/h). Please check on them.`
          : `Possible crash detected for ${user.name}. Please check on them.`,
        "panic",
        lat != null && lng != null ? { lat, lng, kind: "crash" } : { kind: "crash" },
        {
          title: `Possible crash - ${user.name}`,
          body: "A possible vehicle crash was detected. Tap to open the family map.",
          url: "/family",
          tag: "family-crash",
        },
      ).catch(() => {});

      await storage.revokeAllTokensForUser(userId);
      const contactsRaw = await storage.getContacts(userId);
      const sortedContacts = contactsRaw.sort((a, b) => a.priority - b.priority);
      const baseUrl = getBaseUrl();

      for (const contact of sortedContacts) {
        try {
          const normalizedPhone = normalizePhone(contact.phone);
          const tokenRecord = await storage.generateToken(contact.id);
          const link = `${baseUrl}/emergency/${tokenRecord.token}`;

          const crashMsg = `CRASH ALERT from ${user.name}! A possible vehicle crash has been detected. ${speedKmh ? `Speed at impact: ${Math.round(speedKmh)} km/h. ` : ""}Please check on them immediately: ${link}`;

          if (isTwilioConfigured()) {
            await sendSms(normalizedPhone, crashMsg);
          }

          if (contact.email) {
            await sendCrashEmail(
              contact.email,
              user.name,
              link,
              speedKmh
            );
          }

          if (contact.linkedUserId) {
            await sendPushNotification(contact.linkedUserId, {
              title: `Urgent: Possible vehicle crash - ${user.name}`,
              body: `A possible vehicle crash has been detected for ${user.name}. Open the app to respond immediately.`,
              url: "/watched",
              tag: "crash-alert",
            });
          }
        } catch (err) {
          console.error(`Error notifying contact ${contact.id} about crash:`, err);
        }
      }

      await storage.updateIncident(incident.id, {
        escalationLevel: sortedContacts.length,
        lastEscalationStep: `contact_${sortedContacts.length}`,
        notifiedContactIds: JSON.stringify(sortedContacts.map(c => c.id)),
        lastContactNotifiedAt: new Date(),
        nextActionAt: addMinutes(new Date(), 5),
      });

      res.json({ incident, contactsNotified: sortedContacts.length });
    } catch (error) {
      console.error("Error reporting crash:", error);
      res.status(500).json({ error: "Failed to report crash" });
    }
  });

  app.get("/api/drive/history", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const limit = parseInt(req.query.limit as string) || 20;
      const sessions = await storage.getDriveHistory(userId, Math.min(limit, 50));
      res.json(sessions);
    } catch (error) {
      console.error("Error getting drive history:", error);
      res.status(500).json({ error: "Failed to get drive history" });
    }
  });

  app.get("/api/drive/alerts", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });

      const sessionId = req.query.sessionId as string | undefined;
      const alerts = await storage.getSpeedAlerts(userId, sessionId);
      res.json(alerts);
    } catch (error) {
      console.error("Error getting speed alerts:", error);
      res.status(500).json({ error: "Failed to get speed alerts" });
    }
  });

  app.get("/api/drive/trail/:sessionId", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const session = await storage.getDriveSession(req.params.sessionId);
      if (!session || session.userId !== userId) return res.status(404).json({ error: "Session not found" });
      const points = await storage.getTripPoints(req.params.sessionId, "drive");
      res.json(points);
    } catch (error) {
      res.status(500).json({ error: "Failed to get drive trail" });
    }
  });

  // ============================================
  // DRIVING REPORT
  // ============================================
  app.get("/api/drive/report", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const periodParam = (req.query.period as string) || "week";
      const report = await buildDriveReport(userId, periodParam);
      res.json(report);
    } catch (error) {
      console.error("Error generating drive report:", error);
      res.status(500).json({ error: "Failed to generate drive report" });
    }
  });

  app.get("/api/drive/report/:userId", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const targetUserId = req.params.userId;
      if (currentUserId !== targetUserId) {
        const canView = await checkWatcherPermission(currentUserId, targetUserId);
        if (!canView) return res.status(403).json({ error: "Not authorized" });
        const watchedSettings = await storage.getSettings(targetUserId);
        if (watchedSettings && !watchedSettings.allowReports) {
          return res.status(403).json({ error: "User has disabled report sharing" });
        }
      }
      const periodParam = (req.query.period as string) || "week";
      const report = await buildDriveReport(targetUserId, periodParam);
      res.json(report);
    } catch (error) {
      console.error("Error generating drive report:", error);
      res.status(500).json({ error: "Failed to generate drive report" });
    }
  });

  app.get("/api/drive/trail-public/:sessionId", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const session = await storage.getDriveSession(req.params.sessionId);
      if (!session) return res.status(404).json({ error: "Session not found" });
      if (session.userId !== currentUserId) {
        const canView = await checkWatcherPermission(currentUserId, session.userId);
        if (!canView) return res.status(403).json({ error: "Not authorized" });
        const watchedSettings = await storage.getSettings(session.userId);
        if (watchedSettings && !watchedSettings.allowReports) {
          return res.status(403).json({ error: "User has disabled report sharing" });
        }
      }
      const points = await storage.getTripPoints(req.params.sessionId, "drive");
      res.json(points);
    } catch (error) {
      res.status(500).json({ error: "Failed to get drive trail" });
    }
  });

  async function buildDriveReport(userId: string, periodParam: string) {
    const now = new Date();
    let from: Date;
    switch (periodParam) {
      case "day": from = new Date(now.getTime() - 86400000); break;
      case "fortnight": from = new Date(now.getTime() - 14 * 86400000); break;
      case "month": from = new Date(now.getTime() - 30 * 86400000); break;
      case "week":
      default: from = new Date(now.getTime() - 7 * 86400000); break;
    }

    const user = await storage.getUser(userId);
    if (!user) throw new Error("User not found");

    const allSessions = await storage.getDriveHistory(userId, 500);
    const sessions = allSessions.filter(s => new Date(s.startedAt) >= from);
    const allAlerts = await storage.getSpeedAlerts(userId);
    const sessionIds = new Set(sessions.map(s => s.id));
    const alerts = allAlerts.filter(a => a.sessionId && sessionIds.has(a.sessionId));

    const totalDrives = sessions.length;
    const totalDistanceKm = sessions.reduce((sum, s) => sum + (s.distanceKm || 0), 0);
    const topSpeedKmh = sessions.length > 0 ? Math.max(...sessions.map(s => s.maxSpeedKmh || 0)) : 0;
    const avgSpeedKmh = sessions.length > 0
      ? sessions.reduce((sum, s) => sum + (s.avgSpeedKmh || 0), 0) / sessions.length
      : 0;
    const totalDriveTimeMs = sessions.reduce((sum, s) => {
      if (!s.endedAt) return sum;
      return sum + (new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime());
    }, 0);
    const crashCount = sessions.filter(s => s.crashDetected).length;
    const speedingCount = alerts.length;

    const { format: fmtDate } = await import("date-fns");

    const driveDetails = sessions.map(s => {
      const sessionAlerts = alerts.filter(a => a.sessionId === s.id);
      const durationMs = s.endedAt
        ? new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()
        : 0;
      return {
        id: s.id,
        date: fmtDate(new Date(s.startedAt), "MMM d, yyyy"),
        startTime: fmtDate(new Date(s.startedAt), "h:mm a"),
        endTime: s.endedAt ? fmtDate(new Date(s.endedAt), "h:mm a") : null,
        durationMinutes: Math.round(durationMs / 60000),
        distanceKm: s.distanceKm || 0,
        maxSpeedKmh: s.maxSpeedKmh || 0,
        avgSpeedKmh: s.avgSpeedKmh || 0,
        crashDetected: s.crashDetected || false,
        speedAlerts: sessionAlerts.length,
        startLat: s.startLat,
        startLng: s.startLng,
        endLat: s.endLat,
        endLng: s.endLng,
      };
    });

    return {
      userName: user.name,
      periodStart: fmtDate(from, "yyyy-MM-dd"),
      periodEnd: fmtDate(now, "yyyy-MM-dd"),
      totalDrives,
      totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
      topSpeedKmh: Math.round(topSpeedKmh),
      avgSpeedKmh: Math.round(avgSpeedKmh),
      totalDriveTimeMinutes: Math.round(totalDriveTimeMs / 60000),
      crashCount,
      speedingCount,
      drives: driveDetails,
    };
  }

  // ============================================
  // ERROR TRACKING
  // ============================================
  app.post("/api/errors/report", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { type, message, stack, url, metadata } = req.body;
      if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "Error message is required" });
      }
      const userAgent = req.headers["user-agent"] || undefined;
      const report = await storage.createErrorReport({
        userId: userId || undefined,
        type: typeof type === "string" ? type : "error",
        message,
        stack: typeof stack === "string" ? stack : undefined,
        url: typeof url === "string" ? url : undefined,
        userAgent,
        metadata: typeof metadata === "string" ? metadata : metadata ? JSON.stringify(metadata) : undefined,
      });
      res.json({ id: report.id });
    } catch (error) {
      console.error("Error saving error report:", error);
      res.status(500).json({ error: "Failed to save error report" });
    }
  });

  app.get("/api/errors", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const limit = parseInt(req.query.limit as string) || 50;
      const resolved = req.query.resolved === "true" ? true : req.query.resolved === "false" ? false : undefined;
      const reports = await storage.getErrorReports(Math.min(limit, 100), resolved, userId);
      res.json(reports);
    } catch (error) {
      console.error("Error getting error reports:", error);
      res.status(500).json({ error: "Failed to get error reports" });
    }
  });

  app.get("/api/errors/stats", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const stats = await storage.getErrorReportStats(userId);
      res.json(stats);
    } catch (error) {
      console.error("Error getting error stats:", error);
      res.status(500).json({ error: "Failed to get error stats" });
    }
  });

  app.post("/api/errors/:id/resolve", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(req.params.id)) {
        return res.status(400).json({ error: "Invalid error report ID" });
      }
      const resolved = await storage.resolveErrorReport(req.params.id, userId);
      if (!resolved) return res.status(404).json({ error: "Error report not found" });
      res.json({ success: true });
    } catch (error) {
      console.error("Error resolving error report:", error);
      res.status(500).json({ error: "Failed to resolve error report" });
    }
  });

  // ============================================
  // APP RATINGS
  // ============================================
  app.post("/api/ratings", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const { rating, comment, appVersion } = req.body;
      if (typeof rating !== "number" || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
        return res.status(400).json({ error: "Rating must be an integer between 1 and 5" });
      }
      if (comment && typeof comment !== "string") {
        return res.status(400).json({ error: "Comment must be a string" });
      }
      const result = await storage.createAppRating(
        userId,
        rating,
        typeof comment === "string" ? comment.slice(0, 1000) : undefined,
        typeof appVersion === "string" ? appVersion : undefined,
      );
      res.json(result);
    } catch (error) {
      console.error("Error submitting rating:", error);
      res.status(500).json({ error: "Failed to submit rating" });
    }
  });

  app.get("/api/ratings/mine", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const rating = await storage.getUserRating(userId);
      res.json(rating || null);
    } catch (error) {
      console.error("Error getting user rating:", error);
      res.status(500).json({ error: "Failed to get rating" });
    }
  });

  app.get("/api/ratings", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const limit = parseInt(req.query.limit as string) || 50;
      const ratings = await storage.getAppRatings(Math.min(limit, 100));
      const sanitized = ratings.map(r => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt,
        isOwn: r.userId === userId,
        userName: r.userId === userId ? r.userName : undefined,
      }));
      res.json(sanitized);
    } catch (error) {
      console.error("Error getting ratings:", error);
      res.status(500).json({ error: "Failed to get ratings" });
    }
  });

  app.get("/api/ratings/stats", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const stats = await storage.getAppRatingStats();
      res.json(stats);
    } catch (error) {
      console.error("Error getting rating stats:", error);
      res.status(500).json({ error: "Failed to get rating stats" });
    }
  });

  // ============================================
  // SMS CHECK-IN WEBHOOK (Twilio incoming)
  // ============================================
  app.post("/api/sms/incoming", verifyTwilioSignature, async (req, res) => {
    try {
      const from = req.body?.From || req.body?.from;
      const body = (req.body?.Body || req.body?.body || "").trim().toLowerCase();
      
      if (!from) {
        return res.status(400).send("<Response></Response>");
      }
      
      const normalized = normalizePhone(from);
      const user = await storage.getUserByPhone(normalized);
      
      if (!user) {
        console.log(`[SMS-CHECKIN] Unknown phone: ***${normalized.slice(-4)}`);
        return res.type("text/xml").send('<Response><Message>This number is not registered with StillHere.</Message></Response>');
      }
      
      const userSettings = await storage.getSettings(user.id);
      
      const affirmatives = ["yes", "ok", "y", "yep", "yeah", "im ok", "i'm ok", "safe", "good", "fine", "here", "alive", "checkin", "check in"];
      const isCheckin = affirmatives.some(a => body.includes(a));
      
      if (isCheckin) {
        const result = await resolveCheckin(user.id, "sms");
        
        const contacts = await storage.getContacts(user.id);
        const contactNames = contacts.map(c => c.name).join(", ");
        const hasContacts = contacts.length > 0;
        
        console.log(`[SMS-CHECKIN] Checkin recorded for user ***${normalized.slice(-4)}`);
        
        let replyMsg = `StillHere Confirmation\n\nHi ${escapeXml(user.name)}, your safety checkin has been recorded successfully.`;
        if (result.hadIncident && hasContacts) {
          replyMsg += `\n\nYour emergency contact${contacts.length > 1 ? "s" : ""} (${escapeXml(contactNames)}) ${contacts.length > 1 ? "have" : "has"} been notified that you are safe. The alert has been resolved.`;
        } else if (result.hadIncident) {
          replyMsg += `\n\nThe alert has been resolved.`;
        }
        replyMsg += `\n\nThank you for checking in. Stay safe.`;
        
        return res.type("text/xml").send(`<Response><Message>${replyMsg}</Message></Response>`);
      }
      
      if (body === "help" || body === "sos") {
        const existingIncident = await storage.getOpenIncident(user.id);
        if (!existingIncident) {
          const incident = await storage.createIncident(user.id, "sos");
          const allContacts = await storage.getContacts(user.id);
          const sorted = [...allContacts].sort((a, b) => a.priority - b.priority);
          const tokens = await storage.regenerateTokensForUser(user.id);
          const baseUrl = getBaseUrl();
          const first = sorted[0];
          if (first) {
            const tok = tokens.find(t => t.contact.id === first.id);
            if (tok) {
              const link = `${baseUrl}/emergency/${tok.token}`;
              await notifyContact(first, user.name, link, "sos", sendSosAlert);
            }
          }
          await storage.updateIncident(incident.id, {
            escalationLevel: 1,
            lastEscalationStep: "contact_1",
            notifiedContactIds: JSON.stringify(first ? [first.id] : []),
            lastContactNotifiedAt: new Date(),
            contact1NotifiedAt: new Date(),
            nextActionAt: addMinutes(new Date(), userSettings.escalationMinutes || 20),
          });
        }
        return res.type("text/xml").send('<Response><Message>SOS alert sent. Your emergency contacts are being notified.</Message></Response>');
      }
      
      return res.type("text/xml").send('<Response><Message>Reply YES to check in, or HELP for SOS. StillHere is watching over you.</Message></Response>');
    } catch (error) {
      console.error("Error in SMS incoming webhook:", error);
      res.type("text/xml").send('<Response><Message>Something went wrong. Please try again.</Message></Response>');
    }
  });

  // ============================================
  // GOOGLE MAPS API PROXY ENDPOINTS
  // ============================================

  app.get("/api/maps/config", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const key = process.env.GOOGLE_MAPS_API_KEY;
      if (!key) return res.status(500).json({ error: "Maps not configured" });
      res.json({ apiKey: key });
    } catch (error) {
      res.status(500).json({ error: "Failed to load maps config" });
    }
  });

  // Static map proxy  -  keeps the Google API key off the client and lets us
  // serve a small map preview image inside the in-chat Live Location card.
  app.get("/api/maps/static-map", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const lat = parseFloat(String(req.query.lat ?? ""));
      const lng = parseFloat(String(req.query.lng ?? ""));
      if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return res.status(400).json({ error: "Valid lat and lng required" });
      }
      const key = process.env.GOOGLE_MAPS_API_KEY;
      if (!key) return res.status(500).json({ error: "Maps not configured" });
      const width = Math.min(Math.max(parseInt(String(req.query.w ?? "640"), 10) || 640, 100), 800);
      const height = Math.min(Math.max(parseInt(String(req.query.h ?? "240"), 10) || 240, 80), 400);
      const zoom = Math.min(Math.max(parseInt(String(req.query.zoom ?? "15"), 10) || 15, 1), 20);
      const scale = 2; // retina-quality
      const url =
        `https://maps.googleapis.com/maps/api/staticmap` +
        `?center=${lat},${lng}` +
        `&zoom=${zoom}` +
        `&size=${width}x${height}` +
        `&scale=${scale}` +
        `&maptype=roadmap` +
        `&markers=color:0x4F8FF7%7C${lat},${lng}` +
        `&key=${key}`;
      const upstream = await fetch(url);
      if (!upstream.ok) {
        return res.status(502).json({ error: "Map provider error" });
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "image/png");
      // Location data is sensitive  -  keep this in the user's browser only,
      // never in shared/proxy caches.
      res.setHeader("Cache-Control", "private, max-age=300");
      res.send(buf);
    } catch (err) {
      console.error("Static map proxy error:", err);
      res.status(500).json({ error: "Failed to load static map" });
    }
  });

  app.get("/api/maps/geocode", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const { lat, lng } = req.query;
      if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });
      const key = process.env.GOOGLE_MAPS_API_KEY;
      if (!key) return res.status(500).json({ error: "Maps not configured" });
      const response = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}&result_type=street_address|route|locality`
      );
      const data = await response.json();
      if (data.status === "OK" && data.results?.length > 0) {
        const result = data.results[0];
        const components = result.address_components || [];
        const streetNumber = components.find((c: any) => c.types.includes("street_number"))?.short_name || "";
        const route = components.find((c: any) => c.types.includes("route"))?.short_name || "";
        const locality = components.find((c: any) => c.types.includes("locality"))?.long_name || "";
        const suburb = components.find((c: any) => c.types.includes("sublocality_level_1") || c.types.includes("sublocality"))?.long_name || "";
        const shortAddress = streetNumber && route ? `${streetNumber} ${route}` : route || suburb || locality || result.formatted_address;
        res.json({
          formatted: result.formatted_address,
          short: shortAddress,
          locality: locality || suburb,
          placeId: result.place_id,
        });
      } else {
        res.json({ formatted: null, short: null, locality: null, placeId: null });
      }
    } catch (error) {
      console.error("Geocoding error:", error);
      res.status(500).json({ error: "Geocoding failed" });
    }
  });

  app.get("/api/maps/nearby-emergency", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const { lat, lng } = req.query;
      if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });
      const key = process.env.GOOGLE_MAPS_API_KEY;
      if (!key) return res.status(500).json({ error: "Maps not configured" });

      const types = ["hospital", "police", "fire_station"];
      const results: { name: string; lat: number; lng: number; type: string }[] = [];

      await Promise.all(types.map(async (type) => {
        try {
          const response = await fetch(
            `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=5000&type=${type}&key=${key}`
          );
          const data = await response.json();
          if (data.results) {
            data.results.slice(0, 5).forEach((place: any) => {
              results.push({
                name: place.name,
                lat: place.geometry.location.lat,
                lng: place.geometry.location.lng,
                type,
              });
            });
          }
        } catch (err: any) {
          console.error(`[PLACES] Nearby places fetch failed for type:`, err?.message || err);
        }
      }));

      res.json(results);
    } catch (error) {
      console.error("Nearby emergency places error:", error);
      res.status(500).json({ error: "Failed to fetch nearby places" });
    }
  });

  app.post("/api/maps/snap-to-road", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const { points } = req.body;
      if (!Array.isArray(points) || points.length < 2) return res.status(400).json({ error: "At least 2 points required" });
      const key = process.env.GOOGLE_MAPS_API_KEY;
      if (!key) return res.status(500).json({ error: "Maps not configured" });

      const maxPerRequest = 100;
      const snappedPoints: { lat: number; lng: number }[] = [];

      for (let i = 0; i < points.length; i += maxPerRequest) {
        const batch = points.slice(i, i + maxPerRequest);
        const path = batch.map((p: any) => `${p.lat},${p.lng}`).join("|");
        const response = await fetch(
          `https://roads.googleapis.com/v1/snapToRoads?path=${path}&interpolate=true&key=${key}`
        );
        const data = await response.json();
        if (data.snappedPoints) {
          for (const sp of data.snappedPoints) {
            snappedPoints.push({ lat: sp.location.latitude, lng: sp.location.longitude });
          }
        }
      }

      res.json({ snappedPoints });
    } catch (error) {
      console.error("Snap to road error:", error);
      res.status(500).json({ error: "Snap to road failed" });
    }
  });

  app.get("/api/places/autocomplete", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const { input, lat, lng } = req.query;
      if (!input || typeof input !== "string" || input.length < 2) {
        return res.json({ predictions: [] });
      }

      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) return res.status(500).json({ error: "Google Maps not configured" });

      const body: any = {
        input,
        languageCode: req.headers["accept-language"]?.split(",")[0]?.split("-")[0] || "en",
      };
      if (lat && lng) {
        body.locationBias = {
          circle: {
            center: { latitude: parseFloat(lat as string), longitude: parseFloat(lng as string) },
            radius: 50000.0,
          },
        };
      }

      const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
        },
        body: JSON.stringify(body),
      });
      const data = await response.json();

      if (data.error) {
        console.error("[PLACES] Autocomplete error:", data.error.message);
        return res.json({ predictions: [] });
      }

      const predictions = (data.suggestions || [])
        .filter((s: any) => s.placePrediction)
        .map((s: any) => {
          const p = s.placePrediction;
          return {
            placeId: p.placeId || p.place?.split("/").pop() || "",
            name: p.structuredFormat?.mainText?.text || p.text?.text?.split(",")[0] || "",
            subtitle: p.structuredFormat?.secondaryText?.text || "",
            description: p.text?.text || "",
          };
        });

      res.json({ predictions });
    } catch (err) {
      console.error("[PLACES] Autocomplete failed:", err);
      res.json({ predictions: [] });
    }
  });

  app.get("/api/places/details", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const { placeId } = req.query;
      if (!placeId || typeof placeId !== "string") {
        return res.status(400).json({ error: "placeId required" });
      }

      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) return res.status(500).json({ error: "Google Maps not configured" });

      const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
        headers: {
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "displayName,formattedAddress,location",
        },
      });
      const data = await response.json();

      if (data.error || !data.location) {
        console.error("[PLACES] Details error:", data.error?.message);
        return res.status(404).json({ error: "Place not found" });
      }

      res.json({
        lat: data.location.latitude,
        lng: data.location.longitude,
        name: data.displayName?.text || "",
        address: data.formattedAddress || "",
      });
    } catch (err) {
      console.error("[PLACES] Details failed:", err);
      res.status(500).json({ error: "Failed to get place details" });
    }
  });

  app.get("/api/places/directions", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const { originLat, originLng, destLat, destLng } = req.query;
      if (!originLat || !originLng || !destLat || !destLng) {
        return res.status(400).json({ error: "Origin and destination coordinates required" });
      }

      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (!apiKey) return res.status(500).json({ error: "Google Maps not configured" });

      const travelModes = [
        { key: "walk", mode: "WALK" },
        { key: "bike", mode: "BICYCLE" },
        { key: "transit", mode: "TRANSIT" },
        { key: "drive", mode: "DRIVE" },
      ];

      const results: Record<string, { min: number; km: number } | null> = {};

      await Promise.all(travelModes.map(async ({ key, mode }) => {
        try {
          const body: any = {
            origin: { location: { latLng: { latitude: parseFloat(originLat as string), longitude: parseFloat(originLng as string) } } },
            destination: { location: { latLng: { latitude: parseFloat(destLat as string), longitude: parseFloat(destLng as string) } } },
            travelMode: mode,
          };

          const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Goog-Api-Key": apiKey,
              "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline",
            },
            body: JSON.stringify(body),
          });
          const data = await response.json();

          if (data.routes?.length > 0) {
            const route = data.routes[0];
            const durationSec = parseInt(route.duration?.replace("s", "") || "0");
            results[key] = {
              min: Math.max(1, Math.ceil(durationSec / 60)),
              km: Math.round((route.distanceMeters || 0) / 100) / 10,
              polyline: route.polyline?.encodedPolyline || null,
            };
          } else {
            results[key] = null;
          }
        } catch {
          results[key] = null;
        }
      }));

      res.json(results);
    } catch (err) {
      console.error("[PLACES] Directions failed:", err);
      res.status(500).json({ error: "Failed to get directions" });
    }
  });

  // ============================================
  // GEOFENCE ENDPOINTS
  // ============================================
  app.get("/api/geofences", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const fences = await storage.getGeofences(userId);
      res.json(fences);
    } catch (error) {
      console.error("Error getting geofences:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.get("/api/geofences/for/:userId", async (req, res) => {
    try {
      const requesterId = getUserId(req);
      if (!requesterId) return res.status(401).json({ error: "Not authenticated" });
      const targetUserId = req.params.userId;
      const linkedContacts = await storage.getContactsLinkedToUser(requesterId);
      const isWatcher = linkedContacts.some(c => c.userId === targetUserId);
      if (!isWatcher && requesterId !== targetUserId) {
        return res.status(403).json({ error: "Not authorized" });
      }
      const fences = await storage.getGeofences(targetUserId);
      res.json(fences);
    } catch (error) {
      res.status(500).json({ error: "Failed" });
    }
  });

  app.post("/api/geofences", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const { name, lat, lng, radiusMeters, type } = req.body;
      if (!name || lat == null || lng == null) {
        return res.status(400).json({ error: "name, lat, and lng are required" });
      }
      const fence = await storage.createGeofence(userId, {
        name,
        lat,
        lng,
        radiusMeters: radiusMeters || 200,
        type: type || "home",
      });
      res.json(fence);
    } catch (error) {
      console.error("Error creating geofence:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.put("/api/geofences/:id", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const fence = await storage.updateGeofence(req.params.id as string, userId, req.body);
      res.json(fence);
    } catch (error) {
      console.error("Error updating geofence:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.delete("/api/geofences/:id", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      await storage.deleteGeofence(req.params.id as string, userId);
      res.json({ ok: true });
    } catch (error) {
      console.error("Error deleting geofence:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  const geofenceState = new Map<string, Map<string, boolean>>();
  // Expose to module-scope helpers (e.g. purgePlaceFromGeofenceState) without
  // making it global.
  geofenceStateRef = geofenceState;

  app.post("/api/geofences/check", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const { lat, lng } = req.body;
      if (lat == null || lng == null || typeof lat !== "number" || typeof lng !== "number") {
        return res.status(400).json({ error: "lat and lng must be numbers" });
      }
      
      const fences = await storage.getGeofences(userId);
      const activeFences = fences.filter(f => f.active);
      const results = activeFences.map(fence => {
        const distance = haversineDistance(lat, lng, fence.lat, fence.lng);
        return {
          id: fence.id,
          name: fence.name,
          type: fence.type,
          inside: distance <= fence.radiusMeters,
          distanceMeters: Math.round(distance),
        };
      });
      
      if (!geofenceState.has(userId)) {
        geofenceState.set(userId, new Map());
      }
      const userState = geofenceState.get(userId)!;
      
      const newDepartures: typeof results = [];
      const newArrivals: typeof results = [];
      for (const r of results) {
        const wasInside = userState.get(r.id);
        if (wasInside === true && !r.inside) newDepartures.push(r);
        if (wasInside === false && r.inside) newArrivals.push(r);
        userState.set(r.id, r.inside);
      }

      if (newDepartures.length > 0) {
        const user = await storage.getUser(userId);
        const allContacts = await storage.getContacts(userId);
        for (const zone of newDepartures) {
          for (const contact of allContacts) {
            if (contact.email) {
              try {
                await sendGeofenceEmail(contact.email, user?.name || "User", zone.name);
              } catch (err: any) {
                console.error(`[GEOFENCE] Email to ${contact.name} about zone ${zone.name} failed:`, err?.message || err);
              }
            }
          }
        }
      }

      // ---- Family Saved Places: detect arrivals/departures and post to family chat ----
      const overview = await storage.getFamilyForUser(userId);
      const placeArrivals: { name: string; icon: string }[] = [];
      const placeDepartures: { name: string; icon: string }[] = [];
      if (overview.family) {
        const places = await storage.getFamilyPlaces(overview.family.id);
        for (const p of places) {
          const key = `place:${p.id}`;
          const dist = haversineDistance(lat, lng, p.lat, p.lng);
          const inside = dist <= p.radiusMeters;
          const wasInside = userState.get(key);
          if (wasInside === true && !inside) placeDepartures.push({ name: p.name, icon: p.icon });
          if (wasInside === false && inside) placeArrivals.push({ name: p.name, icon: p.icon });
          userState.set(key, inside);
        }
        // Hoist family + sender lookups so multiple arrivals/departures don't N+1.
        if (placeArrivals.length > 0 || placeDepartures.length > 0) {
          const user = await storage.getUser(userId);
          const userName = user?.name || "Family member";
          const recipients = await storage.getActiveFamilyUserIds(overview.family.id);
          const prefetched = { familyId: overview.family.id, senderName: userName, recipients };
          for (const a of placeArrivals) {
            broadcastToFamily(userId, `${userName} arrived at ${a.name}.`, "system",
              { kind: "place_arrival", place: a.name }, undefined, prefetched).catch(() => {});
          }
          for (const d of placeDepartures) {
            broadcastToFamily(userId, `${userName} left ${d.name}.`, "system",
              { kind: "place_departure", place: d.name }, undefined, prefetched).catch(() => {});
          }
        }
      }

      res.json({
        zones: results,
        newDepartures: newDepartures.map(d => d.name),
        placeArrivals: placeArrivals.map(p => p.name),
        placeDepartures: placeDepartures.map(p => p.name),
      });
    } catch (error) {
      console.error("Error checking geofences:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  // ============================================
  // LOCATION BREADCRUMBS
  // ============================================
  app.post("/api/location/breadcrumb", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const { lat, lng, accuracy, sessionId } = req.body;
      if (lat == null || lng == null) return res.status(400).json({ error: "lat and lng required" });
      const breadcrumb = await storage.saveBreadcrumb(userId, sessionId || null, lat, lng, accuracy || null);
      res.json(breadcrumb);
    } catch (error) {
      console.error("Error saving breadcrumb:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.get("/api/location/breadcrumbs/:userId", async (req, res) => {
    try {
      const requesterId = getUserId(req);
      if (!requesterId) return res.status(401).json({ error: "Not authenticated" });
      const targetUserId = req.params.userId as string;
      const linkedContacts = await storage.getContactsLinkedToUser(requesterId);
      const isWatcher = linkedContacts.some(c => c.userId === targetUserId);
      if (!isWatcher && requesterId !== targetUserId) {
        return res.status(403).json({ error: "Not authorized" });
      }
      const sessionId = req.query.sessionId as string | undefined;
      const breadcrumbs = await storage.getBreadcrumbs(targetUserId, sessionId, 200);
      res.json(breadcrumbs);
    } catch (error) {
      console.error("Error getting breadcrumbs:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  // ============================================
  // LIVE LOCATION SHARING ENDPOINTS
  // ============================================
  app.post("/api/live-location/start", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const { durationMinutes } = req.body;
      const expiresAt = durationMinutes ? new Date(Date.now() + durationMinutes * 60 * 1000) : null;
      const share = await storage.startLiveLocationShare(userId, expiresAt);
      res.json(share);
    } catch (error) {
      res.status(500).json({ error: "Failed to start live location sharing" });
    }
  });

  app.post("/api/live-location/stop", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      await storage.stopLiveLocationShare(userId);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to stop live location sharing" });
    }
  });

  app.get("/api/live-location/status", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const share = await storage.getActiveLiveShare(userId);
      res.json({ active: !!share, share: share || null });
    } catch (error) {
      res.status(500).json({ error: "Failed to get live location status" });
    }
  });

  app.post("/api/live-location/update", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const share = await storage.getActiveLiveShare(userId);
      if (!share) return res.status(400).json({ error: "No active live location session" });

      if (share.expiresAt && new Date() > share.expiresAt) {
        await storage.stopLiveLocationShare(userId);
        return res.status(400).json({ error: "Live location session has expired" });
      }

      const { lat, lng, accuracy, speed, heading, activity } = req.body;
      if (lat == null || lng == null) return res.status(400).json({ error: "lat and lng are required" });

      const detectedActivity = activity || detectActivity(speed);
      const point = await storage.updateLiveLocation(
        share.id, userId, lat, lng,
        accuracy ?? null, speed ?? null, heading ?? null, detectedActivity
      );

      emitToUser(userId, "live-location:updated", { lat, lng, speed, heading, activity: detectedActivity });

      const [,watcherContacts, updatedUser, openIncidentForEmit] = await Promise.all([
        processLocationContext(userId, lat, lng, speed ?? null, detectedActivity).catch((err) => {
          console.error(`[LOCATION] processLocationContext failed for ${userId}:`, err?.message || err);
        }),
        storage.getContactsLinkedToUser(userId),
        storage.getUser(userId),
        storage.getOpenIncident(userId),
      ]);

      const ctx = getUserContext(userId);
      for (const contact of watcherContacts) {
        if (contact.linkedUserId) {
          emitToUser(contact.linkedUserId, "live-location:contact-updated", {
            userId, lat, lng, speed, heading, activity: detectedActivity,
            accuracy, timestamp: point.recordedAt,
            safetyState: updatedUser?.safetyState || null,
            hasSafetyEvent: !!openIncidentForEmit,
            contextLine: ctx.contextLine || null,
          });
        }
      }

      res.json(point);
    } catch (error) {
      res.status(500).json({ error: "Failed to update live location" });
    }
  });

  app.get("/api/context/:userId", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) return res.status(401).json({ error: "Not authenticated" });

      const targetUserId = req.params.userId;
      const isSelf = currentUserId === targetUserId;
      if (!isSelf) {
        const linkedContacts = await storage.getContactsLinkedToUser(targetUserId);
        const isWatcher = linkedContacts.some(c => c.linkedUserId === currentUserId);
        if (!isWatcher) return res.status(403).json({ error: "Not authorized" });
      }

      const ctx = getUserContext(targetUserId);
      const events = await getRecentContextEvents(targetUserId, 20);

      const timeline = events.reverse().map(e => ({
        type: e.type,
        time: e.createdAt.toISOString(),
        placeName: e.placeName,
        detail: formatContextEvent(e.type, e.placeName, e.detail || null),
      }));

      res.json({ ...ctx, timeline });
    } catch (error) {
      res.status(500).json({ error: "Failed to get context" });
    }
  });

  app.get("/api/notification-prefs/:watchedUserId", async (req, res) => {
    try {
      const watcherId = getUserId(req);
      if (!watcherId) return res.status(401).json({ error: "Not authenticated" });
      const watchedUserId = req.params.watchedUserId;

      const linkedContacts = await storage.getContactsLinkedToUser(watchedUserId);
      const isWatcher = linkedContacts.some(c => c.linkedUserId === watcherId);
      if (!isWatcher) return res.status(403).json({ error: "Not authorized" });

      const [pref] = await db.select().from(watcherNotificationPrefs)
        .where(and(
          eq(watcherNotificationPrefs.watcherId, watcherId),
          eq(watcherNotificationPrefs.watchedUserId, watchedUserId),
        ))
        .limit(1);

      res.json({
        arrivalNotifications: pref ? pref.arrivalNotifications : true,
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to get notification preferences" });
    }
  });

  app.put("/api/notification-prefs/:watchedUserId", async (req, res) => {
    try {
      const watcherId = getUserId(req);
      if (!watcherId) return res.status(401).json({ error: "Not authenticated" });
      const watchedUserId = req.params.watchedUserId;

      const linkedContacts = await storage.getContactsLinkedToUser(watchedUserId);
      const isWatcher = linkedContacts.some(c => c.linkedUserId === watcherId);
      if (!isWatcher) return res.status(403).json({ error: "Not authorized" });

      const { arrivalNotifications } = req.body;

      if (typeof arrivalNotifications !== "boolean") {
        return res.status(400).json({ error: "arrivalNotifications must be boolean" });
      }

      const [existing] = await db.select().from(watcherNotificationPrefs)
        .where(and(
          eq(watcherNotificationPrefs.watcherId, watcherId),
          eq(watcherNotificationPrefs.watchedUserId, watchedUserId),
        ))
        .limit(1);

      if (existing) {
        await db.update(watcherNotificationPrefs)
          .set({ arrivalNotifications })
          .where(eq(watcherNotificationPrefs.id, existing.id));
      } else {
        await db.insert(watcherNotificationPrefs).values({
          watcherId,
          watchedUserId,
          arrivalNotifications,
        });
      }

      res.json({ success: true, arrivalNotifications });
    } catch (error) {
      res.status(500).json({ error: "Failed to update notification preferences" });
    }
  });

  app.get("/api/live-location/watching", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const shares = await storage.getActiveLiveSharesForWatcher(userId);
      res.json(shares);
    } catch (error) {
      res.status(500).json({ error: "Failed to get watched live locations" });
    }
  });

  app.get("/api/live-location/trail/:userId", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) return res.status(401).json({ error: "Not authenticated" });
      const targetUserId = req.params.userId;

      const linkedContacts = await storage.getContactsLinkedToUser(currentUserId);
      const isWatcher = linkedContacts.some(c => c.userId === targetUserId);
      if (!isWatcher && targetUserId !== currentUserId) {
        return res.status(403).json({ error: "Not authorized to view this location" });
      }

      const share = await storage.getActiveLiveShare(targetUserId);
      if (!share) return res.json({ active: false, points: [] });

      const targetUser = await storage.getUser(targetUserId);
      const shareWithName = { ...share, userName: targetUser?.name || "Contact" };

      const sinceParam = req.query.since as string | undefined;
      const since = sinceParam ? new Date(sinceParam) : undefined;
      const points = await storage.getLiveLocationPoints(share.id, since, 200);

      res.json({ active: true, share: shareWithName, points: points.reverse() });
    } catch (error) {
      res.status(500).json({ error: "Failed to get location trail" });
    }
  });

  // ============================================
  // SATELLITE DEVICE ENDPOINTS
  // ============================================
  app.get("/api/satellite/devices", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const devices = await storage.getSatelliteDevices(userId);
      res.json(devices);
    } catch (error) {
      console.error("Error getting satellite devices:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.post("/api/satellite/register", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const { deviceType, deviceId, name } = req.body;
      if (!deviceType || !deviceId || !name) {
        return res.status(400).json({ error: "deviceType, deviceId, and name are required" });
      }
      const device = await storage.registerSatelliteDevice(userId, { deviceType, deviceId, name });
      res.json(device);
    } catch (error) {
      console.error("Error registering satellite device:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.delete("/api/satellite/devices/:id", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      await storage.deleteSatelliteDevice(req.params.id as string, userId);
      res.json({ ok: true });
    } catch (error) {
      console.error("Error deleting satellite device:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.post("/api/satellite/webhook", async (req, res) => {
    try {
      const expectedSecret = process.env.SATELLITE_WEBHOOK_SECRET;
      if (!expectedSecret) {
        console.error("[SATELLITE] SATELLITE_WEBHOOK_SECRET not configured, rejecting webhook");
        return res.status(503).json({ error: "Webhook not configured" });
      }
      const providedSecret = req.headers["x-satellite-secret"];
      const providedStr = typeof providedSecret === "string" ? providedSecret : "";
      const expectedBuf = Buffer.from(expectedSecret);
      const providedBuf = Buffer.from(providedStr);
      const { timingSafeEqual } = await import("crypto");
      const secretsMatch = providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
      if (!secretsMatch) {
        console.warn("[SATELLITE] Invalid or missing webhook secret");
        return res.status(403).json({ error: "Forbidden" });
      }

      const { deviceId, action, lat, lng } = req.body;
      if (!deviceId || !action) {
        return res.status(400).json({ error: "deviceId and action required" });
      }
      
      const deviceWithUser = await storage.getSatelliteDeviceByDeviceId(deviceId);
      if (!deviceWithUser) {
        return res.status(404).json({ error: "Device not registered" });
      }
      
      const user = deviceWithUser.user;
      
      if (action === "checkin") {
        await storage.createCheckin(user.id, "auto");
        await storage.resetReminderState(user.id);
        if (user.safetyState === "concern" || user.safetyState === "quiet") {
          await resolveCheckin(user.id, "app", { skipCreateCheckin: true });
        } else {
          const openInc = await storage.getOpenIncident(user.id);
          if (openInc) {
            await resolveCheckin(user.id, "app", { skipCreateCheckin: true });
          }
        }
        if (lat != null && lng != null) {
          const session = await storage.getActiveLocationSession(user.id);
          if (session) {
            await storage.updateLocationSession(session.id, lat, lng, 50);
          }
          await storage.saveBreadcrumb(user.id, null, lat, lng, 50);
        }
        console.log(`[SATELLITE] Checkin from device ${deviceId} for user ${user.id}`);
        res.json({ ok: true, action: "checkin_recorded" });
      } else if (action === "sos") {
        const existing = await storage.getOpenIncident(user.id);
        if (!existing) {
          const incident = await storage.createIncident(user.id, "sos");
          const allContacts = await storage.getContacts(user.id);
          const sorted = [...allContacts].sort((a, b) => a.priority - b.priority);
          const tokens = await storage.getContactTokensForUser(user.id);
          const baseUrl = getBaseUrl();
          const first = sorted[0];
          if (first) {
            const tok = tokens.find(t => t.contact.id === first.id);
            if (tok) {
              const link = `${baseUrl}/emergency/${tok.token}`;
              await notifyContact(first, user.name, link, "sos", sendSosAlert);
            }
          }
          const userSettings = await storage.getSettings(user.id);
          await storage.updateIncident(incident.id, {
            escalationLevel: 1,
            lastEscalationStep: "contact_1",
            notifiedContactIds: JSON.stringify(first ? [first.id] : []),
            lastContactNotifiedAt: new Date(),
            contact1NotifiedAt: new Date(),
            nextActionAt: addMinutes(new Date(), userSettings?.escalationMinutes || 20),
          });
        }
        if (lat != null && lng != null) {
          await storage.saveBreadcrumb(user.id, null, lat, lng, 50);
        }
        console.log(`[SATELLITE] SOS from device ${deviceId} for user ${user.id}`);
        res.json({ ok: true, action: "sos_triggered" });
      } else {
        res.status(400).json({ error: "Unknown action. Use 'checkin' or 'sos'" });
      }
    } catch (error) {
      console.error("Error in satellite webhook:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  // ============================================
  // REPORT ENDPOINTS
  // ============================================

  app.get("/api/watched-users/:userId/daily", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const watchedUserId = req.params.userId;
      const canView = await checkWatcherPermission(currentUserId, watchedUserId);
      if (!canView) {
        return res.status(403).json({ error: "Not authorized" });
      }
      const watchedSettings = await storage.getSettings(watchedUserId);
      if (watchedSettings && !watchedSettings.allowReports) {
        return res.status(403).json({ error: "User has disabled report sharing" });
      }
      const daily = await storage.getDailyStatus(currentUserId, watchedUserId);
      res.json(daily);
    } catch (error) {
      console.error("Error fetching daily status:", error);
      res.status(500).json({ error: "Failed to fetch daily status" });
    }
  });

  app.get("/api/reports/weekly", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const weekIncidents = await db
        .select()
        .from(incidents)
        .where(and(eq(incidents.userId, userId), gte(incidents.startedAt, weekAgo)))
        .orderBy(desc(incidents.startedAt));

      const weekCheckins = await db
        .select()
        .from(checkins)
        .where(and(eq(checkins.userId, userId), gte(checkins.createdAt, weekAgo)))
        .orderBy(desc(checkins.createdAt));

      const weekContext = await db
        .select()
        .from(contextEvents)
        .where(and(eq(contextEvents.userId, userId), gte(contextEvents.createdAt, weekAgo)))
        .orderBy(desc(contextEvents.createdAt));

      const reasonMap: Record<string, string> = {
        missed_checkin: "Missed check-in",
        sos: "SOS alert triggered",
        test: "Test alert",
        crash_detected: "Crash detected",
        safety_timer: "Safety timer expired",
        safe_walk: "Late arrival detected",
      };

      const methodMap: Record<string, string> = {
        button: "Confirmed safe in app",
        app: "Confirmed safe in app",
        sms: "Confirmed safe by SMS",
        auto: "Resolved automatically",
        call: "Confirmed safe by phone call",
        voice: "Confirmed safe by phone call",
      };

      const contextMap: Record<string, (name: string) => string> = {
        dwell_start: (name: string) => `Arrived at ${name || "a location"}`,
        dwell_end: (name: string) => `Left ${name || "a location"}`,
        trip_start: () => "Started a trip",
        trip_end: () => "Finished a trip",
      };

      type TimelineEntry = { text: string; baseText: string; time: string; rawTime: Date; category: "incident" | "checkin" | "context"; count: number };
      const rawTimeline: TimelineEntry[] = [];

      for (const inc of weekIncidents) {
        const reasonText = reasonMap[inc.reason] || inc.reason;
        let resolutionText = "";

        if (inc.status === "resolved" && inc.resolvedAt) {
          const lastCheckin = weekCheckins.find(
            (c) => c.createdAt && Math.abs(c.createdAt.getTime() - inc.resolvedAt!.getTime()) < 60000
          );
          if (lastCheckin) {
            resolutionText = `. ${methodMap[lastCheckin.method] || "Confirmed safe"}`;
          } else {
            resolutionText = ". Resolved shortly after";
          }
        } else if (inc.status === "open") {
          resolutionText = ". Awaiting response";
        }

        const entryText = `${reasonText}${resolutionText}`;
        rawTimeline.push({
          text: entryText,
          baseText: entryText,
          time: formatReportTime(inc.startedAt),
          rawTime: inc.startedAt,
          category: "incident",
          count: 1,
        });
      }

      for (const ctx of weekContext) {
        const formatter = contextMap[ctx.type];
        if (formatter) {
          const ctxText = formatter(ctx.placeName || "");
          rawTimeline.push({
            text: ctxText,
            baseText: ctxText,
            time: formatReportTime(ctx.createdAt),
            rawTime: ctx.createdAt,
            category: "context",
            count: 1,
          });
        }
      }

      rawTimeline.sort((a, b) => b.rawTime.getTime() - a.rawTime.getTime());

      const deduped: TimelineEntry[] = [];
      for (const entry of rawTimeline) {
        const existing = deduped.find(
          (d) =>
            d.baseText === entry.baseText &&
            Math.abs(d.rawTime.getTime() - entry.rawTime.getTime()) < 60 * 60 * 1000
        );
        if (existing) {
          existing.count++;
          existing.text = `${existing.baseText} (${existing.count} times)`;
        } else {
          deduped.push({ ...entry });
        }
      }

      const totalIncidents = weekIncidents.length;
      const unresolvedIncidents = weekIncidents.filter((i) => i.status !== "resolved");
      const slowResolutions = weekIncidents.filter((i) => {
        if (!i.resolvedAt) return false;
        return i.resolvedAt.getTime() - i.startedAt.getTime() > 30 * 60 * 1000;
      });

      let summaryTone: "good" | "mixed" | "concern";
      let summary: string;

      if (totalIncidents === 0) {
        summaryTone = "good";
        summary =
          "Everything looked steady this week. Check-ins were consistent and no concerns were raised. Keep it up  -  this is exactly what peace of mind looks like.";
      } else if (totalIncidents <= 2 && unresolvedIncidents.length === 0 && slowResolutions.length === 0) {
        summaryTone = "mixed";
        summary =
          "There were a few moments this week where we checked in a little closer. Each time, everything turned out okay. The system worked exactly as it should  -  catching the small things so nothing gets missed.";
      } else {
        summaryTone = "concern";
        if (unresolvedIncidents.length > 0) {
          summary =
            "There was a moment this week where we couldn't confirm safety right away. We want you to know that every alert was taken seriously, and your contacts were kept informed throughout. If anything felt off, consider reviewing your check-in schedule.";
        } else {
          summary =
            "This week had a few moments that needed attention. While everything was eventually resolved, it took a bit longer than usual in some cases. Your safety network stepped in when it mattered most.";
        }
      }

      const timeline = deduped.map(({ text, time }) => ({ text, time }));

      res.json({
        summaryTone,
        summary,
        timeline,
        weekStart: weekAgo.toISOString(),
        weekEnd: now.toISOString(),
        totalCheckins: weekCheckins.length,
      });
    } catch (error) {
      console.error("Error generating weekly report:", error);
      res.status(500).json({ error: "Failed to generate report" });
    }
  });

  app.get("/api/reports/preferences", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const prefs = await storage.getReportPreferences(userId);
      res.json(prefs);
    } catch (error) {
      console.error("Error fetching report preferences:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.put("/api/reports/preferences/:watchedUserId", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const watchedUserId = req.params.watchedUserId;
      const canView = await checkWatcherPermission(currentUserId, watchedUserId);
      if (!canView) {
        return res.status(403).json({ error: "Not authorized" });
      }
      const { frequency, enabled, email } = req.body;
      if (frequency && !["daily", "weekly", "fortnightly", "monthly"].includes(frequency)) {
        return res.status(400).json({ error: "Invalid frequency" });
      }
      const pref = await storage.upsertReportPreference({
        watcherId: currentUserId,
        watchedUserId,
        frequency: frequency || "weekly",
        enabled: enabled !== false,
        email: email || null,
      });
      res.json(pref);
    } catch (error) {
      console.error("Error updating report preference:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.get("/api/reports/:watchedUserId/weekly", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      const watchedUserId = req.params.watchedUserId;
      const canView = await checkWatcherPermission(currentUserId, watchedUserId);
      if (!canView) return res.status(403).json({ error: "Not authorized" });
      const watchedSettings = await storage.getSettings(watchedUserId);
      if (watchedSettings && !watchedSettings.allowReports) {
        return res.status(403).json({ error: "User has disabled report sharing" });
      }

      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const weekIncidents = await db.select().from(incidents)
        .where(and(eq(incidents.userId, watchedUserId), gte(incidents.startedAt, weekAgo)))
        .orderBy(desc(incidents.startedAt));

      const weekCheckins = await db.select().from(checkins)
        .where(and(eq(checkins.userId, watchedUserId), gte(checkins.createdAt, weekAgo)))
        .orderBy(desc(checkins.createdAt));

      const weekContext = await db.select().from(contextEvents)
        .where(and(eq(contextEvents.userId, watchedUserId), gte(contextEvents.createdAt, weekAgo)))
        .orderBy(desc(contextEvents.createdAt));

      const reasonMap: Record<string, string> = {
        missed_checkin: "Missed check-in",
        sos: "SOS alert triggered",
        test: "Test alert",
        crash_detected: "Crash detected",
        safety_timer: "Safety timer expired",
        safe_walk: "Late arrival detected",
      };
      const methodMap: Record<string, string> = {
        button: "Confirmed safe in app",
        app: "Confirmed safe in app",
        sms: "Confirmed safe by SMS",
        auto: "Resolved automatically",
        call: "Confirmed safe by phone call",
        voice: "Confirmed safe by phone call",
      };
      const contextMap: Record<string, (name: string) => string> = {
        dwell_start: (name: string) => `Arrived at ${name || "a location"}`,
        dwell_end: (name: string) => `Left ${name || "a location"}`,
        trip_start: () => "Started a trip",
        trip_end: () => "Finished a trip",
      };

      type TimelineEntry = { text: string; baseText: string; time: string; rawTime: Date; category: string; count: number };
      const rawTimeline: TimelineEntry[] = [];

      for (const inc of weekIncidents) {
        const reasonText = reasonMap[inc.reason] || inc.reason;
        let resolutionText = "";
        if (inc.status === "resolved" && inc.resolvedAt) {
          const lastCheckin = weekCheckins.find(
            (c) => c.createdAt && Math.abs(c.createdAt.getTime() - inc.resolvedAt!.getTime()) < 60000
          );
          resolutionText = lastCheckin
            ? `. ${methodMap[lastCheckin.method] || "Confirmed safe"}`
            : ". Resolved shortly after";
        } else if (inc.status === "open") {
          resolutionText = ". Awaiting response";
        }
        const entryText = `${reasonText}${resolutionText}`;
        rawTimeline.push({ text: entryText, baseText: entryText, time: formatReportTime(inc.startedAt), rawTime: inc.startedAt, category: "incident", count: 1 });
      }

      for (const ctx of weekContext) {
        const formatter = contextMap[ctx.type];
        if (formatter) {
          const ctxText = formatter(ctx.placeName || "");
          rawTimeline.push({ text: ctxText, baseText: ctxText, time: formatReportTime(ctx.createdAt), rawTime: ctx.createdAt, category: "context", count: 1 });
        }
      }

      rawTimeline.sort((a, b) => b.rawTime.getTime() - a.rawTime.getTime());

      const deduped: TimelineEntry[] = [];
      for (const entry of rawTimeline) {
        const existing = deduped.find(
          (d) => d.baseText === entry.baseText && Math.abs(d.rawTime.getTime() - entry.rawTime.getTime()) < 60 * 60 * 1000
        );
        if (existing) {
          existing.count++;
          existing.text = `${existing.baseText} (${existing.count} times)`;
        } else {
          deduped.push({ ...entry });
        }
      }

      const totalIncidents = weekIncidents.length;
      const unresolvedIncidents = weekIncidents.filter((i) => i.status !== "resolved");
      const slowResolutions = weekIncidents.filter((i) => {
        if (!i.resolvedAt) return false;
        return i.resolvedAt.getTime() - i.startedAt.getTime() > 30 * 60 * 1000;
      });

      let summaryTone: "good" | "mixed" | "concern";
      let summary: string;
      if (totalIncidents === 0) {
        summaryTone = "good";
        summary = "Everything looked steady this week. Check-ins were consistent and no concerns were raised. Keep it up.";
      } else if (totalIncidents <= 2 && unresolvedIncidents.length === 0 && slowResolutions.length === 0) {
        summaryTone = "mixed";
        summary = "There were a few moments this week where we checked in a little closer. Each time, everything turned out okay.";
      } else {
        summaryTone = "concern";
        summary = unresolvedIncidents.length > 0
          ? "There was a moment this week where safety couldn't be confirmed right away. Every alert was taken seriously and contacts were kept informed."
          : "This week had a few moments that needed attention. While everything was eventually resolved, it took a bit longer than usual in some cases.";
      }

      const user = await storage.getUser(watchedUserId);
      res.json({
        summaryTone,
        summary,
        timeline: deduped.map(({ text, time }) => ({ text, time })),
        weekStart: weekAgo.toISOString(),
        weekEnd: now.toISOString(),
        totalCheckins: weekCheckins.length,
        userName: user?.name || "Unknown",
      });
    } catch (error) {
      console.error("Error generating watcher weekly report:", error);
      res.status(500).json({ error: "Failed to generate report" });
    }
  });

  app.get("/api/reports/:watchedUserId", async (req, res) => {
    try {
      const currentUserId = getUserId(req);
      if (!currentUserId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const watchedUserId = req.params.watchedUserId;
      const canView = await checkWatcherPermission(currentUserId, watchedUserId);
      if (!canView) {
        return res.status(403).json({ error: "Not authorized" });
      }
      const watchedSettings = await storage.getSettings(watchedUserId);
      if (watchedSettings && !watchedSettings.allowReports) {
        return res.status(403).json({ error: "User has disabled report sharing" });
      }

      const periodParam = (req.query.period as string) || "week";
      const now = new Date();
      let from: Date;
      switch (periodParam) {
        case "day": from = new Date(now.getTime() - 86400000); break;
        case "fortnight": from = new Date(now.getTime() - 14 * 86400000); break;
        case "month": from = new Date(now.getTime() - 30 * 86400000); break;
        case "week":
        default: from = new Date(now.getTime() - 7 * 86400000); break;
      }

      const user = await storage.getUser(watchedUserId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const userSettings = await storage.getSettings(watchedUserId);
      const checkinList = await storage.getCheckinHistory(watchedUserId, from, now);
      const incidentList = await storage.getIncidentHistory(watchedUserId, from, now);

      const dayCount = Math.max(1, Math.ceil((now.getTime() - from.getTime()) / 86400000));
      const expectedCheckins = dayCount;
      const missedCheckins = Math.max(0, expectedCheckins - checkinList.length);
      const complianceRate = checkinList.length > 0 ? Math.round((checkinList.length / expectedCheckins) * 100) : 0;

      let heartRateSummary = null;
      const hrHistory = await storage.getHeartRateHistory(watchedUserId, dayCount * 24);
      if (hrHistory.length > 0) {
        const bpms = hrHistory.map(r => r.bpm);
        const hrAlerts = await storage.getActiveHeartRateAlerts(watchedUserId);
        heartRateSummary = {
          avgBpm: Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length),
          minBpm: Math.min(...bpms),
          maxBpm: Math.max(...bpms),
          alerts: hrAlerts.length,
        };
      }

      const fallAlerts = incidentList.filter(i => i.reason === "sos").length;

      let drivingSummary = null;
      try {
        const allSessions = await storage.getDriveHistory(watchedUserId, 100);
        const driveSess = allSessions.filter(s => new Date(s.startedAt) >= from);
        if (driveSess.length > 0) {
          const allAlerts = await storage.getSpeedAlerts(watchedUserId);
          const sessIds = new Set(driveSess.map(s => s.id));
          const driveAlerts = allAlerts.filter(a => a.sessionId && sessIds.has(a.sessionId));
          drivingSummary = {
            totalDrives: driveSess.length,
            totalDistanceKm: Math.round(driveSess.reduce((sum, s) => sum + (s.distanceKm || 0), 0) * 10) / 10,
            topSpeedKmh: Math.round(Math.max(...driveSess.map(s => s.maxSpeedKmh || 0))),
            speedingEvents: driveAlerts.length,
            crashEvents: driveSess.filter(s => s.crashDetected).length,
          };
        }
      } catch (err: any) {
        console.error(`[REPORT] Driving stats aggregation failed:`, err?.message || err);
      }

      const { format: fmtDate } = await import("date-fns");

      const report = {
        userName: user.name,
        periodStart: fmtDate(from, "yyyy-MM-dd"),
        periodEnd: fmtDate(now, "yyyy-MM-dd"),
        checkins: checkinList.map(c => ({
          date: fmtDate(c.createdAt, "yyyy-MM-dd"),
          time: fmtDate(c.createdAt, "h:mm a"),
          method: c.method,
        })),
        totalCheckins: checkinList.length,
        missedCheckins,
        complianceRate: Math.min(100, complianceRate),
        incidents: incidentList.map(i => ({
          date: fmtDate(i.startedAt, "yyyy-MM-dd"),
          reason: i.reason,
          resolved: i.status === "resolved",
          duration: i.resolvedAt
            ? `${Math.round((i.resolvedAt.getTime() - i.startedAt.getTime()) / 60000)} min`
            : null,
        })),
        heartRateSummary,
        drivingSummary,
        locationEnabled: userSettings?.locationMode !== "off",
        fallDetectionEnabled: userSettings?.fallDetection || false,
        fallAlerts,
      };

      res.json(report);
    } catch (error) {
      console.error("Error generating report:", error);
      res.status(500).json({ error: "Failed to generate report" });
    }
  });

  async function checkWatcherPermission(watcherUserId: string, watchedUserId: string): Promise<boolean> {
    const linkedContacts = await storage.getContactsLinkedToUser(watcherUserId);
    return linkedContacts.some(c => c.userId === watchedUserId);
  }

  // ===== SAFETY TIMER (Dead Man's Switch) =====
  app.post("/api/safety-timer/start", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const { durationMinutes, note } = req.body;
      if (!durationMinutes || durationMinutes < 5 || durationMinutes > 1440) {
        return res.status(400).json({ error: "Duration must be between 5 and 1440 minutes" });
      }
      const existing = await storage.getActiveSafetyTimer(userId);
      if (existing) {
        return res.status(400).json({ error: "You already have an active safety timer" });
      }
      const timer = await storage.createSafetyTimer(userId, durationMinutes, note);
      res.json(timer);
    } catch (error) {
      console.error("Error starting safety timer:", error);
      res.status(500).json({ error: "Failed to start safety timer" });
    }
  });

  app.get("/api/safety-timer/active", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const timer = await storage.getActiveSafetyTimer(userId);
      res.json(timer || null);
    } catch (error) {
      res.status(500).json({ error: "Failed to get active timer" });
    }
  });

  app.post("/api/safety-timer/cancel", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const timer = await storage.getActiveSafetyTimer(userId);
      if (!timer) return res.status(404).json({ error: "No active timer found" });
      await storage.updateSafetyTimer(timer.id, { status: "safe", resolvedAt: new Date() });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to cancel timer" });
    }
  });

  app.post("/api/safety-timer/extend", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const { additionalMinutes } = req.body;
      if (!additionalMinutes || additionalMinutes < 5 || additionalMinutes > 480) {
        return res.status(400).json({ error: "Extension must be between 5 and 480 minutes" });
      }
      const timer = await storage.getActiveSafetyTimer(userId);
      if (!timer) return res.status(404).json({ error: "No active timer found" });
      const newExpiry = new Date(timer.expiresAt.getTime() + additionalMinutes * 60 * 1000);
      const updated = await storage.updateSafetyTimer(timer.id, {
        expiresAt: newExpiry,
        status: "active",
        durationMinutes: timer.durationMinutes + additionalMinutes,
      });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to extend timer" });
    }
  });

  app.post("/api/safety-timer/location", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const { lat, lng, speed, activity } = req.body;
      const timer = await storage.getActiveSafetyTimer(userId);
      if (!timer) return res.status(404).json({ error: "No active timer" });
      await storage.updateSafetyTimer(timer.id, {
        lastLat: lat,
        lastLng: lng,
        lastSpeed: speed || null,
        lastActivity: activity || null,
        lastLocationAt: new Date(),
      });
      await storage.addTripPoint({
        tripId: timer.id,
        tripType: "timer",
        userId: userId,
        lat, lng, speed, activity,
      });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to update location" });
    }
  });

  app.get("/api/safety-timer/trail", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const timer = await storage.getActiveSafetyTimer(userId);
      if (!timer) return res.json([]);
      const points = await storage.getTripPoints(timer.id, "timer");
      res.json(points);
    } catch (error) {
      res.status(500).json({ error: "Failed to get trail" });
    }
  });

  // ===== SAFE WALK / SAFE RIDE =====
  app.post("/api/safe-walk/start", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const { destinationLat, destinationLng, destinationName, destinationType, expectedMinutes, note, arrivalRadiusMeters } = req.body;
      if (destinationLat == null || destinationLng == null || !expectedMinutes) {
        return res.status(400).json({ error: "Destination and expected time required" });
      }
      const existing = await storage.getActiveSafeWalk(userId);
      if (existing) {
        return res.status(400).json({ error: "You already have an active Safe Walk" });
      }
      const expectedArrivalAt = new Date(Date.now() + expectedMinutes * 60 * 1000);
      const walk = await storage.createSafeWalk(userId, {
        destinationLat,
        destinationLng,
        destinationName,
        destinationType: destinationType || "pin",
        expectedArrivalAt,
        note,
        arrivalRadiusMeters: arrivalRadiusMeters || 200,
      });
      res.json(walk);
    } catch (error) {
      console.error("Error starting safe walk:", error);
      res.status(500).json({ error: "Failed to start Safe Walk" });
    }
  });

  app.get("/api/safe-walk/active", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const walk = await storage.getActiveSafeWalk(userId);
      res.json(walk || null);
    } catch (error) {
      res.status(500).json({ error: "Failed to get active walk" });
    }
  });

  app.post("/api/safe-walk/cancel", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const walk = await storage.getActiveSafeWalk(userId);
      if (!walk) return res.status(404).json({ error: "No active Safe Walk" });
      await storage.updateSafeWalk(walk.id, { status: "cancelled", resolvedAt: new Date() });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to cancel walk" });
    }
  });

  app.post("/api/safe-walk/arrived", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const walk = await storage.getActiveSafeWalk(userId);
      if (!walk) return res.status(404).json({ error: "No active Safe Walk" });
      await storage.updateSafeWalk(walk.id, { status: "arrived", resolvedAt: new Date() });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to mark arrival" });
    }
  });

  app.post("/api/safe-walk/extend", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const { additionalMinutes } = req.body;
      if (!additionalMinutes || additionalMinutes < 5 || additionalMinutes > 480) {
        return res.status(400).json({ error: "Extension must be between 5 and 480 minutes" });
      }
      const walk = await storage.getActiveSafeWalk(userId);
      if (!walk) return res.status(404).json({ error: "No active Safe Walk" });
      const newExpiry = new Date(walk.expectedArrivalAt.getTime() + additionalMinutes * 60 * 1000);
      const updated = await storage.updateSafeWalk(walk.id, {
        expectedArrivalAt: newExpiry,
        status: "active",
      });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to extend walk" });
    }
  });

  app.post("/api/safe-walk/location", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const { lat, lng, speed, activity } = req.body;
      const walk = await storage.getActiveSafeWalk(userId);
      if (!walk) return res.status(404).json({ error: "No active Safe Walk" });

      await storage.updateSafeWalk(walk.id, {
        lastLat: lat,
        lastLng: lng,
        lastSpeed: speed || null,
        lastActivity: activity || null,
        lastLocationAt: new Date(),
      });
      await storage.addTripPoint({
        tripId: walk.id,
        tripType: "walk",
        userId: userId,
        lat, lng, speed, activity,
      });

      const distanceToDestination = getDistanceMeters(lat, lng, walk.destinationLat, walk.destinationLng);

      if (distanceToDestination <= walk.arrivalRadiusMeters) {
        await storage.updateSafeWalk(walk.id, { status: "arrived", resolvedAt: new Date() });
        return res.json({ success: true, arrived: true });
      }

      if (speed && speed > 0.5) {
        const distKm = distanceToDestination / 1000;
        const speedKmh = speed * 3.6;
        const etaMinutes = Math.ceil((distKm / speedKmh) * 60 * 1.15);
        const newArrival = new Date(Date.now() + Math.max(5, etaMinutes) * 60000);
        await storage.updateSafeWalk(walk.id, { expectedArrivalAt: newArrival });
      }

      res.json({ success: true, arrived: false, distanceToDestination: Math.round(distanceToDestination) });
    } catch (error) {
      res.status(500).json({ error: "Failed to update location" });
    }
  });

  app.get("/api/safe-walk/trail", async (req, res) => {
    const userId = getUserId(req); if (!userId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const walk = await storage.getActiveSafeWalk(userId);
      if (!walk) return res.json([]);
      const points = await storage.getTripPoints(walk.id, "walk");
      res.json(points);
    } catch (error) {
      res.status(500).json({ error: "Failed to get trail" });
    }
  });

  app.get("/api/safe-walk/watched/:userId", async (req, res) => {
    const watcherId = getUserId(req);
    if (!watcherId) return res.status(401).json({ error: "Not authenticated" });
    try {
      const targetUserId = req.params.userId;
      const contacts = await storage.getEmergencyContacts(targetUserId);
      const watcher = await storage.getUserById(watcherId);
      if (!watcher) return res.status(403).json({ error: "Forbidden" });
      const isContact = contacts.some(c => c.phone === watcher.phone);
      if (!isContact) return res.status(403).json({ error: "Not authorized to view this user's safe walk" });

      const walk = await storage.getActiveSafeWalk(targetUserId);
      if (!walk) return res.json(null);

      res.json({
        id: walk.id,
        destinationLat: walk.destinationLat,
        destinationLng: walk.destinationLng,
        destinationName: walk.destinationName,
        expectedArrival: walk.expectedArrivalAt,
        status: walk.status,
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to get safe walk" });
    }
  });

  // Helper: Calculate distance between two GPS coordinates in meters
  function getDistanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ===== AUTOMATED WELLNESS CHECK CALL =====
  // Map of country (ISO-2) -> local emergency services number. Used so the
  // wellness call says the right number for the user's actual location, not a
  // hard-coded "911". Falls back to a generic phrase below.
  const EMERGENCY_NUMBERS: Record<string, string> = {
    US: "911", CA: "911", MX: "911",
    GB: "999", IE: "999", KE: "999", HK: "999", SG: "999",
    AU: "000", NZ: "111",
    DE: "112", FR: "112", ES: "112", IT: "112", NL: "112", BE: "112",
    PT: "112", AT: "112", SE: "112", DK: "112", FI: "112", NO: "112",
    CH: "112", PL: "112", CZ: "112", HU: "112", GR: "112", RO: "112",
    IS: "112", LU: "112", EE: "112", LV: "112", LT: "112", BG: "112",
    HR: "112", SK: "112", SI: "112", TR: "112",
    IN: "112", KR: "112", IL: "112",
    JP: "110", CN: "110", TW: "110",
    BR: "190", AR: "911", CL: "133",
    ZA: "10111", AE: "999", SA: "999",
  };

  // Crude timezone -> country fallback for when we have no GPS yet.
  function countryFromTimezone(tz: string | null | undefined): string | null {
    if (!tz) return null;
    if (tz.startsWith("Australia/")) return "AU";
    if (tz === "Pacific/Auckland" || tz === "Pacific/Chatham") return "NZ";
    if (tz === "Europe/London" || tz === "Europe/Belfast") return "GB";
    if (tz === "Europe/Dublin") return "IE";
    if (tz.startsWith("Europe/")) return "DE"; // any EU -> 112
    if (tz === "Asia/Tokyo") return "JP";
    if (tz === "Asia/Shanghai" || tz === "Asia/Hong_Kong") return "CN";
    if (tz === "Asia/Seoul") return "KR";
    if (tz === "Asia/Kolkata" || tz === "Asia/Calcutta") return "IN";
    if (tz === "Asia/Singapore") return "SG";
    if (tz === "Asia/Dubai") return "AE";
    if (tz.startsWith("America/Toronto") || tz.startsWith("America/Vancouver") || tz.startsWith("America/Montreal") || tz.startsWith("America/Halifax") || tz.startsWith("America/Edmonton") || tz.startsWith("America/Winnipeg")) return "CA";
    if (tz.startsWith("America/Mexico")) return "MX";
    if (tz.startsWith("America/Sao_Paulo") || tz.startsWith("America/Bahia") || tz.startsWith("America/Fortaleza")) return "BR";
    if (tz.startsWith("America/")) return "US";
    if (tz === "Africa/Johannesburg") return "ZA";
    return null;
  }

  // Reverse-geocode lat/lng -> ISO country code via Google. Aggressively
  // timed out (1.5s) because this runs on the wellness-call TwiML hot path
  // and we'd rather fall back to timezone than make the user wait on the line.
  async function countryFromLatLng(lat: number, lng: number): Promise<string | null> {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) return null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      const resp = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&result_type=country&key=${key}`,
        { signal: ctrl.signal }
      );
      clearTimeout(timer);
      const data: any = await resp.json();
      const country = data?.results?.[0]?.address_components?.find((c: any) => c.types?.includes("country"));
      return country?.short_name || null;
    } catch {
      return null;
    }
  }

  // Returns the best emergency number we can determine for this user.
  // Priority: GPS reverse-geocode -> timezone heuristic -> "911" default.
  // Also returns a friendly phrase usable in TwiML/SMS.
  async function getEmergencyInfoForUser(user: { id: string; timezone: string; lastHeartbeatLat: number | null; lastHeartbeatLng: number | null }): Promise<{ number: string; phrase: string; country: string | null }> {
    let country: string | null = null;
    if (user.lastHeartbeatLat != null && user.lastHeartbeatLng != null) {
      country = await countryFromLatLng(user.lastHeartbeatLat, user.lastHeartbeatLng);
    }
    if (!country) country = countryFromTimezone(user.timezone);
    const number = (country && EMERGENCY_NUMBERS[country]) || "911";
    const phrase = country
      ? `your local emergency services on ${number}`
      : `your local emergency services, ${number}`;
    return { number, phrase, country };
  }

  // Reusable: wrap text in calm-paced SSML for Polly Joanna Neural.
  // Polly Neural voices sound much more natural than Google Neural2 over the
  // phone, and prosody rate=92% gives a measured, professional pace.
  const calm = (text: string) => `<prosody rate="92%">${text}</prosody>`;

  app.post("/api/wellness-call/respond", verifyTwilioSignature, async (req, res) => {
    try {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="/api/wellness-call/gather" method="POST" timeout="15">
    <Say voice="Polly.Joanna-Neural">${calm("Hello, this is StillHere. We noticed you missed your safety check-in.")}</Say>
    <Pause length="1"/>
    <Say voice="Polly.Joanna-Neural">${calm("Press 1 if you're okay. Press 2 if you need help.")}</Say>
    <Pause length="3"/>
    <Say voice="Polly.Joanna-Neural">${calm("Take your time. Press 1 if you're safe. Press 2 if you need help.")}</Say>
  </Gather>
  <Say voice="Polly.Joanna-Neural">${calm("No response was received. Your safety circle will be notified shortly. Take care.")}</Say>
  <Hangup/>
</Response>`;
      res.type("text/xml").send(twiml);
    } catch (error) {
      console.error("Error in wellness call TwiML:", error);
      res.status(500).send("");
    }
  });

  app.post("/api/wellness-call/gather", verifyTwilioSignature, async (req, res) => {
    try {
      const digits = req.body.Digits;
      const calledNumber = req.body.To;

      const normalizedPhone = calledNumber ? (calledNumber.startsWith("+") ? calledNumber : `+${calledNumber}`) : null;
      const user = normalizedPhone ? await storage.getUserByPhone(normalizedPhone) : null;

      if (digits === "1" && user) {
        // Use the latest real (non-drill) open incident. If wellnessCallStatus
        // already terminal (e.g. duplicate webhook delivery), short-circuit.
        const openIncidentForUser = await storage.getLatestRealOpenIncident(user.id);
        if (openIncidentForUser?.wellnessCallStatus === "safe" || openIncidentForUser?.wellnessCallStatus === "help") {
          console.log(`[WELLNESS CALL] Press 1 received but incident ${openIncidentForUser.id} already terminal (${openIncidentForUser.wellnessCallStatus}). Ignoring duplicate.`);
          const twimlDup = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Joanna-Neural">${calm("Thank you. You are already checked in. Take care.")}</Say><Hangup/></Response>`;
          return res.type("text/xml").send(twimlDup);
        }
        if (openIncidentForUser) {
          await storage.updateIncident(openIncidentForUser.id, { wellnessCallStatus: "safe" });
        }
        const result = await resolveCheckin(user.id, "call");
        console.log(`[WELLNESS CALL] User ***${(user.phone || user.id).slice(-4)} confirmed safe via phone call, hadIncident=${result.hadIncident}`);
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${calm("Wonderful. Thank you for confirming.")}</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna-Neural">${calm("You are now checked in, and your safety circle has been notified that you are safe.")}</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna-Neural">${calm("Take care, and have a lovely day.")}</Say>
  <Pause length="1"/>
  <Hangup/>
</Response>`;
        return res.type("text/xml").send(twiml);
      }

      if (digits === "2" && user) {
        console.log(`[WELLNESS CALL] User ***${(user.phone || user.id).slice(-4)} pressed 2. SOS triggered via phone call.`);

        // Reuse the latest real (non-drill) open incident if one exists.
        // Never mutate a drill incident into a real SOS. If the only open
        // incident is a drill, create a fresh SOS incident alongside it.
        let incident = await storage.getLatestRealOpenIncident(user.id);

        // Idempotency: if this incident already records wellnessCallStatus
        // "help" (duplicate Twilio webhook delivery), skip the fan-out.
        if (incident?.wellnessCallStatus === "help") {
          console.log(`[WELLNESS CALL] Press 2 received but incident ${incident.id} already marked help. Ignoring duplicate.`);
          const twimlDup = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Joanna-Neural">${calm("We hear you. Help is on the way. We are right here with you.")}</Say><Pause length="2"/><Redirect method="POST">/api/wellness-call/comfort?cycle=1</Redirect></Response>`;
          return res.type("text/xml").send(twimlDup);
        }

        if (incident) {
          await storage.updateIncident(incident.id, {
            reason: "sos",
            wellnessCallStatus: "help",
          });
        } else {
          incident = await storage.createIncident(user.id, "sos");
          await storage.updateIncident(incident.id, { wellnessCallStatus: "help" });
        }
        await storage.updateSafetyState(user.id, "concern", "User pressed 2 on wellness call. Needs help.");

        // Fan out to ALL contacts in parallel (SMS + push)  -  the user audibly
        // confirmed they need help, so we don't wait for sequential escalation.
        const sosCont = await storage.getContacts(user.id);
        const sortedSos = [...sosCont].sort((a, b) => a.priority - b.priority);
        const sosTokens = await storage.regenerateTokensForUser(user.id);
        const sosBaseUrl = getBaseUrl();
        const notifiedIds: string[] = [];

        await Promise.all(sortedSos.map(async (contact) => {
          const tok = sosTokens.find(t => t.contact.id === contact.id);
          if (!tok) return;
          const link = `${sosBaseUrl}/emergency/${tok.token}`;
          try {
            await notifyContact(contact, user.name, link, "sos", sendSosAlert);
            notifiedIds.push(contact.id);
          } catch (err: any) {
            console.error(`[WELLNESS CALL] SOS notify failed for contact ${contact.id}:`, err?.message || err);
          }
        }));

        const now = new Date();
        const existingTimeline: any[] = (() => {
          try { return JSON.parse(incident.escalationTimeline || "[]"); } catch { return []; }
        })();
        existingTimeline.push({
          type: "wellness_call_help",
          time: now.toISOString(),
          detail: `User pressed 2 on wellness call  -  notified ${notifiedIds.length} contact(s)`,
        });
        await storage.updateIncident(incident.id, {
          escalationLevel: Math.max(incident.escalationLevel || 0, 1),
          lastEscalationStep: "wellness_call_help",
          notifiedContactIds: JSON.stringify(notifiedIds),
          lastContactNotifiedAt: now,
          contact1NotifiedAt: incident.contact1NotifiedAt || now,
          nextActionAt: addMinutes(now, 5),
          escalationTimeline: JSON.stringify(existingTimeline),
        });

        // Push to all linked watcher accounts in-app
        await notifyConcern(user.id, user.name, "sos").catch((err) => {
          console.error(`[WELLNESS CALL] notifyConcern failed:`, err?.message || err);
        });

        // Real-time socket broadcast so watcher dashboards refresh instantly
        try {
          const watcherContacts = await storage.getContactsLinkedToUser(user.id);
          for (const c of watcherContacts) {
            if (c.linkedUserId) {
              emitToUser(c.linkedUserId, "watched-users:invalidate", { userId: user.id });
            }
          }
        } catch (err: any) {
          console.error(`[WELLNESS CALL] Socket broadcast failed:`, err?.message || err);
        }

        console.log(`[WELLNESS CALL] SOS notified ${notifiedIds.length}/${sortedSos.length} contacts for ${user.name}`);

        // ----- "We care" wraparound: keep the user supported, don't just hang up -----
        // Resolve the user's local emergency number from their last known
        // location (GPS) with timezone fallback, so we say "999" in the UK,
        // "000" in Australia, "112" in the EU, etc.  -  not just "911".
        const emergency = await getEmergencyInfoForUser(user as any);
        console.log(`[WELLNESS CALL] Local emergency number for ${user.name}: ${emergency.number} (country=${emergency.country || "unknown"})`);

        // 1. Text the USER themselves so they have a written record of who's coming
        //    and a clear local-emergency prompt, even if they hang up the call.
        if (user.phone) {
          const notifiedNames = sortedSos
            .filter(c => notifiedIds.includes(c.id))
            .map(c => c.name);
          const namesLine = notifiedNames.length > 0
            ? `${notifiedNames.slice(0, 3).join(", ")}${notifiedNames.length > 3 ? ` and ${notifiedNames.length - 3} more` : ""}`
            : "your safety circle";
          const userSmsBody = `StillHere: We hear you. ${namesLine} ${notifiedNames.length === 1 ? "has" : "have"} been alerted and ${notifiedNames.length === 1 ? "is" : "are"} on the way.\n\nIf this is life-threatening, call ${emergency.number} now.\n\nYou are not alone. Stay safe.`;
          sendSms(user.phone, userSmsBody).catch((err: any) => {
            console.error(`[WELLNESS CALL] User SMS failed:`, err?.message || err);
          });
        }

        // 2. Push the user's own device with a "we're with you" card linking to
        //    the live SOS view (one-tap emergency, primary contact, location share).
        sendPushNotification(user.id, {
          title: "We're with you",
          body: `${notifiedIds.length} contact${notifiedIds.length === 1 ? "" : "s"} alerted. Tap for one-tap ${emergency.number}, contact call, and live location.`,
          tag: "sos-active",
          url: "/sos",
        }).catch((err: any) => {
          console.error(`[WELLNESS CALL] User push failed:`, err?.message || err);
        });

        // 3. Keep the call alive with a real menu + comfort loop instead of
        //    saying "stay on the line" then hanging up after 3 seconds.
        const primaryName = sortedSos[0]?.name || "your primary contact";
        const safePrimary = escapeXml(primaryName);
        const safeUserName = escapeXml(user.name);
        const safeEmergency = escapeXml(emergency.number);
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${calm(`We hear you, ${safeUserName}. You are not alone. Help is on the way right now.`)}</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna-Neural">${calm(`${notifiedIds.length} ${notifiedIds.length === 1 ? "person has" : "people have"} been alerted, including ${safePrimary}. We are also sending you a text message with their names.`)}</Say>
  <Pause length="1"/>
  <Gather numDigits="1" action="/api/wellness-call/help-followup" method="POST" timeout="15">
    <Say voice="Polly.Joanna-Neural">${calm(`To be connected directly to ${safePrimary} right now, press 1.`)}</Say>
    <Pause length="1"/>
    <Say voice="Polly.Joanna-Neural">${calm(`If this is life-threatening, please hang up and dial ${safeEmergency} now. Or, press 0 for guidance.`)}</Say>
    <Pause length="1"/>
    <Say voice="Polly.Joanna-Neural">${calm("Or simply stay on the line. We will stay with you until help arrives.")}</Say>
  </Gather>
  <Redirect method="POST">/api/wellness-call/comfort?cycle=1</Redirect>
</Response>`;
        return res.type("text/xml").send(twiml);
      }

      if (user) {
        // Caller didn't press 1 or 2. Record the no-response on the open real
        // incident so the watcher dashboard can show "called, no answer".
        // Never mutate drill incidents from the wellness flow.
        const noResponseIncident = await storage.getLatestRealOpenIncident(user.id);
        if (noResponseIncident && noResponseIncident.wellnessCallStatus !== "safe" && noResponseIncident.wellnessCallStatus !== "help") {
          await storage.updateIncident(noResponseIncident.id, { wellnessCallStatus: "no_response" });
          try {
            const watcherContacts = await storage.getContactsLinkedToUser(user.id);
            for (const c of watcherContacts) {
              if (c.linkedUserId) {
                emitToUser(c.linkedUserId, "watched-users:invalidate", { userId: user.id });
              }
            }
          } catch {}
        }
      }
      if (!user && normalizedPhone) {
        console.error(`[WELLNESS CALL] No user found for phone ${normalizedPhone.slice(-4)}`);
      }

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Joanna-Neural">${calm("We didn't receive a response. Your safety circle will be notified shortly. Take care.")}</Say><Hangup/></Response>`;
      res.type("text/xml").send(twiml);
    } catch (error) {
      console.error("Error in wellness call gather:", error);
      res.status(500).send("");
    }
  });

  // After the user pressed 2 ("I need help"), this handles the second-tier
  // menu so we never just leave them on a dead line.
  app.post("/api/wellness-call/help-followup", verifyTwilioSignature, async (req, res) => {
    try {
      const digits = req.body.Digits;
      const calledNumber = req.body.To;
      const normalizedPhone = calledNumber ? (calledNumber.startsWith("+") ? calledNumber : `+${calledNumber}`) : null;
      const user = normalizedPhone ? await storage.getUserByPhone(normalizedPhone) : null;

      // Press 1 -> patch them through to their primary contact via <Dial>
      if (digits === "1" && user) {
        const allContacts = await storage.getContacts(user.id);
        const sorted = [...allContacts].sort((a, b) => a.priority - b.priority);
        const primary = sorted[0];
        if (primary && primary.phone) {
          const safeName = escapeXml(primary.name);
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${calm(`Connecting you to ${safeName} now. Please hold.`)}</Say>
  <Dial timeout="25" callerId="${process.env.TWILIO_PHONE_NUMBER || ""}" answerOnBridge="true">
    <Number>${escapeXml(primary.phone)}</Number>
  </Dial>
  <Say voice="Polly.Joanna-Neural">${calm(`We could not reach ${safeName} right now. We will keep trying your safety circle. Stay with us.`)}</Say>
  <Redirect method="POST">/api/wellness-call/comfort?cycle=1</Redirect>
</Response>`;
          return res.type("text/xml").send(twiml);
        }
        // No contact available -> fall through to comfort
        const emergencyNoContact = user ? await getEmergencyInfoForUser(user as any) : { number: "911" };
        const twimlNoContact = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${calm(`We don't have a contact phone number on file to connect you to. Please call ${emergencyNoContact.number} if this is life-threatening. We will stay with you.`)}</Say>
  <Redirect method="POST">/api/wellness-call/comfort?cycle=1</Redirect>
</Response>`;
        return res.type("text/xml").send(twimlNoContact);
      }

      // Press 0 -> emergency services guidance, with user's local number
      if (digits === "0") {
        const emergency = user ? await getEmergencyInfoForUser(user as any) : { number: "911" };
        const safeEmergency = escapeXml(emergency.number);
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${calm(`If this is a life-threatening emergency, please hang up now and dial ${safeEmergency}. Your safety circle has already been alerted, and we will keep them updated.`)}</Say>
  <Pause length="2"/>
  <Say voice="Polly.Joanna-Neural">${calm("If you cannot hang up, stay with us. We are right here with you.")}</Say>
  <Redirect method="POST">/api/wellness-call/comfort?cycle=1</Redirect>
</Response>`;
        return res.type("text/xml").send(twiml);
      }

      // Anything else (timeout, other digit) -> comfort loop
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Redirect method="POST">/api/wellness-call/comfort?cycle=1</Redirect></Response>`;
      res.type("text/xml").send(twiml);
    } catch (error) {
      console.error("Error in wellness call help-followup:", error);
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Redirect method="POST">/api/wellness-call/comfort?cycle=1</Redirect></Response>`);
    }
  });

  // Comfort loop: stays on the call with the user, gently checking in, instead
  // of hanging up. Bounded to 3 cycles (~3 min) so the call eventually ends if
  // they truly cannot respond, but every cycle re-offers the "press 1 to be
  // connected" option.
  app.post("/api/wellness-call/comfort", verifyTwilioSignature, async (req, res) => {
    try {
      const cycle = Math.max(1, Math.min(parseInt(String(req.query.cycle || "1"), 10) || 1, 3));
      const calledNumber = req.body.To;
      const normalizedPhone = calledNumber ? (calledNumber.startsWith("+") ? calledNumber : `+${calledNumber}`) : null;
      const user = normalizedPhone ? await storage.getUserByPhone(normalizedPhone) : null;

      let primaryName = "your primary contact";
      let emergencyNumber = "911";
      if (user) {
        const allContacts = await storage.getContacts(user.id);
        const sorted = [...allContacts].sort((a, b) => a.priority - b.priority);
        if (sorted[0]) primaryName = sorted[0].name;
        const e = await getEmergencyInfoForUser(user as any);
        emergencyNumber = e.number;
      }
      const safePrimary = escapeXml(primaryName);
      const safeEmergency = escapeXml(emergencyNumber);

      // Final cycle -> warm sign-off (never just a dead "Goodbye")
      if (cycle >= 3) {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${calm(`We need to end this call now so the line stays open for ${safePrimary}, but we are not leaving you. Your safety circle has been alerted, you have a text message from us, and we will check on you again very soon.`)}</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna-Neural">${calm(`If you are in danger right now, please call ${safeEmergency}. You are not alone. Take care.`)}</Say>
  <Hangup/>
</Response>`;
        return res.type("text/xml").send(twiml);
      }

      // Reassurance varies a little per cycle so it doesn't feel robotic
      const reassurance = cycle === 1
        ? `We are still right here with you. ${safePrimary} has been alerted and is on the way.`
        : `Hang in there. Your safety circle has been notified, and someone will reach you very soon.`;

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${calm(reassurance)}</Say>
  <Pause length="2"/>
  <Say voice="Polly.Joanna-Neural">${calm("Let's take a slow breath together. Breathe in.")}</Say>
  <Pause length="2"/>
  <Say voice="Polly.Joanna-Neural">${calm("And gently breathe out. You are doing great.")}</Say>
  <Pause length="2"/>
  <Gather numDigits="1" action="/api/wellness-call/help-followup" method="POST" timeout="20">
    <Say voice="Polly.Joanna-Neural">${calm(`Press 1 anytime to be connected directly to ${safePrimary}. Press 0 for emergency services guidance. Or just stay on the line with us.`)}</Say>
  </Gather>
  <Redirect method="POST">/api/wellness-call/comfort?cycle=${cycle + 1}</Redirect>
</Response>`;
      res.type("text/xml").send(twiml);
    } catch (error) {
      console.error("Error in wellness call comfort:", error);
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Joanna-Neural">${calm("You are not alone. Help is on the way. Take care.")}</Say><Hangup/></Response>`);
    }
  });

  const locationWakeThrottles = new Map<string, number>();
  let cronRunning = false;

  // Cron tick - check for due users (internal only)
  app.get("/api/cron/tick", async (req, res) => {
    try {
      const cronSecret = process.env.SESSION_SECRET;
      if (!cronSecret) {
        console.error("[CRON] SESSION_SECRET not configured, rejecting cron request");
        return res.status(500).json({ error: "Server misconfigured" });
      }
      const providedSecret = req.headers["x-cron-secret"];
      if (providedSecret !== cronSecret) {
        return res.status(403).json({ error: "Forbidden" });
      }

      if (cronRunning) {
        return res.json({ skipped: true, reason: "previous tick still running" });
      }
      cronRunning = true;

      const overdueUsers = await storage.getOverdueUsersWithSettings();
      const baseUrl = getBaseUrl();
      
      let remindersSent = 0;
      let alertsSent = 0;
      const now = new Date();
      const REMINDER_THROTTLE_MINUTES = 5; // Minimum time between reminders
      
      for (const { user, settings, isDueForAlert } of overdueUsers) {
        if (isDueForAlert) {
          const existingOpenIncident = await storage.getOpenIncident(user.id);
          if (existingOpenIncident) {
            console.log(`[ALERT] Skipping checkin alert for ${user.name}  -  open incident already exists (${existingOpenIncident.reason})`);
            continue;
          }

          const reminderHistory = await storage.getReminderTimeline(user.id);
          const timeStr = now.toISOString();
          const graceMs = (settings.graceMinutes || 15) * 60 * 1000;

          let incident = await storage.createIncident(user.id, "missed_checkin");
          await storage.updateSafetyState(user.id, "concern", "Missed check-in");

          const timeline = [...reminderHistory];
          timeline.push({ type: "push", time: timeStr, detail: "Push notification sent to user" });

          await sendReminderPush(user.id, user.name);
          console.log(`[ESCALATION] Step 1/3: Push sent to ${user.name}`);

          if (settings.locationMode === "emergency_only" || settings.locationMode === "both") {
            await storage.createLocationSession(user.id, "emergency", incident.id);
          }

          await storage.regenerateTokensForUser(user.id);

          await storage.updateIncident(incident.id, {
            escalationLevel: 0,
            lastEscalationStep: "push",
            pushSentAt: now,
            nextActionAt: new Date(now.getTime() + graceMs),
            notifiedContactIds: "[]",
            escalationTimeline: JSON.stringify(timeline),
          });

          alertsSent++;
          await storage.resetReminderState(user.id);
          continue;
        }

        const remindersSentSoFar = settings.remindersSent || 0;
        const maxReminders = settings.reminderMode === "none" ? 0
          : settings.reminderMode === "one" ? 1
          : 2;

        if (remindersSentSoFar < maxReminders) {
          const timeSinceLastReminder = settings.lastReminderAt
            ? (now.getTime() - new Date(settings.lastReminderAt).getTime()) / (1000 * 60)
            : Infinity;

          if (timeSinceLastReminder >= REMINDER_THROTTLE_MINUTES) {
            const reminderNumber = remindersSentSoFar + 1;
            console.log(`[REMINDER] Sending reminder ${reminderNumber}/${maxReminders}`);

            const checkInLink = `${baseUrl}/`;
            const timeStr = now.toISOString();

            if (reminderNumber === 1) {
              await sendReminderPush(user.id, user.name);
              await storage.addReminderTimelineEntry(user.id, { type: "push", time: timeStr, detail: "Push notification sent" });
              console.log("[REMINDER] Push notification sent");
            } else {
              if (user.phone) {
                await sendReminderSms(user.phone, checkInLink, !!settings.smsCheckinEnabled);
                await storage.addReminderTimelineEntry(user.id, { type: "sms", time: timeStr, detail: "SMS reminder sent" });
                console.log("[REMINDER] SMS sent");
              } else {
                await sendReminderPush(user.id, user.name);
                await storage.addReminderTimelineEntry(user.id, { type: "push", time: timeStr, detail: "Push notification sent (no phone)" });
                console.log("[REMINDER] Push notification sent (no phone for SMS)");
              }
            }

            await storage.incrementRemindersSent(user.id);
            remindersSent++;
          }
        }
      }
      
      let escalations = 0;
      const incidentsNeedingEscalation = await storage.getIncidentsNeedingEscalation();
      const MAX_SEQUENTIAL = 5;

      for (const incident of incidentsNeedingEscalation) {
        const user = await storage.getUser(incident.userId);
        if (!user) continue;

        const userSettings = await storage.getSettings(incident.userId);
        const escalationMinutes = userSettings?.escalationMinutes || 20;
        const graceMs = (userSettings?.graceMinutes || 15) * 60 * 1000;

        const contacts = await storage.getContacts(incident.userId);
        const tokens = await storage.getContactTokensForUser(incident.userId);
        const sortedContacts = [...contacts].sort((a, b) => a.priority - b.priority);

        let notifiedIds: string[] = [];
        try { notifiedIds = JSON.parse(incident.notifiedContactIds || "[]"); } catch { notifiedIds = []; }

        const step = incident.lastEscalationStep || null;
        const existingTimeline: any[] = JSON.parse(incident.escalationTimeline || "[]");
        const timeStr = now.toISOString();

        if (incident.status === "paused") {
          console.log(`[ESCALATION] Handling timeout, re-notifying all contacts`);
          for (const contact of contacts) {
            const token = tokens.find(t => t.contact.id === contact.id);
            if (token) {
              const link = `${baseUrl}/emergency/${token.token}`;
              const normalizedPhone = normalizePhone(contact.phone);
              await sendHandlingTimeoutAlert(normalizedPhone, user.name, link);
            }
          }
          const firstContact = sortedContacts[0];
          await storage.updateIncident(incident.id, {
            status: "open",
            handledByContactId: null,
            escalationLevel: 1,
            lastEscalationStep: "contact_1",
            notifiedContactIds: JSON.stringify(firstContact ? [firstContact.id] : []),
            lastContactNotifiedAt: now,
            allContactsNotifiedAt: null,
            userNotifiedNoResponseAt: null,
            contact1NotifiedAt: now,
            contact2NotifiedAt: null,
            nextActionAt: addMinutes(now, escalationMinutes),
          });
          console.log("[ESCALATION] Handling timeout alerts sent, escalation reset");
          escalations++;
          continue;
        }

        if (incident.status !== "open") continue;

        if (step === "push") {
          console.log(JSON.stringify({ event: "CONTACT_BLOCKED", reason: "escalation in progress  -  step: push→sms", userId: user.id, incidentId: incident.id, timestamp: timeStr }));
          const checkInLink = `${baseUrl}/`;
          if (user.phone) {
            await sendReminderSms(user.phone, checkInLink, !!userSettings?.smsCheckinEnabled);
            existingTimeline.push({ type: "sms", time: timeStr, detail: "SMS reminder sent to user  -  still trying to reach them" });
            console.log(`[ESCALATION] Step 2/3: SMS sent to ${user.name} (***${user.phone.slice(-4)})`);
          } else {
            await sendReminderPush(user.id, user.name);
            existingTimeline.push({ type: "push", time: timeStr, detail: "Push reminder sent (no phone)  -  still trying to reach them" });
            console.log(`[ESCALATION] Step 2/3: Push sent to ${user.name} (no phone for SMS)`);
          }
          await storage.updateIncident(incident.id, {
            lastEscalationStep: "sms",
            smsSentAt: now,
            nextActionAt: new Date(now.getTime() + graceMs),
            escalationTimeline: JSON.stringify(existingTimeline),
          });
          escalations++;
          continue;
        }

        if (step === "sms") {
          console.log(JSON.stringify({ event: "CONTACT_BLOCKED", reason: "escalation in progress  -  step: sms→call", userId: user.id, incidentId: incident.id, timestamp: timeStr }));
          const autoWellnessCallFlag = !!(userSettings as any)?.autoWellnessCall;
          const twilioReady = isTwilioConfigured();
          const hasPhone = !!user.phone;
          const wellnessCallEnabled = autoWellnessCallFlag && twilioReady && hasPhone;

          console.log(JSON.stringify({
            event: "CALL_FLOW_DIAGNOSTIC",
            userId: user.id,
            userName: user.name,
            autoWellnessCallEnabled: autoWellnessCallFlag,
            twilioConfigured: twilioReady,
            hasPhone,
            phoneLast4: hasPhone ? `***${user.phone.slice(-4)}` : null,
            willAttemptCall: wellnessCallEnabled,
            incidentId: incident.id,
            timestamp: timeStr,
          }));

          if (wellnessCallEnabled) {
            try {
              console.log(`[ESCALATION] Step 3/3: Calling ${user.name} (***${user.phone.slice(-4)})`);
              const twilio = (await import("twilio")).default;
              const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
              const callResult = await client.calls.create({
                to: user.phone,
                from: process.env.TWILIO_PHONE_NUMBER!,
                url: `${baseUrl}/api/wellness-call/respond`,
                method: "POST",
              });
              existingTimeline.push({ type: "call", time: timeStr, detail: "Wellness call placed" });
              console.log(`[ESCALATION] Call placed (SID: ${callResult.sid})`);

              console.log(JSON.stringify({
                event: "CALL_FLOW_RESULT",
                userId: user.id,
                userName: user.name,
                callPlaced: true,
                callSid: callResult.sid,
                timestamp: timeStr,
              }));

              await storage.updateIncident(incident.id, {
                lastEscalationStep: "call",
                callSentAt: now,
                nextActionAt: addMinutes(now, 2),
                escalationTimeline: JSON.stringify(existingTimeline),
              });
              escalations++;
              continue;
            } catch (err: any) {
              const callError = err?.message || "unknown error";
              existingTimeline.push({ type: "call_failed", time: timeStr, detail: `Wellness call failed: ${callError}` });
              console.error(`[ESCALATION] Wellness call FAILED for ${user.name}: ${callError}  -  falling through to contacts`);
            }
          } else {
            const reasons = [];
            if (!autoWellnessCallFlag) reasons.push("autoWellnessCall disabled");
            if (!twilioReady) reasons.push("Twilio not configured");
            if (!hasPhone) reasons.push("no phone number");
            console.log(`[ESCALATION] Skipping call for ${user.name}: ${reasons.join(", ")}  -  advancing to contacts`);
          }

          const firstContact = sortedContacts[0];
          if (firstContact) {
            const token = tokens.find(t => t.contact.id === firstContact.id);
            if (token) {
              const link = `${baseUrl}/emergency/${token.token}`;
              console.log(JSON.stringify({ event: "CONTACT_SENT", type: "alert", contactName: firstContact.name, reason: incident.reason, userId: user.id, step: "sms_fallthrough", timestamp: timeStr }));
              const smsFn = incident.reason === "sos" ? sendSosAlert : sendMissedCheckinAlert;
              await notifyContact(firstContact, user.name, link, incident.reason as "sos" | "missed_checkin", smsFn);
              existingTimeline.push({ type: "contact_alert", time: timeStr, detail: `All attempts exhausted  -  emergency contact notified: ${firstContact.name}` });
            }
          }
          notifyConcern(user.id, user.name, incident.reason as any).catch((err) => {
            console.error(`[ESCALATION] notifyConcern failed:`, err?.message || err);
          });
          await storage.updateIncident(incident.id, {
            escalationLevel: 1,
            lastEscalationStep: "contact_1",
            notifiedContactIds: JSON.stringify(firstContact ? [firstContact.id] : []),
            lastContactNotifiedAt: now,
            contact1NotifiedAt: now,
            nextActionAt: addMinutes(now, escalationMinutes),
            escalationTimeline: JSON.stringify(existingTimeline),
          });
          escalations++;
          continue;
        }

        if (step === "call") {
          const firstContact = sortedContacts[0];
          if (firstContact) {
            const token = tokens.find(t => t.contact.id === firstContact.id);
            if (token) {
              const link = `${baseUrl}/emergency/${token.token}`;
              console.log(JSON.stringify({ event: "CONTACT_SENT", type: "alert", contactName: firstContact.name, reason: incident.reason, userId: user.id, step: "call_unanswered", timestamp: timeStr }));
              const smsFn = incident.reason === "sos" ? sendSosAlert : sendMissedCheckinAlert;
              await notifyContact(firstContact, user.name, link, incident.reason as "sos" | "missed_checkin", smsFn);
              existingTimeline.push({ type: "contact_alert", time: timeStr, detail: `Call unanswered, all attempts exhausted  -  emergency contact notified: ${firstContact.name}` });
            }
          }
          notifyConcern(user.id, user.name, incident.reason as any).catch((err) => {
            console.error(`[ESCALATION] notifyConcern failed:`, err?.message || err);
          });
          await storage.updateIncident(incident.id, {
            escalationLevel: 1,
            lastEscalationStep: "contact_1",
            notifiedContactIds: JSON.stringify(firstContact ? [firstContact.id] : []),
            lastContactNotifiedAt: now,
            contact1NotifiedAt: now,
            nextActionAt: addMinutes(now, escalationMinutes),
            escalationTimeline: JSON.stringify(existingTimeline),
          });
          escalations++;
          continue;
        }

        if (step && step.startsWith("contact_")) {
          const lastNotifiedAt = incident.lastContactNotifiedAt || incident.contact1NotifiedAt;
          if (!lastNotifiedAt) {
            await storage.updateIncident(incident.id, {
              lastContactNotifiedAt: now,
              nextActionAt: addMinutes(now, escalationMinutes),
            });
            continue;
          }

          const ESCALATION_WINDOW_MS = escalationMinutes * 60 * 1000;
          const elapsedMs = now.getTime() - lastNotifiedAt.getTime();
          if (elapsedMs < ESCALATION_WINDOW_MS) {
            const remainingMs = ESCALATION_WINDOW_MS - elapsedMs;
            await storage.updateIncident(incident.id, {
              nextActionAt: new Date(now.getTime() + remainingMs + 60000),
            });
            continue;
          }

          const sequentialContacts = sortedContacts.slice(0, MAX_SEQUENTIAL);
          const nextSequential = sequentialContacts.find(c => !notifiedIds.includes(c.id));

          if (nextSequential) {
            const token = tokens.find(t => t.contact.id === nextSequential.id);
            if (token) {
              const link = `${baseUrl}/emergency/${token.token}`;
              console.log(JSON.stringify({ event: "CONTACT_SENT", type: "alert", contactName: nextSequential.name, reason: incident.reason, userId: user.id, step: `escalation_contact_${notifiedIds.length + 1}`, timestamp: timeStr }));
              const reason = incident.reason as "sos" | "missed_checkin";
              await notifyContact(nextSequential, user.name, link, reason, (p, n, l) => sendEscalationAlert(p, n, l, reason));
            }
            existingTimeline.push({ type: "contact_escalation", time: timeStr, detail: `Escalated to: ${nextSequential.name}` });
            notifiedIds.push(nextSequential.id);
            const newLevel = notifiedIds.length;
            const updateData: any = {
              escalationLevel: newLevel,
              lastEscalationStep: `contact_${newLevel}`,
              notifiedContactIds: JSON.stringify(notifiedIds),
              lastContactNotifiedAt: now,
              nextActionAt: addMinutes(now, escalationMinutes),
              escalationTimeline: JSON.stringify(existingTimeline),
            };
            if (newLevel === 2) updateData.contact2NotifiedAt = now;
            await storage.updateIncident(incident.id, updateData);
            escalations++;
            continue;
          }

          const remainingContacts = sortedContacts.filter(c => !notifiedIds.includes(c.id));
          if (remainingContacts.length > 0 && !incident.allContactsNotifiedAt) {
            console.log(`[ESCALATION] Top ${MAX_SEQUENTIAL} exhausted, blasting ${remainingContacts.length} remaining`);
            for (const contact of remainingContacts) {
              const token = tokens.find(t => t.contact.id === contact.id);
              if (token) {
                const link = `${baseUrl}/emergency/${token.token}`;
                const reason = incident.reason as "sos" | "missed_checkin";
                await notifyContact(contact, user.name, link, reason, (p, n, l) => sendEscalationAlert(p, n, l, reason));
              }
              notifiedIds.push(contact.id);
            }
            await storage.updateIncident(incident.id, {
              escalationLevel: notifiedIds.length,
              lastEscalationStep: `contact_${notifiedIds.length}`,
              notifiedContactIds: JSON.stringify(notifiedIds),
              allContactsNotifiedAt: now,
              lastContactNotifiedAt: now,
              nextActionAt: addMinutes(now, escalationMinutes),
              escalationTimeline: JSON.stringify(existingTimeline),
            });
            escalations++;
            continue;
          }

          if (!incident.userNotifiedNoResponseAt) {
            console.log(`[ESCALATION] No contacts responded, updating in-app status`);
            await storage.updateIncident(incident.id, {
              userNotifiedNoResponseAt: now,
              nextActionAt: addMinutes(now, 30),
            });
            escalations++;
            continue;
          }

          await storage.updateIncident(incident.id, {
            nextActionAt: addMinutes(now, 30),
          });
        }

        if (!step) {
          if (incident.reason === "missed_checkin") {
            existingTimeline.push({ type: "push", time: timeStr, detail: "Push notification sent (legacy recovery)" });
            await sendReminderPush(user.id, user.name);
            await storage.updateIncident(incident.id, {
              lastEscalationStep: "push",
              pushSentAt: now,
              nextActionAt: new Date(now.getTime() + graceMs),
              escalationTimeline: JSON.stringify(existingTimeline),
            });
          } else {
            const firstContact = sortedContacts[0];
            if (firstContact) {
              const token = tokens.find(t => t.contact.id === firstContact.id);
              if (token) {
                const link = `${baseUrl}/emergency/${token.token}`;
                const smsFn = incident.reason === "sos" ? sendSosAlert : sendMissedCheckinAlert;
                await notifyContact(firstContact, user.name, link, incident.reason as "sos" | "missed_checkin", smsFn);
                existingTimeline.push({ type: "contact_alert", time: timeStr, detail: `Emergency contact notified: ${firstContact.name} (legacy recovery)` });
              }
            }
            notifyConcern(user.id, user.name, incident.reason as any).catch(() => {});
            await storage.updateIncident(incident.id, {
              escalationLevel: 1,
              lastEscalationStep: "contact_1",
              notifiedContactIds: JSON.stringify(firstContact ? [firstContact.id] : []),
              lastContactNotifiedAt: now,
              contact1NotifiedAt: now,
              nextActionAt: addMinutes(now, escalationMinutes),
              escalationTimeline: JSON.stringify(existingTimeline),
            });
          }
          escalations++;
          continue;
        }
      }
      
      let reportsSent = 0;
      try {
        const dueReports = await storage.getDueReports();
        for (const pref of dueReports) {
          try {
            const watchedUser = await storage.getUser(pref.watchedUserId);
            const watcherUser = await storage.getUser(pref.watcherId);
            if (!watchedUser || !watcherUser) continue;

            const watchedSettings = await storage.getSettings(pref.watchedUserId);
            if (watchedSettings && !watchedSettings.allowReports) continue;

            const periodDays = pref.frequency === "daily" ? 1 : pref.frequency === "weekly" ? 7 : pref.frequency === "fortnightly" ? 14 : 30;
            const from = new Date(Date.now() - periodDays * 86400000);
            const now = new Date();
            const checkinList = await storage.getCheckinHistory(pref.watchedUserId, from, now);
            const incidentList = await storage.getIncidentHistory(pref.watchedUserId, from, now);

            const recipientEmail = pref.email || null;
            if (recipientEmail) {
              const { sendEmail } = await import("./email");
              const { format: fmtDate } = await import("date-fns");

              const checkinRows = checkinList.map(c =>
                `<tr><td>${fmtDate(c.createdAt, "MMM d, yyyy")}</td><td>${fmtDate(c.createdAt, "h:mm a")}</td><td>${c.method}</td></tr>`
              ).join("");
              const incidentRows = incidentList.map(i =>
                `<tr><td>${fmtDate(i.startedAt, "MMM d, yyyy")}</td><td>${i.reason === "sos" ? "SOS Alert" : "Missed Checkin"}</td><td>${i.status === "resolved" ? "Resolved" : "Open"}</td></tr>`
              ).join("");

              const complianceRate = Math.min(100, Math.round((checkinList.length / Math.max(1, periodDays)) * 100));

              const html = `
                <h2>StillHere Safety Report for ${watchedUser.name}</h2>
                <p>Report period: ${fmtDate(from, "MMM d, yyyy")} - ${fmtDate(now, "MMM d, yyyy")}</p>
                <h3>Summary</h3>
                <ul>
                  <li>Total checkins: ${checkinList.length}</li>
                  <li>Compliance rate: ${complianceRate}%</li>
                  <li>Incidents: ${incidentList.length}</li>
                </ul>
                ${checkinList.length > 0 ? `<h3>Checkin History</h3><table border="1" cellpadding="6"><tr><th>Date</th><th>Time</th><th>Method</th></tr>${checkinRows}</table>` : ""}
                ${incidentList.length > 0 ? `<h3>Incidents</h3><table border="1" cellpadding="6"><tr><th>Date</th><th>Type</th><th>Status</th></tr>${incidentRows}</table>` : ""}
                <p style="color:#888;font-size:12px;margin-top:20px;">This report was generated automatically by StillHere. ${watchedUser.name} has consented to share this information.</p>
              `;

              await sendEmail(recipientEmail, `StillHere Report: ${watchedUser.name} (${pref.frequency})`, html);
              reportsSent++;
            }

            await storage.updateReportLastSent(pref.id);
          } catch (err) {
            console.error(`[CRON] Report send failed for pref ${pref.id}:`, err);
          }
        }
      } catch (err) {
        console.error("[CRON] Report processing failed:", err);
      }

      let locationWakeups = 0;
      try {
        const allShares = await storage.getAllActiveLiveShares();
        for (const share of allShares) {
          if (share.expiresAt && new Date() > share.expiresAt) {
            await storage.stopLiveLocationShare(share.userId);
            continue;
          }
          const lastUpdate = share.lastUpdatedAt ? new Date(share.lastUpdatedAt).getTime() : 0;
          const staleMs = Date.now() - lastUpdate;
          const lastWake = locationWakeThrottles.get(share.userId) || 0;
          const sinceLastWake = Date.now() - lastWake;
          if (staleMs > 2 * 60 * 1000 && staleMs < 30 * 60 * 1000 && sinceLastWake > 5 * 60 * 1000) {
            try {
              const result = await sendPushNotification(share.userId, {
                title: "Location sharing active",
                body: "Tap to keep your location updating for your contacts.",
                tag: "location-wake",
                url: "/live-location",
              });
              locationWakeThrottles.set(share.userId, Date.now());
              if (result.sent > 0) {
                locationWakeups++;
              }
            } catch (err: any) {
              console.error(`[CRON] Location wake-up push failed for ${share.userId}:`, err?.message || err);
            }
          }
        }
        if (locationWakeups > 0) {
          console.log(`[CRON] Sent ${locationWakeups} location wake-up push(es)`);
        }
      } catch (err) {
        console.error("[CRON] Location heartbeat failed:", err);
      }

      let softDeletesCleaned = 0;
      try {
        softDeletesCleaned = await storage.cleanupExpiredSoftDeletes();
        if (softDeletesCleaned > 0) {
          console.log(`[CRON] Cleaned up ${softDeletesCleaned} expired soft-deleted contacts`);
        }
      } catch (err) {
        console.error("[CRON] Soft-delete cleanup failed:", err);
      }

      // Safety Timer escalation
      let timerEscalations = 0;
      try {
        const expiredTimers = await storage.getExpiredSafetyTimers();
        for (const timer of expiredTimers) {
          try {
            await storage.updateSafetyTimer(timer.id, { status: "escalated", resolvedAt: new Date() });
            const user = await storage.getUser(timer.userId);
            if (!user) continue;

            const incident = await storage.createIncident(timer.userId, "sos");
            await storage.updateSafetyState(timer.userId, "concern", "Safety timer expired");
            notifyConcern(timer.userId, user.name, "sos").catch((err) => {
              console.error(`[TIMER] notifyConcern failed for ${user.name}:`, err?.message || err);
            });
            const tokens = await storage.regenerateTokensForUser(timer.userId);
            const allContactIds: string[] = [];

            for (const { contact, token } of tokens) {
              const link = `${baseUrl}/emergency/${token}`;
              let locationInfo = "";
              if (timer.lastLat && timer.lastLng) {
                locationInfo = `\nLast known location: https://www.google.com/maps?q=${timer.lastLat},${timer.lastLng}`;
                if (timer.lastActivity) locationInfo += `\nActivity: ${timer.lastActivity}`;
              }
              const noteInfo = timer.note ? `\nNote: ${timer.note}` : "";

              if (contact.phone) {
                try {
                  await sendSms(contact.phone,
                    `StillHere ALERT: ${user.name}'s safety timer has expired and they have not responded.${noteInfo}${locationInfo}\n\nCheck their status: ${link}`
                  );
                } catch (err: any) {
                  console.error(`[TIMER] SMS to ${contact.name} (***${contact.phone.slice(-4)}) failed:`, err?.message || err);
                }
              } else {
                console.log(`[TIMER] Skipping SMS for ${contact.name}: no phone number`);
              }
              if (contact.email) {
                try {
                  const { sendEmail } = await import("./email");
                  await sendEmail(contact.email,
                    `StillHere Alert: ${user.name}'s Safety Timer Expired`,
                    `${user.name}'s safety timer has expired and they have not responded.${noteInfo}${locationInfo}\n\nCheck their status: ${link}`
                  );
                } catch (err: any) {
                  console.error(`[TIMER] Email to ${contact.name} failed:`, err?.message || err);
                }
              }
              allContactIds.push(contact.id);
            }

            await storage.updateIncident(incident.id, {
              escalationLevel: allContactIds.length,
              lastEscalationStep: `contact_${allContactIds.length}`,
              notifiedContactIds: JSON.stringify(allContactIds),
              lastContactNotifiedAt: now,
              contact1NotifiedAt: now,
              contact2NotifiedAt: allContactIds.length > 1 ? now : undefined,
              allContactsNotifiedAt: now,
              nextActionAt: addMinutes(now, 30),
            });

            timerEscalations++;
            console.log(`[CRON] Safety timer escalated for ${user.name}`);
          } catch (err) {
            console.error("[CRON] Safety timer escalation failed:", err);
          }
        }
      } catch (err) {
        console.error("[CRON] Safety timer check failed:", err);
      }

      // Safe Walk: mark newly overdue walks and notify user
      try {
        const nowDate = new Date();
        const newlyOverdue = await db.select().from(safeWalks)
          .where(and(eq(safeWalks.status, "active"), lt(safeWalks.expectedArrivalAt, nowDate)));
        for (const w of newlyOverdue) {
          await storage.updateSafeWalk(w.id, { status: "overdue" });
          const u = await storage.getUser(w.userId);
          if (!u) continue;
          console.log(`[CRON] Safe Walk now overdue for ${u.name}  -  10 min grace period started`);

          const destInfo = w.destinationName ? ` to ${w.destinationName}` : "";

          try {
            const subs = await storage.getPushSubscriptions(w.userId);
            for (const sub of subs) {
              try {
                await webpush.sendNotification(
                  { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                  JSON.stringify({
                    title: "Are you OK?",
                    body: `You haven't arrived${destInfo} yet. Tap "I've Arrived" or extend your time.`,
                    tag: "safe-walk-overdue",
                    data: { url: "/safe-walk" },
                  })
                );
              } catch (err: any) {
                console.error(`[SAFE-WALK] Push notification failed for ${u.name}:`, err?.message || err);
              }
            }
            console.log(`[CRON] Sent push notification to ${u.name}  -  safe walk overdue`);
          } catch (err: any) {
            console.error(`[SAFE-WALK] Push notification batch failed for ${u.name}:`, err?.message || err);
          }

          if (u.phone && isTwilioConfigured()) {
            try {
              await sendSms(u.phone,
                `StillHere: You haven't arrived${destInfo} yet. Are you OK? Open the app to confirm you're safe, or reply YES to this message.`
              );
              console.log(`[CRON] Sent SMS to ${u.name}  -  safe walk overdue`);
            } catch (err: any) {
              console.error(`[SAFE-WALK] Overdue SMS to ${u.name} failed:`, err?.message || err);
            }
          }
        }
      } catch (err) {
        console.error("[CRON] Safe Walk overdue marking failed:", err);
      }

      // Safe Walk escalation (10 min grace period passed)
      let walkEscalations = 0;
      try {
        const overdueWalks = await storage.getOverdueSafeWalks();
        for (const walk of overdueWalks) {
          try {
            await storage.updateSafeWalk(walk.id, { status: "escalated", resolvedAt: new Date() });
            const user = await storage.getUser(walk.userId);
            if (!user) continue;

            const incident = await storage.createIncident(walk.userId, "sos");
            await storage.updateSafetyState(walk.userId, "concern", "Safe walk overdue  -  not responding");
            notifyConcern(walk.userId, user.name, "sos").catch((err) => {
              console.error(`[SAFE-WALK] notifyConcern failed for ${user.name}:`, err?.message || err);
            });
            const tokens = await storage.regenerateTokensForUser(walk.userId);
            const contacts = await storage.getContacts(walk.userId);
            const sortedContacts = [...contacts].sort((a, b) => a.priority - b.priority);
            const destInfo = walk.destinationName ? ` to ${walk.destinationName}` : "";
            const noteInfo = walk.note ? `\nNote: ${walk.note}` : "";
            const allContactIds: string[] = [];

            for (const { contact, token } of tokens) {
              const link = `${baseUrl}/emergency/${token}`;
              let locationInfo = "";
              if (walk.lastLat && walk.lastLng) {
                locationInfo = `\nLast known location: https://www.google.com/maps?q=${walk.lastLat},${walk.lastLng}`;
                if (walk.lastActivity) locationInfo += `\nActivity: ${walk.lastActivity}`;
              }

              if (contact.phone) {
                try {
                  await sendSms(contact.phone,
                    `StillHere ALERT: ${user.name} has not arrived${destInfo} and is not responding.${noteInfo}${locationInfo}\n\nCheck their status: ${link}`
                  );
                } catch (err: any) {
                  console.error(`[SAFE-WALK] Escalation SMS to ${contact.name} (***${contact.phone.slice(-4)}) failed:`, err?.message || err);
                }
              } else {
                console.log(`[SAFE-WALK] Skipping SMS for ${contact.name}: no phone number`);
              }
              if (contact.email) {
                try {
                  const { sendEmail } = await import("./email");
                  await sendEmail(contact.email,
                    `StillHere Alert: ${user.name} Did Not Arrive${destInfo}`,
                    `${user.name} has not arrived${destInfo} and is not responding.${noteInfo}${locationInfo}\n\nCheck their status: ${link}`
                  );
                } catch (err: any) {
                  console.error(`[SAFE-WALK] Escalation email to ${contact.name} failed:`, err?.message || err);
                }
              }
              allContactIds.push(contact.id);
            }

            await storage.updateIncident(incident.id, {
              escalationLevel: allContactIds.length,
              lastEscalationStep: `contact_${allContactIds.length}`,
              notifiedContactIds: JSON.stringify(allContactIds),
              lastContactNotifiedAt: now,
              contact1NotifiedAt: now,
              contact2NotifiedAt: allContactIds.length > 1 ? now : undefined,
              allContactsNotifiedAt: now,
              nextActionAt: addMinutes(now, 30),
            });

            walkEscalations++;
            console.log(`[CRON] Safe Walk escalated for ${user.name}`);
          } catch (err) {
            console.error("[CRON] Safe Walk escalation failed:", err);
          }
        }
      } catch (err) {
        console.error("[CRON] Safe Walk check failed:", err);
      }

      // ---- Family Place Schedule evaluator ----
      // For every active schedule whose window has now passed (+ grace) on a
      // scheduled day, check whether the assigned member is currently inside
      // the place's radius. If not (and we haven't already alerted today),
      // post a system message into the family chat.
      let placeScheduleAlerts = 0;
      try {
        const schedules = await storage.getAllActiveFamilyPlaceSchedules();
        if (schedules.length > 0) {
          const nowLocal = new Date();
          const today = nowLocal.getDay(); // 0..6
          const nowMinutes = nowLocal.getHours() * 60 + nowLocal.getMinutes();
          // Use the LOCAL calendar date (not UTC) for the dedupe key, so we
          // don't accidentally suppress or duplicate alerts around midnight.
          const todayStr = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth() + 1).padStart(2, "0")}-${String(nowLocal.getDate()).padStart(2, "0")}`;

          // Cache per-family lookups so we don't re-fetch the same family N times.
          const placesCache = new Map<string, Awaited<ReturnType<typeof storage.getFamilyPlaces>>>();
          const overviewCache = new Map<string, Awaited<ReturnType<typeof storage.getFamilyForUser>>>();

          for (const s of schedules) {
            try {
              if (s.lastAlertedDate === todayStr) continue;
              const days = s.daysOfWeek.split(",").map(d => parseInt(d, 10));
              if (!days.includes(today)) continue;
              // Only fire once the window has fully ended + grace.
              // Clamp to 23:59 so a late-evening window with a long grace
              // (e.g. 23:30 + 60min = 24:30) still fires before midnight rolls
              // the day over, instead of being skipped forever.
              const dueAt = Math.min(1439, s.expectedEndMinutes + (s.graceMinutes || 0));
              if (nowMinutes < dueAt) continue;

              let places = placesCache.get(s.familyId);
              if (!places) {
                places = await storage.getFamilyPlaces(s.familyId);
                placesCache.set(s.familyId, places);
              }
              const place = places.find(p => p.id === s.placeId);
              if (!place) continue;

              // We need member info + their last-known position. Easiest path:
              // pull overview via any active member (the schedule was created by
              // an admin so the family is real). Cache it.
              let overview = overviewCache.get(s.familyId);
              if (!overview) {
                // findFirst userId in the family for the lookup
                const recipients = await storage.getActiveFamilyUserIds(s.familyId);
                if (recipients.length === 0) continue;
                overview = await storage.getFamilyForUser(recipients[0]);
                overviewCache.set(s.familyId, overview);
              }
              if (!overview?.family) continue;

              const member = overview.members.find(m => m.id === s.memberId);
              if (!member) continue;
              if (member.lastLat == null || member.lastLng == null) {
                // Treat unknown location as a miss - it's literally what the
                // parent wanted to know about ("we have no idea where she is")
              } else {
                const dist = haversineDistance(member.lastLat, member.lastLng, place.lat, place.lng);
                if (dist <= place.radiusMeters) continue; // She's there - silent
              }

              const body = member.lastLat == null
                ? `${member.name} hasn't checked in yet for ${place.name} today. Last seen position is unknown.`
                : `${member.name} doesn't appear to be at ${place.name} (expected by now).`;

              if (member.userId) {
                broadcastToFamily(member.userId, body, "system",
                  { kind: "place_missed", place: place.name, scheduleId: s.id }
                ).catch(() => {});
              } else {
                // Member without a linked user account - notify directly via the
                // admin/sender channel by calling broadcast on the schedule creator.
                if (s.createdByUserId) {
                  broadcastToFamily(s.createdByUserId, body, "system",
                    { kind: "place_missed", place: place.name, scheduleId: s.id }
                  ).catch(() => {});
                }
              }
              await storage.markScheduleAlerted(s.id, todayStr);
              placeScheduleAlerts++;
            } catch (e) {
              console.error("[CRON] schedule eval failed for", s.id, e);
            }
          }
        }
      } catch (err) {
        console.error("[CRON] Family place schedule check failed:", err);
      }

      cronRunning = false;
      res.json({ success: true, reminders: remindersSent, alerts: alertsSent, escalations, reportsSent, softDeletesCleaned, locationWakeups, timerEscalations, walkEscalations, placeScheduleAlerts });
    } catch (error) {
      cronRunning = false;
      console.error("Error in cron tick:", error);
      res.status(500).json({ error: "Cron tick failed" });
    }
  });

  app.get("/api/safety-state/tick", async (req, res) => {
    try {
      const cronSecret = process.env.SESSION_SECRET;
      if (!cronSecret) return res.status(500).json({ error: "Server misconfigured" });
      const providedSecret = req.headers["x-cron-secret"];
      if (providedSecret !== cronSecret) return res.status(403).json({ error: "Forbidden" });

      const QUIET_THRESHOLD_SECONDS = 180;
      const staleUsers = await storage.getStaleActiveUsers(QUIET_THRESHOLD_SECONDS);
      let transitioned = 0;
      for (const user of staleUsers) {
        await storage.updateSafetyState(user.id, "quiet", "No heartbeat received for 3 minutes");
        transitioned++;
      }
      res.json({ ok: true, transitioned });
    } catch (error) {
      console.error("Error in safety-state tick:", error);
      res.status(500).json({ error: "Safety state tick failed" });
    }
  });

  // ============================================================
  // Family Mode (safety group  -  NOT parental control / surveillance)
  // ============================================================
  app.get("/api/family", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getFamilyForUser(userId);
      res.json(overview);
    } catch (e) {
      console.error("[family] get failed", e);
      res.status(500).json({ error: "Failed to load family" });
    }
  });

  app.post("/api/family", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const name = (req.body?.name || "").toString().trim();
      if (!name) return res.status(400).json({ error: "Family name is required" });
      // Prevent duplicate family per admin
      const existing = await storage.getFamilyForUser(userId);
      if (existing.family) return res.status(409).json({ error: "You already belong to a family" });
      const family = await storage.createFamily(userId, name);
      res.json({ family });
    } catch (e) {
      console.error("[family] create failed", e);
      res.status(500).json({ error: "Failed to create family" });
    }
  });

  app.post("/api/family/invite", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getFamilyForUser(userId);
      if (!overview.family) return res.status(404).json({ error: "Create a family first" });
      if (!overview.isAdmin) return res.status(403).json({ error: "Only the family admin can invite" });

      const name = (req.body?.name || "").toString().trim();
      const phoneRaw = (req.body?.phone || "").toString().trim();
      const role = (req.body?.role || "adult") as FamilyRole;
      const parentalConsentRequired = !!req.body?.parentalConsentRequired;
      if (!name || !phoneRaw) return res.status(400).json({ error: "Name and phone are required" });
      if (!["admin", "adult", "teen", "child"].includes(role)) return res.status(400).json({ error: "Invalid role" });

      const phone = normalizePhone(phoneRaw);
      const member = await storage.inviteFamilyMember({
        familyId: overview.family.id,
        invitedBy: userId,
        name,
        phone,
        role,
        // teen/child auto-require parental consent regardless of caller flag
        parentalConsentRequired: parentalConsentRequired || role === "child" || role === "teen",
      });

      // Send the SMS invite (best-effort  -  does not block the API response).
      // Dedupe by phone within a 5-minute window so repeat clicks don't spam.
      const maskedPhone = `***${phone.slice(-4)}`;
      let deduped = false;
      try {
        const last = familyInviteSmsCache.get(phone) || 0;
        if (Date.now() - last < FAMILY_INVITE_SMS_WINDOW_MS) {
          deduped = true;
          console.log(`[INVITE] SMS skipped (deduped) ${maskedPhone}`);
        } else {
          const inviter = await storage.getUser(userId);
          const inviterName = inviter?.name || "Someone you trust";
          const baseUrl = getBaseUrl();
          const existingUser = await storage.getUserByPhone(phone);
          const body = existingUser
            ? `${inviterName} added you to their StillHere Family.\nOpen the app to view and accept.`
            : `${inviterName} added you to their StillHere Family for safety.\nJoin here: ${baseUrl}\nYou'll be able to share safety updates and stay connected.`;
          if (isTwilioConfigured()) {
            familyInviteSmsCache.set(phone, Date.now());
            sendSms(phone, body)
              .then((r) => {
                if (r.success) console.log(`[INVITE] SMS sent to ${maskedPhone}`);
                else console.warn(`[INVITE] SMS send failed ${maskedPhone}: ${r.error}`);
              })
              .catch((err) =>
                console.warn(`[INVITE] SMS send threw ${maskedPhone}:`, err?.message || "unknown"),
              );
          } else {
            console.warn(`[INVITE] SMS skipped (Twilio not configured) ${maskedPhone}`);
          }
        }
      } catch (smsErr: any) {
        console.warn("[INVITE] SMS prep failed:", smsErr?.message || "unknown");
      }

      res.json({ member, deduped });
    } catch (e) {
      console.error("[family] invite failed", e);
      res.status(500).json({ error: "Failed to invite member" });
    }
  });

  // 5-minute SMS dedupe cache for family invites  -  prevents spam from
  // repeat-click and re-invite flows. Keyed by normalized phone.
  const familyInviteSmsCache = new Map<string, number>();
  const FAMILY_INVITE_SMS_WINDOW_MS = 5 * 60 * 1000;

  // "Watch over me while I'm here"  -  starts a real live-location session
  // (continuous GPS share for a chosen duration) and tells every family member
  // the user is asking to be watched. The client then pumps GPS updates via
  // the existing /api/live-location/update endpoint for the duration.
  // Per-user cooldown prevents flooding family inboxes / SMS bills.
  const familyShareCooldown = new Map<string, number>();
  const FAMILY_SHARE_COOLDOWN_MS = 15_000;

  app.post("/api/family/watch-me/stop", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      await storage.stopLiveLocationShare(userId);
      const overview = await storage.getFamilyForUser(userId);
      const me = await storage.getUser(userId);
      const myName = me?.name || "A family member";
      if (overview.family) {
        const recipients = overview.members.filter(
          (m) => m.userId && m.userId !== userId && m.status === "active",
        );
        for (const r of recipients) {
          try {
            const msg = await storage.saveMessage(
              userId,
              r.userId!,
              `${myName} stopped sharing live location with the family.`,
              { messageType: "system_info", meta: { kind: "family_watch_stop" } },
            );
            emitToUser(r.userId!, "message:new", { message: msg, fromUserId: userId });
          } catch {}
        }
      }
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[family] watch-me stop failed:", e?.message || "unknown");
      res.status(500).json({ error: "Failed to stop" });
    }
  });

  // Backwards-compat alias kept for the previous button wiring.
  app.post("/api/family/share-location", async (req, res, next) => {
    (req as any).url = "/api/family/watch-me/start";
    next();
  });

  app.post("/api/family/watch-me/start", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      const lat = Number(req.body?.lat);
      const lng = Number(req.body?.lng);
      const accuracyRaw = req.body?.accuracy;
      const accuracy = accuracyRaw != null ? Number(accuracyRaw) : undefined;
      const durationRaw = req.body?.durationMinutes;
      const durationMinutes =
        durationRaw === null || durationRaw === undefined
          ? 30
          : Number(durationRaw);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        return res.status(400).json({ error: "lat must be between -90 and 90" });
      }
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
        return res.status(400).json({ error: "lng must be between -180 and 180" });
      }
      if (accuracy !== undefined && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100_000)) {
        return res.status(400).json({ error: "accuracy out of range" });
      }
      if (!Number.isFinite(durationMinutes) || durationMinutes < 5 || durationMinutes > 480) {
        return res.status(400).json({ error: "durationMinutes must be between 5 and 480" });
      }

      const lastAt = familyShareCooldown.get(userId) || 0;
      const now = Date.now();
      if (now - lastAt < FAMILY_SHARE_COOLDOWN_MS) {
        const retryAfter = Math.ceil((FAMILY_SHARE_COOLDOWN_MS - (now - lastAt)) / 1000);
        return res.status(429).json({ error: "Please wait a moment before starting again", retryAfter });
      }
      familyShareCooldown.set(userId, now);

      const overview = await storage.getFamilyForUser(userId);
      if (!overview.family) return res.status(404).json({ error: "Create a family first" });

      // 1) Update heartbeat so map pin refreshes immediately.
      await storage.recordHeartbeat(userId, lat, lng, accuracy);

      // 2) Start a real live-location session for the chosen duration. The
      //    client will pump GPS updates via /api/live-location/update.
      const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);
      const share = await storage.startLiveLocationShare(userId, expiresAt);

      // 3) Record a check-in too (so it appears in safety history).
      try {
        await storage.createCheckin(userId, "button", { lat, lng });
      } catch (err: any) {
        console.warn("[family] watch-me createCheckin failed:", err?.message || "unknown");
      }

      // 4) Notify every other linked active member: persist a system_info
      //    message and emit a socket event for instant in-app delivery.
      const me = await storage.getUser(userId);
      const myName = me?.name || "A family member";
      const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
      const recipients = overview.members.filter(
        (m) => m.userId && m.userId !== userId && m.status === "active",
      );
      const durationLabel =
        durationMinutes >= 60
          ? `${Math.round(durationMinutes / 60)} hr`
          : `${durationMinutes} min`;
      for (const r of recipients) {
        try {
          const msg = await storage.saveMessage(
            userId,
            r.userId!,
            `${myName} asked the family to watch over them for ${durationLabel}.`,
            {
              messageType: "system_info",
              meta: {
                kind: "family_watch_start",
                lat,
                lng,
                accuracy,
                mapsUrl,
                durationMinutes,
                expiresAt: expiresAt.toISOString(),
                sharedAt: new Date().toISOString(),
              },
            },
          );
          emitToUser(r.userId!, "message:new", { message: msg, fromUserId: userId });
        } catch (err: any) {
          console.warn(
            `[family] watch-me notify failed for user:${r.userId?.slice(0, 8)}:`,
            err?.message || "unknown",
          );
        }
      }

      res.json({
        ok: true,
        notified: recipients.length,
        lat,
        lng,
        durationMinutes,
        expiresAt: expiresAt.toISOString(),
        shareId: share.id,
      });
    } catch (e: any) {
      console.error("[family] watch-me start failed:", e?.message || "unknown");
      res.status(500).json({ error: "Failed to start watch session" });
    }
  });

  app.patch("/api/family/member/:memberId", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const memberId = req.params.memberId;
      const member = await storage.getFamilyMember(memberId);
      if (!member) return res.status(404).json({ error: "Member not found" });

      const overview = await storage.getFamilyForUser(userId);
      if (!overview.family || overview.family.id !== member.familyId) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const isSelf = member.userId === userId;
      const isAdmin = overview.isAdmin;
      const updates: any = {};

      // Sharing mode: members can change their own, admin can change for under-16
      if (req.body?.sharingMode) {
        const m = req.body.sharingMode;
        if (!["precise", "area", "presence", "paused"].includes(m)) {
          return res.status(400).json({ error: "Invalid sharing mode" });
        }
        const isMinor = member.role === "teen" || member.role === "child";
        if (isSelf || (isAdmin && isMinor)) {
          updates.sharingMode = m;
        } else {
          return res.status(403).json({ error: "Only the member can change their sharing mode" });
        }
      }

      // Admin-only fields
      if (req.body?.role !== undefined) {
        if (!isAdmin) return res.status(403).json({ error: "Admin only" });
        if (!["admin", "adult", "teen", "child"].includes(req.body.role)) {
          return res.status(400).json({ error: "Invalid role" });
        }
        updates.role = req.body.role;
      }
      if (req.body?.status !== undefined) {
        if (!isAdmin) return res.status(403).json({ error: "Admin only" });
        if (!["active", "invited", "paused", "removed"].includes(req.body.status)) {
          return res.status(400).json({ error: "Invalid status" });
        }
        updates.status = req.body.status;
      }
      if (req.body?.parentalConsentGranted !== undefined) {
        if (!isAdmin) return res.status(403).json({ error: "Admin only" });
        updates.parentalConsentGranted = !!req.body.parentalConsentGranted;
      }
      if (req.body?.parentalConsentRequired !== undefined) {
        if (!isAdmin) return res.status(403).json({ error: "Admin only" });
        updates.parentalConsentRequired = !!req.body.parentalConsentRequired;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No valid fields to update" });
      }

      const updated = await storage.updateFamilyMember(memberId, updates);
      res.json({ member: updated });
    } catch (e) {
      console.error("[family] update failed", e);
      res.status(500).json({ error: "Failed to update member" });
    }
  });

  // ---- Family Chat + Pulse + Close ----

  app.get("/api/family/messages", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getFamilyForUser(userId);
      if (!overview.family) return res.json({ messages: [] });
      const messages = await storage.getFamilyMessages(overview.family.id, 200);
      // Hydrate sender names without N+1 surprises - small N here.
      const senderIds = Array.from(new Set(messages.map(m => m.senderId).filter((s): s is string => !!s)));
      const nameById = new Map<string, string>();
      for (const id of senderIds) {
        const u = await storage.getUser(id);
        if (u) nameById.set(id, u.name || "Family member");
      }
      res.json({
        messages: messages.map(m => ({
          ...m,
          senderName: m.senderId ? (nameById.get(m.senderId) || "Family member") : null,
        })),
      });
    } catch (e) {
      console.error("[family] messages get failed", e);
      res.status(500).json({ error: "Failed to load messages" });
    }
  });

  app.post("/api/family/messages", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const body = (req.body?.body || "").toString().trim();
      if (!body) return res.status(400).json({ error: "Message cannot be empty" });
      if (body.length > 2000) return res.status(400).json({ error: "Message too long" });
      const overview = await storage.getFamilyForUser(userId);
      if (!overview.family) return res.status(404).json({ error: "Create a family first" });

      const msg = await storage.saveFamilyMessage({
        familyId: overview.family.id,
        senderId: userId,
        body,
        kind: "user",
      });
      const me = await storage.getUser(userId);
      const payload = { ...msg, senderName: me?.name || "Family member" };
      const recipients = await storage.getActiveFamilyUserIds(overview.family.id);
      for (const uid of recipients) {
        emitToUser(uid, "family:message:new", payload);
      }
      res.json({ message: payload });
    } catch (e) {
      console.error("[family] message send failed", e);
      res.status(500).json({ error: "Failed to send" });
    }
  });

  // Family Pulse - one-tap "I'm OK" broadcast. Optional location attached.
  app.post("/api/family/pulse", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getFamilyForUser(userId);
      if (!overview.family) return res.status(404).json({ error: "Create a family first" });
      const me = await storage.getUser(userId);
      const myName = me?.name || "Family member";

      const lat = req.body?.lat != null ? Number(req.body.lat) : null;
      const lng = req.body?.lng != null ? Number(req.body.lng) : null;
      if (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
        await storage.recordHeartbeat(userId, lat, lng).catch(() => {});
      }

      const msg = await storage.saveFamilyMessage({
        familyId: overview.family.id,
        senderId: userId,
        body: `${myName} is OK.`,
        kind: "pulse",
        meta: lat != null && lng != null ? { lat, lng } : undefined,
      });
      const payload = { ...msg, senderName: myName };
      const recipients = await storage.getActiveFamilyUserIds(overview.family.id);
      for (const uid of recipients) emitToUser(uid, "family:message:new", payload);
      res.json({ message: payload });
    } catch (e) {
      console.error("[family] pulse failed", e);
      res.status(500).json({ error: "Failed to send pulse" });
    }
  });

  // Family Panic - urgent broadcast to family chat. Does NOT replace the
  // user's full SOS / contact-escalation flow (the home SOS still does that).
  app.post("/api/family/panic", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getFamilyForUser(userId);
      if (!overview.family) return res.status(404).json({ error: "Create a family first" });
      const me = await storage.getUser(userId);
      const myName = me?.name || "Family member";
      const lat = req.body?.lat != null ? Number(req.body.lat) : null;
      const lng = req.body?.lng != null ? Number(req.body.lng) : null;
      const note = (req.body?.note || "").toString().trim().slice(0, 280);
      if (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
        await storage.recordHeartbeat(userId, lat, lng).catch(() => {});
      }
      const body = note
        ? `${myName} needs help: ${note}`
        : `${myName} needs help right now.`;
      const msg = await storage.saveFamilyMessage({
        familyId: overview.family.id,
        senderId: userId,
        body,
        kind: "panic",
        meta: lat != null && lng != null ? { lat, lng } : undefined,
      });
      const payload = { ...msg, senderName: myName };
      const recipients = await storage.getActiveFamilyUserIds(overview.family.id);
      for (const uid of recipients) {
        emitToUser(uid, "family:message:new", payload);
        // Best-effort push so offline family members are paged.
        try {
          await sendPushNotification(uid, {
            title: `${myName} needs help`,
            body: note || "Tap to open the family map.",
            url: "/family",
            tag: "family-panic",
          });
        } catch {}
      }
      res.json({ message: payload });
    } catch (e) {
      console.error("[family] panic failed", e);
      res.status(500).json({ error: "Failed to send alert" });
    }
  });

  // Admin closes (deletes) the entire family group. Members are detached;
  // group chat history is removed. Self-leave goes through DELETE /family/member/:id.
  app.delete("/api/family", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getFamilyForUser(userId);
      if (!overview.family) return res.status(404).json({ error: "No family to close" });
      if (!overview.isAdmin) return res.status(403).json({ error: "Only admin can close the family" });
      const recipients = await storage.getActiveFamilyUserIds(overview.family.id);
      await storage.deleteFamily(overview.family.id);
      for (const uid of recipients) emitToUser(uid, "family:closed", { familyId: overview.family.id });
      res.json({ ok: true });
    } catch (e) {
      console.error("[family] close failed", e);
      res.status(500).json({ error: "Failed to close family" });
    }
  });

  // ---- Family Saved Places (Home / School / Work) ----
  app.get("/api/family/places", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getFamilyForUser(userId);
      if (!overview.family) return res.json({ places: [] });
      const places = await storage.getFamilyPlaces(overview.family.id);
      res.json({ places });
    } catch (e) {
      console.error("[family] places get failed", e);
      res.status(500).json({ error: "Failed to load places" });
    }
  });

  app.post("/api/family/places", systemMessageLimiter, async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getFamilyForUser(userId);
      if (!overview.family) return res.status(404).json({ error: "Create a family first" });

      const name = (req.body?.name || "").toString().trim().slice(0, 60);
      const icon = ["home", "school", "work", "gym", "park", "pin"].includes(req.body?.icon)
        ? req.body.icon : "pin";
      const lat = Number(req.body?.lat);
      const lng = Number(req.body?.lng);
      const radiusMeters = Math.max(50, Math.min(2000, Number(req.body?.radiusMeters) || 150));
      if (!name) return res.status(400).json({ error: "Name is required" });
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ error: "lat/lng required" });
      }
      const place = await storage.createFamilyPlace({
        familyId: overview.family.id, name, icon, lat, lng, radiusMeters,
        createdByUserId: userId,
      });
      res.json({ place });
    } catch (e) {
      console.error("[family] place create failed", e);
      res.status(500).json({ error: "Failed to create place" });
    }
  });

  app.delete("/api/family/places/:placeId", systemMessageLimiter, async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getFamilyForUser(userId);
      if (!overview.family) return res.status(404).json({ error: "No family" });
      // Only admin can delete shared places (kept simple, mirrors close-family rule)
      if (!overview.isAdmin) return res.status(403).json({ error: "Only admin can delete places" });
      await storage.deleteFamilyPlace(req.params.placeId, overview.family.id);
      // Drop transient transition state so the in-memory map can't grow unbounded
      purgePlaceFromGeofenceState(req.params.placeId);
      res.json({ ok: true });
    } catch (e) {
      console.error("[family] place delete failed", e);
      res.status(500).json({ error: "Failed to delete place" });
    }
  });

  // ---- Family Place Schedules (per-member expectations like "Sarah at School Mon-Fri 8:30-15:30") ----
  app.get("/api/family/place-schedules", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getFamilyForUser(userId);
      if (!overview.family) return res.json({ schedules: [] });
      const schedules = await storage.getFamilyPlaceSchedules(overview.family.id);
      res.json({ schedules });
    } catch (e) {
      console.error("[family] place-schedules get failed", e);
      res.status(500).json({ error: "Failed to load schedules" });
    }
  });

  app.post("/api/family/places/:placeId/schedules", systemMessageLimiter, async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getFamilyForUser(userId);
      if (!overview.family) return res.status(404).json({ error: "Create a family first" });
      if (!overview.isAdmin) return res.status(403).json({ error: "Only admin can set place schedules" });

      const placeId = req.params.placeId;
      const places = await storage.getFamilyPlaces(overview.family.id);
      const place = places.find(p => p.id === placeId);
      if (!place) return res.status(404).json({ error: "Place not found" });

      const memberId = (req.body?.memberId || "").toString();
      // Reject synthetic admin rows (id like "admin:<userId>") - they aren't
      // real `family_members` UUIDs and would crash the FK insert.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_RE.test(memberId)) {
        return res.status(400).json({ error: "Pick a real family member" });
      }
      const member = overview.members.find(m => m.id === memberId);
      if (!member) return res.status(400).json({ error: "Member not in this family" });

      // Days like "1,2,3,4,5" - keep only 0..6
      const rawDays = (req.body?.daysOfWeek || "").toString();
      const cleanDays = rawDays.split(",")
        .map((d: string) => parseInt(d.trim(), 10))
        .filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 6);
      if (cleanDays.length === 0) return res.status(400).json({ error: "Pick at least one day" });

      const startMin = Math.max(0, Math.min(1439, parseInt(req.body?.expectedStartMinutes, 10)));
      const endMin = Math.max(0, Math.min(1439, parseInt(req.body?.expectedEndMinutes, 10)));
      if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin <= startMin) {
        return res.status(400).json({ error: "End time must be after start time" });
      }
      const grace = Math.max(0, Math.min(120, parseInt(req.body?.graceMinutes, 10) || 15));

      const schedule = await storage.createFamilyPlaceSchedule({
        familyId: overview.family.id,
        placeId,
        memberId,
        daysOfWeek: cleanDays.join(","),
        expectedStartMinutes: startMin,
        expectedEndMinutes: endMin,
        graceMinutes: grace,
        createdByUserId: userId,
      });
      res.json({ schedule });
    } catch (e) {
      console.error("[family] place-schedule create failed", e);
      res.status(500).json({ error: "Failed to save schedule" });
    }
  });

  app.delete("/api/family/place-schedules/:scheduleId", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const overview = await storage.getFamilyForUser(userId);
      if (!overview.family) return res.status(404).json({ error: "No family" });
      if (!overview.isAdmin) return res.status(403).json({ error: "Only admin can remove schedules" });
      await storage.deleteFamilyPlaceSchedule(req.params.scheduleId, overview.family.id);
      res.json({ ok: true });
    } catch (e) {
      console.error("[family] place-schedule delete failed", e);
      res.status(500).json({ error: "Failed to remove schedule" });
    }
  });

  app.delete("/api/family/member/:memberId", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Not authenticated" });
      const memberId = req.params.memberId;
      const member = await storage.getFamilyMember(memberId);
      if (!member) return res.status(404).json({ error: "Member not found" });

      const overview = await storage.getFamilyForUser(userId);
      if (!overview.family || overview.family.id !== member.familyId) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const isSelf = member.userId === userId;
      // Members may leave; only admin may remove others
      if (!isSelf && !overview.isAdmin) {
        return res.status(403).json({ error: "Only admin can remove other members" });
      }
      await storage.removeFamilyMember(memberId);
      res.json({ ok: true });
    } catch (e) {
      console.error("[family] remove failed", e);
      res.status(500).json({ error: "Failed to remove member" });
    }
  });

  return httpServer;
}

// Best-effort: post a system message into the user's family chat (if they're in one)
// and fan out a push notification + socket event. Always swallows errors so it can
// never break the primary safety flow that called it.
// Optional `prefetched` lets hot paths (geofence/check) avoid N+1 by passing in
// already-loaded familyId / senderName / recipients.
async function broadcastToFamily(
  userId: string,
  body: string,
  kind: "system" | "panic" | "pulse",
  meta?: Record<string, any>,
  push?: { title: string; body: string; url?: string; tag?: string },
  prefetched?: { familyId: string; senderName: string; recipients: string[] },
): Promise<void> {
  try {
    let familyId: string;
    let senderName: string;
    let recipients: string[];
    if (prefetched) {
      ({ familyId, senderName, recipients } = prefetched);
    } else {
      const overview = await storage.getFamilyForUser(userId);
      if (!overview.family) return;
      familyId = overview.family.id;
      const me = await storage.getUser(userId);
      senderName = me?.name || "Family member";
      recipients = await storage.getActiveFamilyUserIds(familyId);
    }
    const msg = await storage.saveFamilyMessage({
      familyId, senderId: userId, body, kind, meta,
    });
    const payload = { ...msg, senderName };
    for (const uid of recipients) {
      try { emitToUser(uid, "family:message:new", payload); } catch {}
    }
    if (push && recipients.length > 0) {
      // Push fan-out runs concurrently (don't await each in series).
      await Promise.allSettled(recipients.map((uid) =>
        sendPushNotification(uid, {
          title: push.title,
          body: push.body,
          url: push.url || "/family",
          tag: push.tag || "family-broadcast",
        }),
      ));
    }
  } catch (err) {
    console.error("[family] broadcastToFamily failed", err);
  }
}

// Walks the in-memory geofence transition state and removes any entry for the
// given place ID across every user. Called when a place is deleted to prevent
// the state map from growing unbounded.
function purgePlaceFromGeofenceState(placeId: string): void {
  const key = `place:${placeId}`;
  for (const userMap of geofenceStateRef.values()) {
    userMap.delete(key);
  }
}

// Set during registerRoutes() so the place-delete handler and helper can purge
// stale entries without leaking across server boots.
let geofenceStateRef: Map<string, Map<string, boolean>> = new Map();

function formatReportTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  const timeStr = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  if (diffDays === 0) return `Today, ${timeStr}`;
  if (diffDays === 1) return `Yesterday, ${timeStr}`;
  const dayName = date.toLocaleDateString("en-US", { weekday: "long" });
  return `${dayName}, ${timeStr}`;
}
