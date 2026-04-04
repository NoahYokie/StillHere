import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import rateLimit from "express-rate-limit";
import { storage } from "./storage";
import { addMinutes, addHours, addDays } from "date-fns";
import { db } from "./db";
import { users, settings, authSessions } from "@shared/schema";
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
} from "./sms";
import {
  isPushConfigured,
  getVapidPublicKey,
  sendReminderPush,
  sendPushNotification,
} from "./push";
import { emitToUser, isUserOnline } from "./socket";
import { sendEmergencyEmail, sendGeofenceEmail } from "./email";

// Helper to get userId from session
const getUserId = (req: Request): string | null => {
  return (req as any).userId || null;
};

const getBaseUrl = (): string => {
  return process.env.BASE_URL || "https://stillhere.health";
};

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
      title: reason === "sos" ? `${userName} needs help!` : `${userName} missed their checkin`,
      body: reason === "sos"
        ? `${userName} has triggered an SOS alert. Tap to respond.`
        : `${userName} hasn't checked in. Tap to respond.`,
      url: link,
      tag: "emergency-alert",
    });
    try {
      const alertContent = reason === "sos"
        ? `[ALERT] ${userName} has triggered an SOS alert. Please check on them: ${link}`
        : `[ALERT] ${userName} missed their checkin. Please check on them: ${link}`;
      await storage.saveMessage(contact.userId, contact.linkedUserId, alertContent);
      emitToUser(contact.linkedUserId, "message:new", {
        type: "emergency-alert",
        userName,
        reason,
        link,
      });
    } catch {}
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
  
  // ============================================
  // AUTH ROUTES (public)
  // ============================================

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
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
  
  // Verify OTP code — rate limited to prevent brute force
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
        } catch {}
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
      
      if (!name || name.trim() === "") {
        return res.status(400).json({ error: "Name is required" });
      }
      
      // Update user name
      const { eq } = await import("drizzle-orm");
      const [updatedUser] = await db
        .update(users)
        .set({ name: name.trim() })
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
      
      // Create SOS incident
      let incident = await storage.createIncident(userId, "sos");
      
      // Get contacts sorted by priority
      const contacts = await storage.getContacts(userId);
      const settings = await storage.getSettings(userId);
      
      // Create location session if allowed
      if (settings?.locationMode === "emergency_only" || settings?.locationMode === "both") {
        await storage.createLocationSession(userId, "emergency", incident.id);
      }
      
      // Get tokens and base URL for contacts
      const tokens = await storage.getContactTokensForUser(userId);
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
        notifiedContactIds: JSON.stringify(firstContact ? [firstContact.id] : []),
        lastContactNotifiedAt: now,
        contact1NotifiedAt: now,
        nextActionAt: addMinutes(now, sosSettings?.escalationMinutes || 20),
      });
      
      res.json({ success: true, incident });
    } catch (error) {
      console.error("Error sending SOS:", error);
      res.status(500).json({ error: "Failed to send SOS" });
    }
  });

  // Resolve active incident (dismiss alert)
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
      
      // Get user info for notification
      const user = await storage.getUser(userId);
      
      // Resolve the incident
      await storage.updateIncident(openIncident.id, {
        status: "resolved",
        resolvedAt: new Date(),
      });
      
      // End any active location session
      const session = await storage.getActiveLocationSession(userId);
      if (session) {
        await storage.endLocationSession(session.id);
      }
      
      // Notify emergency contacts that user is OK now
      if (user) {
        const contactsWithTokens = await storage.getContactTokensForUser(userId);
        const baseUrl = getBaseUrl();
        
        console.log("[Resolve] Notifying contacts that user is OK...");
        for (const { contact, token } of contactsWithTokens) {
          const normalizedPhone = normalizePhone(contact.phone);
          const link = `${baseUrl}/emergency/${token}`;
          await sendAllClearNotification(normalizedPhone, user.name, link);
        }
        console.log("[Resolve] All clear notifications sent");
      }
      
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
      const { checkinIntervalHours, graceMinutes, locationMode, reminderMode, preferredCheckinTime, timezone, autoCheckin, fallDetection, discreetSos, smsCheckinEnabled, escalationMinutes, allowReports, drivingSafety, speedLimitKmh } = req.body;
      
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

        const savedContacts = await storage.saveContactsList(userId, contactsList.map((c, i) => ({
          name: c.name.trim(),
          phone: normalizePhone(c.phone),
          email: c.email?.trim() || null,
          priority: c.priority || (i + 1),
        })));

        for (const contact of savedContacts) {
          const linkedUser = await storage.getUserByPhone(contact.phone);
          if (linkedUser && linkedUser.id !== userId) {
            await storage.linkContactToUser(contact.id, linkedUser.id);
          } else {
            await storage.linkContactToUser(contact.id, null);
          }
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
  app.post("/api/emergency/:token/handle", async (req, res) => {
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
  app.post("/api/emergency/:token/escalate", async (req, res) => {
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

      const { encrypted, iv } = req.body;
      const msg = await storage.saveMessage(currentUserId, receiverId, content.trim(), encrypted || false, iv);

      const { emitToUser, isUserOnline } = await import("./socket");
      const sender = await storage.getUser(currentUserId);
      emitToUser(receiverId, "message:new", { ...msg, senderName: sender?.name || "Someone" });

      if (!isUserOnline(receiverId)) {
        const pushBody = encrypted ? "New encrypted message" : content.substring(0, 100);
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
            await sendEmergencyEmail(
              contact.email,
              `Crash alert - ${user.name}`,
              crashMsg,
              link
            );
          }

          if (contact.linkedUserId) {
            await sendPushNotification(contact.linkedUserId, {
              title: `Crash detected - ${user.name}`,
              body: "A possible vehicle crash has been detected. Tap to respond.",
              url: `/emergency/${tokenRecord.token}`,
              tag: "crash-alert",
            });
          }
        } catch (err) {
          console.error(`Error notifying contact ${contact.id} about crash:`, err);
        }
      }

      await storage.updateIncident(incident.id, {
        escalationLevel: 1,
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
      const reports = await storage.getErrorReports(Math.min(limit, 100), resolved);
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
      const stats = await storage.getErrorReportStats();
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
      await storage.resolveErrorReport(req.params.id);
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
      res.json(ratings);
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
  app.post("/api/sms/incoming", async (req, res) => {
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
      if (!userSettings?.smsCheckinEnabled) {
        return res.type("text/xml").send('<Response><Message>SMS checkin is not enabled for your account. Enable it in Settings.</Message></Response>');
      }
      
      const affirmatives = ["yes", "ok", "y", "yep", "yeah", "im ok", "i'm ok", "safe", "good", "fine", "here", "alive", "checkin", "check in"];
      const isCheckin = affirmatives.some(a => body.includes(a));
      
      if (isCheckin) {
        await storage.createCheckin(user.id, "sms");
        await storage.resetReminderState(user.id);
        
        const openIncident = await storage.getOpenIncident(user.id);
        if (openIncident) {
          await storage.updateIncident(openIncident.id, {
            status: "resolved",
            resolvedAt: new Date(),
          });
        }
        
        console.log(`[SMS-CHECKIN] Checkin recorded for user ***${normalized.slice(-4)}`);
        return res.type("text/xml").send('<Response><Message>Thanks! Your checkin has been recorded. Stay safe.</Message></Response>');
      }
      
      if (body === "help" || body === "sos") {
        const existingIncident = await storage.getOpenIncident(user.id);
        if (!existingIncident) {
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
          await storage.updateIncident(incident.id, {
            escalationLevel: 1,
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
      
      const newDepartures = results.filter(r => {
        const wasInside = userState.get(r.id);
        const transitioned = wasInside === true && !r.inside;
        userState.set(r.id, r.inside);
        return transitioned;
      });
      
      for (const r of results) {
        if (!userState.has(r.id)) {
          userState.set(r.id, r.inside);
        }
      }
      
      if (newDepartures.length > 0) {
        const user = await storage.getUser(userId);
        const allContacts = await storage.getContacts(userId);
        for (const zone of newDepartures) {
          for (const contact of allContacts) {
            if (contact.email) {
              try {
                await sendGeofenceEmail(contact.email, user?.name || "User", zone.name);
              } catch {}
            }
          }
        }
      }
      
      res.json({ zones: results, newDepartures: newDepartures.map(d => d.name) });
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
        if (lat != null && lng != null) {
          const session = await storage.getActiveLocationSession(user.id);
          if (session) {
            await storage.updateLocationSession(session.id, lat, lng, 50);
          }
          await storage.saveBreadcrumb(user.id, null, lat, lng, 50);
        }
        console.log(`[SATELLITE] Checkin from device ${deviceId} for user ${user.name}`);
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
            notifiedContactIds: JSON.stringify(first ? [first.id] : []),
            lastContactNotifiedAt: new Date(),
            contact1NotifiedAt: new Date(),
            nextActionAt: addMinutes(new Date(), userSettings?.escalationMinutes || 20),
          });
        }
        if (lat != null && lng != null) {
          await storage.saveBreadcrumb(user.id, null, lat, lng, 50);
        }
        console.log(`[SATELLITE] SOS from device ${deviceId} for user ${user.name}`);
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
        // Calculate max reminders based on reminderMode
        const maxReminders = settings.reminderMode === "none" ? 0 
          : settings.reminderMode === "one" ? 1 
          : 2;
        
        const remindersSentSoFar = settings.remindersSent || 0;
        
        // If past grace period, send alert regardless of reminder state
        // This prevents deadlock if cron runs late or reminders weren't sent
        if (isDueForAlert) {
          let incident = await storage.createIncident(user.id, "missed_checkin");
          const contacts = await storage.getContacts(user.id);
          
          if (settings.locationMode === "emergency_only" || settings.locationMode === "both") {
            await storage.createLocationSession(user.id, "emergency", incident.id);
          }
          
          const tokens = await storage.getContactTokensForUser(user.id);
          const sortedContacts = [...contacts].sort((a, b) => a.priority - b.priority);
          const firstContact = sortedContacts[0];
          
          if (firstContact) {
            const token = tokens.find(t => t.contact.id === firstContact.id);
            if (token) {
              const link = `${baseUrl}/emergency/${token.token}`;
              console.log(`[MISSED CHECK-IN] Alerting Contact #${firstContact.priority}`);
              await notifyContact(firstContact, user.name, link, "missed_checkin", sendMissedCheckinAlert);
              console.log("[MISSED CHECK-IN] Alert sent\n");
            }
          }
          
          incident = await storage.updateIncident(incident.id, {
            escalationLevel: 1,
            notifiedContactIds: JSON.stringify(firstContact ? [firstContact.id] : []),
            lastContactNotifiedAt: now,
            contact1NotifiedAt: now,
            nextActionAt: addMinutes(now, settings.escalationMinutes || 20),
          });
          
          alertsSent++;
          await storage.resetReminderState(user.id);
          continue;
        }
        
        // Not past grace period - check if we should send a reminder
        if (remindersSentSoFar < maxReminders) {
          // Throttle: check if enough time has passed since last reminder
          const timeSinceLastReminder = settings.lastReminderAt 
            ? (now.getTime() - new Date(settings.lastReminderAt).getTime()) / (1000 * 60)
            : Infinity;
          
          if (timeSinceLastReminder >= REMINDER_THROTTLE_MINUTES) {
            // Send reminder to the user
            console.log(`[REMINDER] Sending reminder ${remindersSentSoFar + 1}/${maxReminders}`);
            
            // Use home page as the checkin link
            const checkInLink = `${baseUrl}/`;
            await sendReminderPush(user.id, user.name);
            if (user.phone) {
              await sendReminderSms(user.phone, checkInLink, !!settings.smsCheckinEnabled);
            }
            await storage.incrementRemindersSent(user.id);
            remindersSent++;
            
            console.log("[REMINDER] Sent\n");
          } else {
            console.log(`[REMINDER] Throttled, ${Math.round(REMINDER_THROTTLE_MINUTES - timeSinceLastReminder)} min until next reminder`);
          }
        }
      }
      
      // Handle escalations for incidents that need attention
      let escalations = 0;
      const incidentsNeedingEscalation = await storage.getIncidentsNeedingEscalation();
      const MAX_SEQUENTIAL = 5;
      
      for (const incident of incidentsNeedingEscalation) {
        const user = await storage.getUser(incident.userId);
        if (!user) continue;
        
        const userSettings = await storage.getSettings(incident.userId);
        const escalationMinutes = userSettings?.escalationMinutes || 20;
        const ESCALATION_WINDOW_MS = escalationMinutes * 60 * 1000;
        
        const contacts = await storage.getContacts(incident.userId);
        const tokens = await storage.getContactTokensForUser(incident.userId);
        const sortedContacts = [...contacts].sort((a, b) => a.priority - b.priority);
        
        let notifiedIds: string[] = [];
        try { notifiedIds = JSON.parse(incident.notifiedContactIds || "[]"); } catch { notifiedIds = []; }
        
        // Case 1: Status is "paused" - handling timeout (45 min)
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
            notifiedContactIds: JSON.stringify(firstContact ? [firstContact.id] : []),
            lastContactNotifiedAt: now,
            allContactsNotifiedAt: null,
            userNotifiedNoResponseAt: null,
            contact1NotifiedAt: now,
            contact2NotifiedAt: null,
            nextActionAt: addMinutes(now, escalationMinutes),
          });
          
          console.log("[ESCALATION] Handling timeout alerts sent, escalation reset\n");
          escalations++;
          continue;
        }
        
        // Case 2: Status is "open" - sequential escalation through contacts
        if (incident.status === "open") {
          // No contacts notified yet — initialize
          if (notifiedIds.length === 0 && !incident.lastContactNotifiedAt) {
            const firstContact = sortedContacts[0];
            if (firstContact) {
              const token = tokens.find(t => t.contact.id === firstContact.id);
              if (token) {
                const link = `${baseUrl}/emergency/${token.token}`;
                console.log(`[ESCALATION] Initializing, notifying Contact #${firstContact.priority}`);
                const smsFn = incident.reason === "sos" ? sendSosAlert : sendMissedCheckinAlert;
                await notifyContact(firstContact, user.name, link, incident.reason as "sos" | "missed_checkin", smsFn);
              }
            }
            await storage.updateIncident(incident.id, {
              escalationLevel: 1,
              notifiedContactIds: JSON.stringify(firstContact ? [firstContact.id] : []),
              lastContactNotifiedAt: now,
              contact1NotifiedAt: now,
              nextActionAt: addMinutes(now, escalationMinutes),
            });
            escalations++;
            continue;
          }
          
          const lastNotifiedAt = incident.lastContactNotifiedAt || incident.contact1NotifiedAt;
          if (!lastNotifiedAt) {
            await storage.updateIncident(incident.id, {
              lastContactNotifiedAt: now,
              nextActionAt: addMinutes(now, escalationMinutes),
            });
            continue;
          }
          
          const elapsedMs = now.getTime() - lastNotifiedAt.getTime();
          
          // Not enough time passed — reschedule
          if (elapsedMs < ESCALATION_WINDOW_MS) {
            const remainingMs = ESCALATION_WINDOW_MS - elapsedMs;
            await storage.updateIncident(incident.id, {
              nextActionAt: new Date(now.getTime() + remainingMs + 60000),
            });
            continue;
          }
          
          // Find next un-notified contact in sequential order (top 5)
          const sequentialContacts = sortedContacts.slice(0, MAX_SEQUENTIAL);
          const nextSequential = sequentialContacts.find(c => !notifiedIds.includes(c.id));
          
          if (nextSequential) {
            const token = tokens.find(t => t.contact.id === nextSequential.id);
            if (token) {
              const link = `${baseUrl}/emergency/${token.token}`;
              console.log(`[ESCALATION] Escalating to Contact #${nextSequential.priority}`);
              const reason = incident.reason as "sos" | "missed_checkin";
              await notifyContact(nextSequential, user.name, link, reason, (p, n, l) => sendEscalationAlert(p, n, l, reason));
              console.log("[ESCALATION] Alert sent\n");
            }
            
            notifiedIds.push(nextSequential.id);
            const newLevel = notifiedIds.length;
            
            const updateData: any = {
              escalationLevel: newLevel,
              notifiedContactIds: JSON.stringify(notifiedIds),
              lastContactNotifiedAt: now,
              nextActionAt: addMinutes(now, escalationMinutes),
            };
            if (newLevel === 2) updateData.contact2NotifiedAt = now;
            
            await storage.updateIncident(incident.id, updateData);
            escalations++;
            continue;
          }
          
          // All sequential contacts exhausted — blast remaining contacts
          const remainingContacts = sortedContacts.filter(c => !notifiedIds.includes(c.id));
          
          if (remainingContacts.length > 0 && !incident.allContactsNotifiedAt) {
            console.log(`[ESCALATION] Top ${MAX_SEQUENTIAL} exhausted, blasting ${remainingContacts.length} remaining contacts`);
            
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
              notifiedContactIds: JSON.stringify(notifiedIds),
              allContactsNotifiedAt: now,
              lastContactNotifiedAt: now,
              nextActionAt: addMinutes(now, escalationMinutes),
            });
            
            console.log("[ESCALATION] All contacts notified\n");
            escalations++;
            continue;
          }
          
          // All contacts notified — check if we should show user banner
          if (!incident.userNotifiedNoResponseAt) {
            console.log(`[ESCALATION] No contacts responded, updating in-app status`);
            await storage.updateIncident(incident.id, {
              userNotifiedNoResponseAt: now,
              nextActionAt: addMinutes(now, 30),
            });
            escalations++;
            continue;
          }
          
          // Keep checking periodically
          await storage.updateIncident(incident.id, {
            nextActionAt: addMinutes(now, 30),
          });
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

      cronRunning = false;
      res.json({ success: true, reminders: remindersSent, alerts: alertsSent, escalations, reportsSent });
    } catch (error) {
      cronRunning = false;
      console.error("Error in cron tick:", error);
      res.status(500).json({ error: "Cron tick failed" });
    }
  });

  return httpServer;
}
