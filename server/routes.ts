import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { addMinutes, addHours } from "date-fns";
import { db } from "./db";
import { users } from "@shared/schema";

// Store default user ID in memory (set on first request or user creation)
let defaultUserId: string | null = null;

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Helper to get or create the default user ID
  const getDefaultUserId = async (): Promise<string | null> => {
    if (defaultUserId) return defaultUserId;
    
    // Try to find existing user
    const [existingUser] = await db.select().from(users).limit(1);
    if (existingUser) {
      defaultUserId = existingUser.id;
      return defaultUserId;
    }
    
    return null;
  };

  // Create/setup user
  app.post("/api/setup", async (req, res) => {
    try {
      const { name, phone } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: "Name is required" });
      }
      
      // Check if user already exists
      const existingId = await getDefaultUserId();
      if (existingId) {
        return res.status(400).json({ error: "User already exists" });
      }
      
      // Create new user
      const user = await storage.createUser({ name, phone });
      defaultUserId = user.id;
      
      console.log("\n========================================");
      console.log("StillHere - User Created");
      console.log("========================================");
      console.log(`User: ${user.name}`);
      console.log(`Phone: ${user.phone || "Not set"}`);
      console.log("========================================\n");
      
      res.json({ success: true, user });
    } catch (error) {
      console.error("Error setting up user:", error);
      res.status(500).json({ error: "Failed to create user" });
    }
  });

  // Get user status
  app.get("/api/status", async (req, res) => {
    try {
      const userId = await getDefaultUserId();
      if (!userId) {
        return res.status(404).json({ error: "No user found", needsSetup: true });
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
      const userId = await getDefaultUserId();
      if (!userId) {
        return res.status(404).json({ error: "No user found" });
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
      const userId = await getDefaultUserId();
      if (!userId) {
        return res.status(404).json({ error: "No user found" });
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
      const userId = await getDefaultUserId();
      if (!userId) {
        return res.status(404).json({ error: "No user found" });
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
      const userId = await getDefaultUserId();
      if (!userId) {
        return res.status(404).json({ error: "No user found" });
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
      const userId = await getDefaultUserId();
      if (!userId) {
        return res.status(404).json({ error: "No user found" });
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
      const userId = await getDefaultUserId();
      if (!userId) {
        return res.status(404).json({ error: "No user found" });
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

  // Location update
  app.post("/api/location/update", async (req, res) => {
    try {
      const userId = await getDefaultUserId();
      if (!userId) {
        return res.status(404).json({ error: "No user found" });
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
