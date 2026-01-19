import { randomUUID, randomBytes } from "crypto";
import type {
  User,
  InsertUser,
  Settings,
  InsertSettings,
  Contact,
  InsertContact,
  ContactToken,
  Checkin,
  Incident,
  IncidentStatus,
  IncidentReason,
  LocationSession,
  LocationSessionType,
  UserStatus,
  ContactPageData,
  LocationMode,
} from "@shared/schema";
import { addHours } from "date-fns";

export interface IStorage {
  // Users
  getUser(id: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  // Settings
  getSettings(userId: string): Promise<Settings | undefined>;
  updateSettings(userId: string, settings: Partial<InsertSettings>): Promise<Settings>;
  
  // Contacts
  getContacts(userId: string): Promise<Contact[]>;
  getContact(id: string): Promise<Contact | undefined>;
  upsertContacts(userId: string, contacts: { contact1: InsertContact; contact2?: InsertContact }): Promise<Contact[]>;
  
  // Contact Tokens
  getContactByToken(token: string): Promise<{ contact: Contact; user: User } | undefined>;
  generateToken(contactId: string): Promise<ContactToken>;
  
  // Checkins
  getLastCheckin(userId: string): Promise<Checkin | undefined>;
  createCheckin(userId: string): Promise<Checkin>;
  
  // Incidents
  getOpenIncident(userId: string): Promise<Incident | undefined>;
  createIncident(userId: string, reason: IncidentReason): Promise<Incident>;
  updateIncident(id: string, updates: Partial<Incident>): Promise<Incident>;
  
  // Location Sessions
  getActiveLocationSession(userId: string): Promise<LocationSession | undefined>;
  createLocationSession(userId: string, type: LocationSessionType, incidentId?: string): Promise<LocationSession>;
  updateLocationSession(id: string, lat: number, lng: number, accuracy: number): Promise<LocationSession>;
  endLocationSession(id: string): Promise<void>;
  
  // Combined queries
  getUserStatus(userId: string): Promise<UserStatus>;
  getContactPageData(token: string): Promise<ContactPageData | undefined>;
  
  // Scheduler
  getDueUsers(): Promise<User[]>;
  
  // Debug/Testing
  getContactTokensForUser(userId: string): Promise<{ contact: Contact; token: string }[]>;
}

export class MemStorage implements IStorage {
  private users: Map<string, User> = new Map();
  private settings: Map<string, Settings> = new Map();
  private contacts: Map<string, Contact> = new Map();
  private contactTokens: Map<string, ContactToken> = new Map();
  private checkins: Map<string, Checkin> = new Map();
  private incidents: Map<string, Incident> = new Map();
  private locationSessions: Map<string, LocationSession> = new Map();
  
  private defaultUserId: string = "";

  constructor() {
    this.seedData();
  }

  private seedData() {
    // Create demo user "Mum"
    const userId = randomUUID();
    this.defaultUserId = userId;
    
    const user: User = {
      id: userId,
      name: "Mum",
      phone: "+61412345678",
      timezone: "Australia/Melbourne",
      createdAt: new Date(),
    };
    this.users.set(userId, user);
    
    // Create settings
    const userSettings: Settings = {
      userId,
      checkinIntervalHours: 24,
      graceMinutes: 15,
      locationMode: "emergency_only",
      pauseUntil: null,
      updatedAt: new Date(),
    };
    this.settings.set(userId, userSettings);
    
    // Create two contacts
    const contact1Id = randomUUID();
    const contact1: Contact = {
      id: contact1Id,
      userId,
      name: "Sarah (Daughter)",
      phone: "+61423456789",
      priority: 1,
      canViewLocation: true,
      createdAt: new Date(),
    };
    this.contacts.set(contact1Id, contact1);
    
    const contact2Id = randomUUID();
    const contact2: Contact = {
      id: contact2Id,
      userId,
      name: "John (Son)",
      phone: "+61434567890",
      priority: 2,
      canViewLocation: true,
      createdAt: new Date(),
    };
    this.contacts.set(contact2Id, contact2);
    
    // Generate tokens for contacts
    const token1 = randomBytes(16).toString("hex");
    const contactToken1: ContactToken = {
      id: randomUUID(),
      contactId: contact1Id,
      token: token1,
      revoked: false,
      createdAt: new Date(),
    };
    this.contactTokens.set(token1, contactToken1);
    
    const token2 = randomBytes(16).toString("hex");
    const contactToken2: ContactToken = {
      id: randomUUID(),
      contactId: contact2Id,
      token: token2,
      revoked: false,
      createdAt: new Date(),
    };
    this.contactTokens.set(token2, contactToken2);
    
    // Print URLs for testing
    console.log("\n========================================");
    console.log("StillHere - Demo User Created");
    console.log("========================================");
    console.log(`User: ${user.name}`);
    console.log(`Phone: ${user.phone}`);
    console.log("\nEmergency Contacts:");
    console.log(`  1. ${contact1.name} (${contact1.phone})`);
    console.log(`  2. ${contact2.name} (${contact2.phone})`);
    console.log("\nContact Page URLs for Testing:");
    console.log(`  Contact 1: /c/${token1}`);
    console.log(`  Contact 2: /c/${token2}`);
    console.log("========================================\n");
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const user: User = {
      id,
      name: insertUser.name,
      phone: insertUser.phone || null,
      timezone: insertUser.timezone || "Australia/Melbourne",
      createdAt: new Date(),
    };
    this.users.set(id, user);
    
    // Create default settings
    const settings: Settings = {
      userId: id,
      checkinIntervalHours: 24,
      graceMinutes: 15,
      locationMode: "off",
      pauseUntil: null,
      updatedAt: new Date(),
    };
    this.settings.set(id, settings);
    
    return user;
  }

