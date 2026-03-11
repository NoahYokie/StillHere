import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { addMinutes, addHours } from "date-fns";
import { db } from "./db";
import { users } from "@shared/schema";
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
} from "./sms";
import {
  isPushConfigured,
  getVapidPublicKey,
  sendReminderPush,
  sendPushNotification,
} from "./push";

// Helper to get userId from session
const getUserId = (req: Request): string | null => {
  return (req as any).userId || null;
};

const getBaseUrl = (): string => {
  return process.env.BASE_URL || "https://stillhere.health";
};

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
  
  // Send OTP code
  app.post("/api/auth/send-code", async (req, res) => {
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

  app.post("/api/auth/verify-code", async (req, res) => {
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
      
      console.log("\n========================================");
      console.log("StillHere - User Setup Complete");
      console.log("========================================");
      console.log(`User: ${updatedUser.name}`);
      console.log(`Phone: ${updatedUser.phone || "Not set"}`);
      console.log("========================================\n");
      
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
      const checkin = await storage.createCheckin(userId, method);
      
      // Reset reminder state when user checks in
      await storage.resetReminderState(userId);
      
      res.json({ success: true, checkin });
    } catch (error) {
      console.error("Error checking in:", error);
      res.status(500).json({ error: "Failed to check in" });
    }
  });

  // SOS - immediate incident
  app.post("/api/sos", async (req, res) => {
    try {
      const userId = getUserId(req);
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
          const normalizedPhone = normalizePhone(firstContact.phone);
          console.log(`\n[SOS] Alerting Contact #${firstContact.priority}: ${firstContact.name}...`);
          await sendSosAlert(normalizedPhone, user?.name || "User", link);
          console.log("[SOS] Alert sent\n");
        }
      }
      
      incident = await storage.updateIncident(incident.id, {
        escalationLevel: 1,
        notifiedContactIds: JSON.stringify(firstContact ? [firstContact.id] : []),
        lastContactNotifiedAt: now,
        contact1NotifiedAt: now,
        nextActionAt: addMinutes(now, 20),
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
      const { checkinIntervalHours, graceMinutes, locationMode, reminderMode, preferredCheckinTime, timezone, autoCheckin, fallDetection } = req.body;
      
      if (checkinIntervalHours !== undefined && (typeof checkinIntervalHours !== "number" || checkinIntervalHours < 12 || checkinIntervalHours > 48)) {
        return res.status(400).json({ error: "Check-in interval must be between 12 and 48 hours" });
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
        return res.status(400).json({ error: "Auto check-in must be a boolean" });
      }
      if (fallDetection !== undefined && typeof fallDetection !== "boolean") {
        return res.status(400).json({ error: "Fall detection must be a boolean" });
      }
      
      const updates: any = {};
      if (checkinIntervalHours !== undefined) updates.checkinIntervalHours = checkinIntervalHours;
      if (graceMinutes !== undefined) updates.graceMinutes = graceMinutes;
      if (locationMode !== undefined) updates.locationMode = locationMode;
      if (reminderMode !== undefined) updates.reminderMode = reminderMode;
      if (preferredCheckinTime !== undefined) updates.preferredCheckinTime = preferredCheckinTime;
      if (autoCheckin !== undefined) updates.autoCheckin = autoCheckin;
      if (fallDetection !== undefined) updates.fallDetection = fallDetection;
      
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
        const contactsList = req.body.contacts as { name: string; phone: string; priority: number }[];
        
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
          priority: c.priority || (i + 1),
        })));

        const tokens = await storage.getContactTokensForUser(userId);
        if (tokens.length > 0) {
          console.log("\n========================================");
          console.log("Contact Page URLs:");
          for (const t of tokens) {
            console.log(`  ${t.contact.name}: /emergency/${t.token}`);
          }
          console.log("========================================\n");
        }

        return res.json({ success: true, contacts: savedContacts });
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
        console.log("\n========================================");
        console.log("Contact Page URLs:");
        for (const t of tokens) {
          console.log(`  ${t.contact.name}: /emergency/${t.token}`);
        }
        console.log("========================================\n");
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
      const checkin = await storage.createCheckin(result.userId, "auto");
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
      res.json({
        ok: true,
        name: result.user.name,
        lastCheckin: status.lastCheckin?.createdAt || null,
        nextDue: status.nextCheckinDue || null,
        isOverdue: status.isOverdue || false,
        hasActiveIncident: !!incident,
      });
    } catch (error) {
      console.error("Error in simple status:", error);
      res.status(500).json({ error: "Failed" });
    }
  });

  // ============================================
  // PUBLIC ROUTES (no auth required)
  // ============================================

  // Contact page - get data
  app.get("/api/emergency/:token", async (req, res) => {
    try {
      const { token } = req.params;
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
      const { token } = req.params;
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
      
      console.log(`\n[INCIDENT] ${data.contact.name} is now handling the incident for ${data.user.name}\n`);
      
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
      const { token } = req.params;
      const data = await storage.getContactPageData(token);
      
      if (!data) {
        return res.status(404).json({ error: "Invalid or expired link" });
      }
      
      if (!data.incident || data.incident.status === "resolved") {
        return res.status(400).json({ error: "No active incident" });
      }
      
      const now = new Date();
      
      // Update incident - reset escalation state and restart the flow
      const incident = await storage.updateIncident(data.incident.id, {
        status: "open",
        handledByContactId: null,
        // Reset all escalation tracking to restart the flow
        escalationLevel: 1,
        contact1NotifiedAt: now,
        contact2NotifiedAt: null,
        userNotifiedNoResponseAt: null,
        nextActionAt: addMinutes(now, 20), // Start fresh 20-min escalation window
      });
      
      console.log(`\n[INCIDENT] ${data.contact.name} escalated the incident for ${data.user.name}\n`);
      
      // Follow sequential escalation: notify only Contact 1, let cron handle Contact 2 after 20 min
      const contacts = await storage.getContacts(data.user.id);
      const tokens = await storage.getContactTokensForUser(data.user.id);
      const baseUrl = getBaseUrl();
      
      // Notify Contact 1 only (sequential escalation)
      const contact1 = contacts.find(c => c.priority === 1);
      if (contact1) {
        const tokenData = tokens.find(t => t.contact.id === contact1.id);
        if (tokenData) {
          const link = `${baseUrl}/emergency/${tokenData.token}`;
          const normalizedPhone = normalizePhone(contact1.phone);
          console.log(`\n[ESCALATION] Re-notifying Contact 1: ${contact1.name}...`);
          // Use correct SMS template based on incident reason
          if (data.incident!.reason === "sos") {
            await sendSosAlert(normalizedPhone, data.user.name, link);
          } else {
            await sendMissedCheckinAlert(normalizedPhone, data.user.name, link);
          }
          console.log("[ESCALATION] Contact 1 re-notified, escalation will continue via cron\n");
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

  // Cron tick - check for due users (internal only)
  app.get("/api/cron/tick", async (req, res) => {
    try {
      const cronSecret = process.env.SESSION_SECRET || "internal-cron-key";
      const providedSecret = req.headers["x-cron-secret"];
      if (providedSecret !== cronSecret) {
        return res.status(403).json({ error: "Forbidden" });
      }

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
              const normalizedPhone = normalizePhone(firstContact.phone);
              console.log(`\n[MISSED CHECK-IN] ${user.name} - alerting Contact #${firstContact.priority}: ${firstContact.name}...`);
              await sendMissedCheckinAlert(normalizedPhone, user.name, link);
              console.log("[MISSED CHECK-IN] Alert sent\n");
            }
          }
          
          incident = await storage.updateIncident(incident.id, {
            escalationLevel: 1,
            notifiedContactIds: JSON.stringify(firstContact ? [firstContact.id] : []),
            lastContactNotifiedAt: now,
            contact1NotifiedAt: now,
            nextActionAt: addMinutes(now, 20),
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
            console.log(`\n[REMINDER] ${user.name} - sending reminder ${remindersSentSoFar + 1}/${maxReminders}...`);
            
            // Use home page as the check-in link
            const checkInLink = `${baseUrl}/`;
            await sendReminderPush(user.id, user.name);
            if (user.phone) {
              await sendReminderSms(user.phone, checkInLink);
            }
            await storage.incrementRemindersSent(user.id);
            remindersSent++;
            
            console.log("[REMINDER] Sent\n");
          } else {
            console.log(`[REMINDER] ${user.name} - throttled, ${Math.round(REMINDER_THROTTLE_MINUTES - timeSinceLastReminder)} min until next reminder`);
          }
        }
      }
      
      // Handle escalations for incidents that need attention
      let escalations = 0;
      const incidentsNeedingEscalation = await storage.getIncidentsNeedingEscalation();
      const ESCALATION_WINDOW_MS = 20 * 60 * 1000;
      const MAX_SEQUENTIAL = 5;
      
      for (const incident of incidentsNeedingEscalation) {
        const user = await storage.getUser(incident.userId);
        if (!user) continue;
        
        const contacts = await storage.getContacts(incident.userId);
        const tokens = await storage.getContactTokensForUser(incident.userId);
        const sortedContacts = [...contacts].sort((a, b) => a.priority - b.priority);
        
        let notifiedIds: string[] = [];
        try { notifiedIds = JSON.parse(incident.notifiedContactIds || "[]"); } catch { notifiedIds = []; }
        
        // Case 1: Status is "paused" - handling timeout (45 min)
        if (incident.status === "paused") {
          console.log(`\n[ESCALATION] ${user.name} - handling timeout, re-notifying all contacts...`);
          
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
            nextActionAt: addMinutes(now, 20),
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
                const normalizedPhone = normalizePhone(firstContact.phone);
                console.log(`\n[ESCALATION] ${user.name} - initializing, notifying Contact #${firstContact.priority}: ${firstContact.name}...`);
                if (incident.reason === "sos") {
                  await sendSosAlert(normalizedPhone, user.name, link);
                } else {
                  await sendMissedCheckinAlert(normalizedPhone, user.name, link);
                }
              }
            }
            await storage.updateIncident(incident.id, {
              escalationLevel: 1,
              notifiedContactIds: JSON.stringify(firstContact ? [firstContact.id] : []),
              lastContactNotifiedAt: now,
              contact1NotifiedAt: now,
              nextActionAt: addMinutes(now, 20),
            });
            escalations++;
            continue;
          }
          
          const lastNotifiedAt = incident.lastContactNotifiedAt || incident.contact1NotifiedAt;
          if (!lastNotifiedAt) {
            await storage.updateIncident(incident.id, {
              lastContactNotifiedAt: now,
              nextActionAt: addMinutes(now, 20),
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
            // Notify next contact sequentially
            const token = tokens.find(t => t.contact.id === nextSequential.id);
            if (token) {
              const link = `${baseUrl}/emergency/${token.token}`;
              const normalizedPhone = normalizePhone(nextSequential.phone);
              console.log(`\n[ESCALATION] ${user.name} - escalating to Contact #${nextSequential.priority}: ${nextSequential.name}...`);
              await sendEscalationAlert(normalizedPhone, user.name, link, incident.reason as "sos" | "missed_checkin");
              console.log("[ESCALATION] Alert sent\n");
            }
            
            notifiedIds.push(nextSequential.id);
            const newLevel = notifiedIds.length;
            
            const updateData: any = {
              escalationLevel: newLevel,
              notifiedContactIds: JSON.stringify(notifiedIds),
              lastContactNotifiedAt: now,
              nextActionAt: addMinutes(now, 20),
            };
            if (newLevel === 2) updateData.contact2NotifiedAt = now;
            
            await storage.updateIncident(incident.id, updateData);
            escalations++;
            continue;
          }
          
          // All sequential contacts exhausted — blast remaining contacts
          const remainingContacts = sortedContacts.filter(c => !notifiedIds.includes(c.id));
          
          if (remainingContacts.length > 0 && !incident.allContactsNotifiedAt) {
            console.log(`\n[ESCALATION] ${user.name} - top ${MAX_SEQUENTIAL} exhausted, blasting ${remainingContacts.length} remaining contacts...`);
            
            for (const contact of remainingContacts) {
              const token = tokens.find(t => t.contact.id === contact.id);
              if (token) {
                const link = `${baseUrl}/emergency/${token.token}`;
                const normalizedPhone = normalizePhone(contact.phone);
                await sendEscalationAlert(normalizedPhone, user.name, link, incident.reason as "sos" | "missed_checkin");
              }
              notifiedIds.push(contact.id);
            }
            
            await storage.updateIncident(incident.id, {
              escalationLevel: notifiedIds.length,
              notifiedContactIds: JSON.stringify(notifiedIds),
              allContactsNotifiedAt: now,
              lastContactNotifiedAt: now,
              nextActionAt: addMinutes(now, 20),
            });
            
            console.log("[ESCALATION] All contacts notified\n");
            escalations++;
            continue;
          }
          
          // All contacts notified — check if we should show user banner
          if (!incident.userNotifiedNoResponseAt) {
            console.log(`\n[ESCALATION] ${user.name} - no contacts responded, updating in-app status...`);
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
      
      res.json({ success: true, reminders: remindersSent, alerts: alertsSent, escalations });
    } catch (error) {
      console.error("Error in cron tick:", error);
      res.status(500).json({ error: "Cron tick failed" });
    }
  });

  return httpServer;
}
