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
  sendContactRespondedNotification,
  isTwilioConfigured,
} from "./sms";

// Helper to get userId from session
const getUserId = (req: Request): string | null => {
  return (req as any).userId || null;
};

// Helper to get base URL for links (custom domain in production, dev domain otherwise)
const getBaseUrl = (): string => {
  // Always use custom domain for SMS links (both dev and production)
  // This ensures emergency contacts always get the professional URL
  return "https://stillhere.health";
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
  
  // Verify OTP code
  app.post("/api/auth/verify-code", async (req, res) => {
    try {
      const { phone, code } = req.body;
      
      if (!phone || !code) {
        return res.status(400).json({ error: "Phone and code are required" });
      }
      
      const result = await verifyOtp(phone, code);
      
      if (!result.success) {
        return res.status(401).json({ error: "Invalid or expired code" });
      }
      
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
      const checkin = await storage.createCheckin(userId);
      
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
      
      // Sequential alerts: Only notify Contact 1 (priority 1) first
      const contact1 = contacts.find(c => c.priority === 1);
      const now = new Date();
      
      if (contact1) {
        const token = tokens.find(t => t.contact.id === contact1.id);
        if (token) {
          const link = `${baseUrl}/emergency/${token.token}`;
          const normalizedPhone = normalizePhone(contact1.phone);
          console.log(`\n[SOS] Alerting Contact 1: ${contact1.name}...`);
          await sendSosAlert(normalizedPhone, user?.name || "User", link);
          console.log("[SOS] Contact 1 alert sent\n");
        }
      }
      
      // Update incident with escalation info
      // Set nextActionAt to 20 minutes from now for escalation check
      incident = await storage.updateIncident(incident.id, {
        escalationLevel: 1,
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
      const { checkinIntervalHours, graceMinutes, locationMode, reminderMode, preferredCheckinTime, timezone } = req.body;
      
      const updates: any = {};
      if (checkinIntervalHours !== undefined) updates.checkinIntervalHours = checkinIntervalHours;
      if (graceMinutes !== undefined) updates.graceMinutes = graceMinutes;
      if (locationMode !== undefined) updates.locationMode = locationMode;
      if (reminderMode !== undefined) updates.reminderMode = reminderMode;
      if (preferredCheckinTime !== undefined) updates.preferredCheckinTime = preferredCheckinTime;
      
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

  // Save contacts
  app.post("/api/contacts", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const { contact1Name, contact1Phone, contact2Name, contact2Phone } = req.body;
      
      if (!contact1Name || !contact1Phone) {
        return res.status(400).json({ error: "Contact 1 is required" });
      }
      
      const contacts = await storage.upsertContacts(userId, {
        contact1: {
          name: contact1Name,
          phone: contact1Phone,
          priority: 1,
          canViewLocation: true,
        },
        contact2: contact2Name && contact2Phone ? {
          name: contact2Name,
          phone: contact2Phone,
          priority: 2,
          canViewLocation: true,
        } : undefined,
      });
      
      // Print contact tokens for testing
      const tokens = await storage.getContactTokensForUser(userId);
      if (tokens.length > 0) {
        console.log("\n========================================");
        console.log("Contact Page URLs:");
        for (const t of tokens) {
          console.log(`  ${t.contact.name}: /emergency/${t.token}`);
        }
        console.log("========================================\n");
      }
      
      res.json({ success: true, contacts });
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
      
      // Notify the user that their contact has responded
      if (data.user.phone) {
        const userPhone = normalizePhone(data.user.phone);
        await sendContactRespondedNotification(userPhone, data.contact.name);
        console.log(`[INCIDENT] Notified ${data.user.name} that ${data.contact.name} is checking on them`);
      }
      
      res.json({ success: true, incident });
    } catch (error) {
      console.error("Error handling incident:", error);
      res.status(500).json({ error: "Failed to handle incident" });
    }
  });

  // Contact escalates
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
      
      // Update incident back to open
      const incident = await storage.updateIncident(data.incident.id, {
        status: "open",
        handledByContactId: null,
        nextActionAt: null,
      });
      
      console.log(`\n[INCIDENT] ${data.contact.name} escalated the incident for ${data.user.name}\n`);
      
      // Re-notify contacts
      const contacts = await storage.getContacts(data.user.id);
      const tokens = await storage.getContactTokensForUser(data.user.id);
      const baseUrl = getBaseUrl();
      
      console.log("\n[ESCALATION] Re-notifying contacts...");
      await Promise.all(contacts.map(async (contact) => {
        const token = tokens.find(t => t.contact.id === contact.id);
        if (token) {
          const link = `${baseUrl}/emergency/${token.token}`;
          await sendMissedCheckinAlert(contact.phone, data.user.name, link);
        }
      }));
      console.log("[ESCALATION] Alerts sent\n");
      
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

  // Cron tick - check for due users
  app.get("/api/cron/tick", async (req, res) => {
    try {
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
          // Create missed check-in incident
          let incident = await storage.createIncident(user.id, "missed_checkin");
          const contacts = await storage.getContacts(user.id);
          
          // Create location session if allowed
          if (settings.locationMode === "emergency_only" || settings.locationMode === "both") {
            await storage.createLocationSession(user.id, "emergency", incident.id);
          }
          
          // Get tokens
          const tokens = await storage.getContactTokensForUser(user.id);
          
          // Sequential alerts: Only notify Contact 1 (priority 1) first
          const contact1 = contacts.find(c => c.priority === 1);
          
          if (contact1) {
            const token = tokens.find(t => t.contact.id === contact1.id);
            if (token) {
              const link = `${baseUrl}/emergency/${token.token}`;
              const normalizedPhone = normalizePhone(contact1.phone);
              console.log(`\n[MISSED CHECK-IN] ${user.name} - alerting Contact 1: ${contact1.name}...`);
              await sendMissedCheckinAlert(normalizedPhone, user.name, link);
              console.log("[MISSED CHECK-IN] Contact 1 alert sent\n");
            }
          }
          
          // Update incident with escalation info
          // Set nextActionAt to 20 minutes from now for escalation check
          incident = await storage.updateIncident(incident.id, {
            escalationLevel: 1,
            contact1NotifiedAt: now,
            nextActionAt: addMinutes(now, 20),
          });
          
          alertsSent++;
          
          // Reset reminder state after incident is created
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
            if (user.phone) {
              await sendReminderSms(user.phone, checkInLink);
              await storage.incrementRemindersSent(user.id);
              remindersSent++;
            } else {
              console.log("[REMINDER] No phone number, skipping");
            }
            
            console.log("[REMINDER] Sent\n");
          } else {
            console.log(`[REMINDER] ${user.name} - throttled, ${Math.round(REMINDER_THROTTLE_MINUTES - timeSinceLastReminder)} min until next reminder`);
          }
        }
      }
      
      res.json({ success: true, reminders: remindersSent, alerts: alertsSent });
    } catch (error) {
      console.error("Error in cron tick:", error);
      res.status(500).json({ error: "Cron tick failed" });
    }
  });

  return httpServer;
}