  async getSettings(userId: string): Promise<Settings | undefined> {
    return this.settings.get(userId);
  }

  async updateSettings(userId: string, updates: Partial<InsertSettings>): Promise<Settings> {
    let settings = this.settings.get(userId);
    if (!settings) {
      settings = {
        userId,
        checkinIntervalHours: 24,
        graceMinutes: 15,
        locationMode: "off",
        pauseUntil: null,
        updatedAt: new Date(),
      };
    }
    
    const updated: Settings = {
      ...settings,
      ...updates,
      updatedAt: new Date(),
    };
    this.settings.set(userId, updated);
    return updated;
  }

  async getContacts(userId: string): Promise<Contact[]> {
    return Array.from(this.contacts.values())
      .filter((c) => c.userId === userId)
      .sort((a, b) => a.priority - b.priority);
  }

  async getContact(id: string): Promise<Contact | undefined> {
    return this.contacts.get(id);
  }

  async upsertContacts(
    userId: string,
    contactsData: { contact1: InsertContact; contact2?: InsertContact }
  ): Promise<Contact[]> {
    // Remove existing contacts for user
    const existing = await this.getContacts(userId);
    for (const c of existing) {
      this.contacts.delete(c.id);
    }

    const result: Contact[] = [];

    // Create contact 1
    const contact1Id = randomUUID();
    const contact1: Contact = {
      id: contact1Id,
      userId,
      name: contactsData.contact1.name,
      phone: contactsData.contact1.phone,
      priority: 1,
      canViewLocation: contactsData.contact1.canViewLocation ?? true,
      createdAt: new Date(),
    };
    this.contacts.set(contact1Id, contact1);
    result.push(contact1);

    // Generate token for contact 1
    await this.generateToken(contact1Id);

    // Create contact 2 if provided
    if (contactsData.contact2 && contactsData.contact2.name && contactsData.contact2.phone) {
      const contact2Id = randomUUID();
      const contact2: Contact = {
        id: contact2Id,
        userId,
        name: contactsData.contact2.name,
        phone: contactsData.contact2.phone,
        priority: 2,
        canViewLocation: contactsData.contact2.canViewLocation ?? true,
        createdAt: new Date(),
      };
      this.contacts.set(contact2Id, contact2);
      result.push(contact2);
      await this.generateToken(contact2Id);
    }

    return result;
  }

  async getContactByToken(token: string): Promise<{ contact: Contact; user: User } | undefined> {
    const contactToken = this.contactTokens.get(token);
    if (!contactToken || contactToken.revoked) return undefined;

    const contact = this.contacts.get(contactToken.contactId);
    if (!contact) return undefined;

    const user = this.users.get(contact.userId);
    if (!user) return undefined;

    return { contact, user };
  }

  async generateToken(contactId: string): Promise<ContactToken> {
    const token = randomBytes(16).toString("hex");
    const contactToken: ContactToken = {
      id: randomUUID(),
      contactId,
      token,
      revoked: false,
      createdAt: new Date(),
    };
    this.contactTokens.set(token, contactToken);
    return contactToken;
  }

