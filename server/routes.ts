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
} from "./auth";

// Helper to get userId from session
const getUserId = (req: Request): string | null => {
  return (req as any).userId || null;
};

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
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
      
      const normalizedPhone = await createOtp(phone);
      res.json({ success: true, phone: normalizedPhone });
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
      const incident = await storage.createIncident(userId, "sos");
      
      // Get contacts
      const contacts = await storage.getContacts(userId);
      const settings = await storage.getSettings(userId);
      
      // Create location session if allowed
      if (settings?.locationMode === "emergency_only") {
        await storage.createLocationSession(userId, "emergency", incident.id);
      }
      
      // Log SMS notifications (stub)
      console.log("\n========================================");
      console.log("SOS ALERT TRIGGERED");
      console.log("========================================");
      for (const contact of contacts) {
        console.log(`[SMS STUB] Sending SOS alert to ${contact.name} (${contact.phone})`);
      }
      console.log("========================================\n");
      
      res.json({ success: true, incident });
    } catch (error) {
      console.error("Error sending SOS:", error);
      res.status(500).json({ error: "Failed to send SOS" });
    }
  });

  // Update settings
  app.post("/api/settings", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Not authenticated", requiresLogin: true });
      }
      const { checkinIntervalHours, graceMinutes, locationMode } = req.body;
      
      const updates: any = {};
      if (checkinIntervalHours !== undefined) updates.checkinIntervalHours = checkinIntervalHours;
      if (graceMinutes !== undefined) updates.graceMinutes = graceMinutes;
      if (locationMode !== undefined) updates.locationMode = locationMode;
      
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
          console.log(`  ${t.contact.name}: /c/${t.token}`);
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
      
      // Log SMS notifications (stub)
      console.log("\n========================================");
      console.log("TEST NOTIFICATION SENT");
      console.log("========================================");
      for (const contact of contacts) {
        console.log(`[SMS STUB] Sending test notification to ${contact.name} (${contact.phone})`);
      }
      console.log("========================================\n");
      
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
  app.get("/api/c/:token", async (req, res) => {
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
  app.post("/api/c/:token/handle", async (req, res) => {
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
      
      res.json({ success: true, incident });
    } catch (error) {
      console.error("Error handling incident:", error);
      res.status(500).json({ error: "Failed to handle incident" });
    }
  });

  // Contact escalates
  app.post("/api/c/:token/escalate", async (req, res) => {
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
      
      // Log re-notification
      const contacts = await storage.getContacts(data.user.id);
      console.log("========================================");
      console.log("ESCALATION - RE-NOTIFYING CONTACTS");
      console.log("========================================");
      for (const contact of contacts) {
        console.log(`[SMS STUB] Sending escalation to ${contact.name} (${contact.phone})`);
      }
      console.log("========================================\n");
      
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
      const dueUsers = await storage.getDueUsers();
      
      for (const user of dueUsers) {
        // Create missed check-in incident
        const incident = await storage.createIncident(user.id, "missed_checkin");
        const contacts = await storage.getContacts(user.id);
        const settings = await storage.getSettings(user.id);
        
        // Create location session if allowed
        if (settings?.locationMode === "emergency_only") {
          await storage.createLocationSession(user.id, "emergency", incident.id);
        }
        
        // Log SMS notifications (stub)
        console.log("\n========================================");
        console.log(`MISSED CHECK-IN: ${user.name}`);
        console.log("========================================");
        for (const contact of contacts) {
          console.log(`[SMS STUB] Sending missed check-in alert to ${contact.name} (${contact.phone})`);
        }
        console.log("========================================\n");
      }
      
      res.json({ success: true, processed: dueUsers.length });
    } catch (error) {
      console.error("Error in cron tick:", error);
      res.status(500).json({ error: "Cron tick failed" });
    }
  });

  return httpServer;
}