  async getLastCheckin(userId: string): Promise<Checkin | undefined> {
    const userCheckins = Array.from(this.checkins.values())
      .filter((c) => c.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return userCheckins[0];
  }

  async createCheckin(userId: string): Promise<Checkin> {
    const id = randomUUID();
    const checkin: Checkin = {
      id,
      userId,
      method: "button",
      createdAt: new Date(),
    };
    this.checkins.set(id, checkin);

    // Resolve any open incident
    const openIncident = await this.getOpenIncident(userId);
    if (openIncident) {
      await this.updateIncident(openIncident.id, {
        status: "resolved",
        resolvedAt: new Date(),
      });
    }

    // End any active location session
    const session = await this.getActiveLocationSession(userId);
    if (session) {
      await this.endLocationSession(session.id);
    }

    return checkin;
  }

  async getOpenIncident(userId: string): Promise<Incident | undefined> {
    return Array.from(this.incidents.values()).find(
      (i) => i.userId === userId && i.status !== "resolved"
    );
  }

  async createIncident(userId: string, reason: IncidentReason): Promise<Incident> {
    const id = randomUUID();
    const incident: Incident = {
      id,
      userId,
      status: "open",
      reason,
      startedAt: new Date(),
      resolvedAt: null,
      handledByContactId: null,
      nextActionAt: null,
    };
    this.incidents.set(id, incident);
    return incident;
  }

  async updateIncident(id: string, updates: Partial<Incident>): Promise<Incident> {
    const incident = this.incidents.get(id);
    if (!incident) throw new Error("Incident not found");

    const updated: Incident = { ...incident, ...updates };
    this.incidents.set(id, updated);
    return updated;
  }

  async getActiveLocationSession(userId: string): Promise<LocationSession | undefined> {
    return Array.from(this.locationSessions.values()).find(
      (s) => s.userId === userId && s.active
    );
  }

  async createLocationSession(
    userId: string,
    type: LocationSessionType,
    incidentId?: string
  ): Promise<LocationSession> {
    const id = randomUUID();
    const session: LocationSession = {
      id,
      userId,
      incidentId: incidentId || null,
      type,
      active: true,
      expiresAt: addHours(new Date(), 1),
      lastLat: null,
      lastLng: null,
      lastAccuracy: null,
      lastTimestamp: null,
      updatedAt: new Date(),
    };
    this.locationSessions.set(id, session);
    return session;
  }

  async updateLocationSession(
    id: string,
    lat: number,
    lng: number,
    accuracy: number
  ): Promise<LocationSession> {
    const session = this.locationSessions.get(id);
    if (!session) throw new Error("Location session not found");

    const updated: LocationSession = {
      ...session,
      lastLat: lat,
      lastLng: lng,
      lastAccuracy: accuracy,
      lastTimestamp: new Date(),
      updatedAt: new Date(),
    };
    this.locationSessions.set(id, updated);
    return updated;
  }

  async endLocationSession(id: string): Promise<void> {
    const session = this.locationSessions.get(id);
    if (session) {
      session.active = false;
      session.updatedAt = new Date();
    }
  }

  async getUserStatus(userId: string): Promise<UserStatus> {
    // For demo, use default user if not specified
    const effectiveUserId = userId || this.defaultUserId;
    
    const user = await this.getUser(effectiveUserId);
    if (!user) throw new Error("User not found");

    const settings = await this.getSettings(effectiveUserId);
    if (!settings) throw new Error("Settings not found");

    const contacts = await this.getContacts(effectiveUserId);
    const lastCheckin = await this.getLastCheckin(effectiveUserId);
    const openIncident = await this.getOpenIncident(effectiveUserId);
    const activeLocationSession = await this.getActiveLocationSession(effectiveUserId);

    // Calculate next check-in due
    let nextCheckinDue: Date;
    if (lastCheckin) {
      nextCheckinDue = addHours(lastCheckin.createdAt, settings.checkinIntervalHours);
    } else {
      nextCheckinDue = addHours(user.createdAt, settings.checkinIntervalHours);
    }

    return {
      user,
      settings,
      contacts,
      lastCheckin: lastCheckin || null,
      nextCheckinDue,
      openIncident: openIncident || null,
      activeLocationSession: activeLocationSession || null,
    };
  }

  async getContactPageData(token: string): Promise<ContactPageData | undefined> {
    const result = await this.getContactByToken(token);
    if (!result) return undefined;

    const { contact, user } = result;
    const lastCheckin = await this.getLastCheckin(user.id);
    const incident = await this.getOpenIncident(user.id);
    const locationSession = await this.getActiveLocationSession(user.id);

    let handlingContact: Contact | null = null;
    if (incident?.handledByContactId) {
      handlingContact = (await this.getContact(incident.handledByContactId)) || null;
    }

    return {
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
      },
      contact,
      lastCheckin: lastCheckin || null,
      incident: incident || null,
      locationSession: locationSession || null,
      handlingContact,
    };
  }

  async getDueUsers(): Promise<User[]> {
    const now = new Date();
    const dueUsers: User[] = [];

    for (const user of this.users.values()) {
      const settings = await this.getSettings(user.id);
      if (!settings) continue;

      // Skip if paused
      if (settings.pauseUntil && settings.pauseUntil > now) continue;

      // Skip if already has open incident
      const openIncident = await this.getOpenIncident(user.id);
      if (openIncident) continue;

      // Check if due
      const lastCheckin = await this.getLastCheckin(user.id);
      const lastTime = lastCheckin?.createdAt || user.createdAt;
      const dueTime = addHours(lastTime, settings.checkinIntervalHours);
      const graceTime = new Date(dueTime.getTime() + settings.graceMinutes * 60 * 1000);

      if (now > graceTime) {
        dueUsers.push(user);
      }
    }

    return dueUsers;
  }

  getDefaultUserId(): string {
    return this.defaultUserId;
  }

  async getContactTokensForUser(userId: string): Promise<{ contact: Contact; token: string }[]> {
    const contacts = await this.getContacts(userId);
    const result: { contact: Contact; token: string }[] = [];

    for (const [token, tokenData] of this.contactTokens.entries()) {
      if (tokenData.revoked) continue;
      const contact = contacts.find((c) => c.id === tokenData.contactId);
      if (contact) {
        result.push({ contact, token });
      }
    }

    return result.sort((a, b) => a.contact.priority - b.contact.priority);
  }
}

export const storage = new MemStorage();
