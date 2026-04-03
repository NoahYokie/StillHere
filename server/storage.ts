import { randomBytes } from "crypto";
import { eq, desc, and, ne, gt, lt, or, isNull } from "drizzle-orm";
import { db } from "./db";
import {
  users,
  settings,
  contacts,
  contactTokens,
  checkins,
  incidents,
  locationSessions,
  pushSubscriptions,
  messages,
  calls,
  voipTokens,
  passkeys,
  heartRateReadings,
  heartRateAlerts,
  geofences,
  locationBreadcrumbs,
  satelliteDevices,
  type User,
  type InsertUser,
  type Settings,
  type InsertSettings,
  type Contact,
  type InsertContact,
  type ContactToken,
  type Checkin,
  type Incident,
  type IncidentReason,
  type LocationSession,
  type LocationSessionType,
  type UserStatus,
  type ContactPageData,
  type WatchedUser,
  type PushSubscription,
  type Message,
  type Call,
  type CallStatus,
  type CallType,
  type Passkey,
  type HeartRateReading,
  type HeartRateAlert,
  type Geofence,
  type LocationBreadcrumb,
  type SatelliteDevice,
} from "@shared/schema";
import { addHours } from "date-fns";

export interface IStorage {
  // Users
  getUser(id: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, updates: Partial<InsertUser>): Promise<User>;
  
  // Settings
  getSettings(userId: string): Promise<Settings | undefined>;
  updateSettings(userId: string, settings: Partial<InsertSettings>): Promise<Settings>;
  incrementRemindersSent(userId: string): Promise<Settings>;
  resetReminderState(userId: string): Promise<Settings>;
  
  // Contacts
  getContacts(userId: string): Promise<Contact[]>;
  getContact(id: string): Promise<Contact | undefined>;
  upsertContacts(userId: string, contactsData: { contact1: InsertContact; contact2?: InsertContact }): Promise<Contact[]>;
  saveContactsList(userId: string, contactsList: { name: string; phone: string; email?: string | null; priority: number }[]): Promise<Contact[]>;
  deleteContact(contactId: string): Promise<void>;
  getContactLimit(userId: string): Promise<number>;
  
  // Contact Tokens
  getContactByToken(token: string): Promise<{ contact: Contact; user: User } | undefined>;
  generateToken(contactId: string): Promise<ContactToken>;
  
  // Checkins
  getLastCheckin(userId: string): Promise<Checkin | undefined>;
  createCheckin(userId: string, method?: "button" | "auto" | "sms"): Promise<Checkin>;
  
  // Incidents
  getOpenIncident(userId: string): Promise<Incident | undefined>;
  getIncidentsNeedingEscalation(): Promise<Incident[]>;
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
  
  // Tokens
  getContactTokensForUser(userId: string): Promise<{ contact: Contact; token: string }[]>;
  
  // Push Subscriptions
  savePushSubscription(userId: string, endpoint: string, p256dh: string, auth: string): Promise<PushSubscription>;
  getPushSubscriptions(userId: string): Promise<PushSubscription[]>;
  deletePushSubscription(endpoint: string): Promise<void>;
  deletePushSubscriptionForUser(userId: string, endpoint: string): Promise<void>;

  // Messages
  saveMessage(senderId: string, receiverId: string, content: string): Promise<Message>;
  getMessages(userId1: string, userId2: string, limit?: number): Promise<Message[]>;
  markMessagesRead(senderId: string, receiverId: string): Promise<void>;
  getUnreadCount(userId: string): Promise<number>;

  // Calls
  getCall(id: string): Promise<Call | undefined>;
  createCall(callerId: string, receiverId: string, callType: CallType): Promise<Call>;
  updateCall(id: string, updates: Partial<Call>): Promise<Call>;

  // Contact Linking
  getUserByPhone(phone: string): Promise<User | undefined>;
  linkContactToUser(contactId: string, linkedUserId: string | null): Promise<Contact>;
  findContactsByPhone(phone: string): Promise<Contact[]>;
  getWatchedUsers(watcherUserId: string): Promise<WatchedUser[]>;
  getContactsLinkedToUser(linkedUserId: string): Promise<Contact[]>;

  // VoIP Tokens
  saveVoipToken(userId: string, token: string, platform: string): Promise<void>;
  getVoipTokens(userId: string): Promise<{ token: string; platform: string }[]>;
  deleteVoipToken(userId: string, token: string): Promise<void>;

  // Passkeys
  getPasskeysByUserId(userId: string): Promise<Passkey[]>;
  getPasskeyByCredentialId(credentialId: string): Promise<Passkey | undefined>;
  createPasskey(data: { userId: string; credentialId: string; publicKey: string; counter: number; transports?: string; deviceType?: string; backedUp: boolean }): Promise<Passkey>;
  updatePasskeyCounter(credentialId: string, counter: number): Promise<void>;
  deletePasskey(id: string, userId: string): Promise<void>;

  // Heart Rate
  saveHeartRateReadings(userId: string, readings: { bpm: number; recordedAt: Date; source?: string }[]): Promise<HeartRateReading[]>;
  getLatestHeartRate(userId: string): Promise<HeartRateReading | undefined>;
  getHeartRateHistory(userId: string, hours?: number): Promise<HeartRateReading[]>;
  createHeartRateAlert(userId: string, alertType: string, bpm: number): Promise<HeartRateAlert>;
  getActiveHeartRateAlerts(userId: string): Promise<HeartRateAlert[]>;
  resolveHeartRateAlert(alertId: string): Promise<void>;

  // Geofences
  getGeofences(userId: string): Promise<Geofence[]>;
  createGeofence(userId: string, data: { name: string; lat: number; lng: number; radiusMeters: number; type: string }): Promise<Geofence>;
  updateGeofence(id: string, userId: string, data: Partial<{ name: string; lat: number; lng: number; radiusMeters: number; active: boolean }>): Promise<Geofence>;
  deleteGeofence(id: string, userId: string): Promise<void>;

  // Location Breadcrumbs
  saveBreadcrumb(userId: string, sessionId: string | null, lat: number, lng: number, accuracy: number | null): Promise<LocationBreadcrumb>;
  getBreadcrumbs(userId: string, sessionId?: string, limit?: number): Promise<LocationBreadcrumb[]>;

  // Satellite Devices
  getSatelliteDevices(userId: string): Promise<SatelliteDevice[]>;
  registerSatelliteDevice(userId: string, data: { deviceType: string; deviceId: string; name: string }): Promise<SatelliteDevice>;
  getSatelliteDeviceByDeviceId(deviceId: string): Promise<(SatelliteDevice & { user: User }) | undefined>;
  deleteSatelliteDevice(id: string, userId: string): Promise<void>;

  // SMS Checkin
  getUserByPhone(phone: string): Promise<User | undefined>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    
    // Create default settings
    await db.insert(settings).values({
      userId: user.id,
      checkinIntervalHours: 24,
      graceMinutes: 15,
      locationMode: "off",
    });
    
    return user;
  }

  async updateUser(id: string, updates: Partial<InsertUser>): Promise<User> {
    const [user] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, id))
      .returning();
    return user;
  }

  async getSettings(userId: string): Promise<Settings | undefined> {
    const [result] = await db.select().from(settings).where(eq(settings.userId, userId));
    return result || undefined;
  }

  async updateSettings(userId: string, updates: Partial<InsertSettings>): Promise<Settings> {
    const existing = await this.getSettings(userId);
    
    if (!existing) {
      // Create if doesn't exist
      const [result] = await db.insert(settings).values({
        userId,
        checkinIntervalHours: updates.checkinIntervalHours ?? 24,
        graceMinutes: updates.graceMinutes ?? 15,
        locationMode: updates.locationMode ?? "off",
        reminderMode: updates.reminderMode ?? "one",
        pauseUntil: updates.pauseUntil,
      }).returning();
      return result;
    }
    
    const [result] = await db
      .update(settings)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(settings.userId, userId))
      .returning();
    return result;
  }

  async incrementRemindersSent(userId: string): Promise<Settings> {
    const existing = await this.getSettings(userId);
    if (!existing) {
      throw new Error("Settings not found");
    }
    
    const [result] = await db
      .update(settings)
      .set({ 
        remindersSent: (existing.remindersSent || 0) + 1,
        lastReminderAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(settings.userId, userId))
      .returning();
    return result;
  }

  async resetReminderState(userId: string): Promise<Settings> {
    const [result] = await db
      .update(settings)
      .set({ 
        remindersSent: 0,
        lastReminderAt: null,
        updatedAt: new Date()
      })
      .where(eq(settings.userId, userId))
      .returning();
    return result;
  }

  async getContacts(userId: string): Promise<Contact[]> {
    return db.select().from(contacts).where(eq(contacts.userId, userId)).orderBy(contacts.priority);
  }

  async getContact(id: string): Promise<Contact | undefined> {
    const [contact] = await db.select().from(contacts).where(eq(contacts.id, id));
    return contact || undefined;
  }

  async upsertContacts(
    userId: string,
    contactsData: { contact1: InsertContact; contact2?: InsertContact }
  ): Promise<Contact[]> {
    // Get existing contacts
    const existing = await this.getContacts(userId);
    const result: Contact[] = [];

    // Update or create contact 1
    const existingContact1 = existing.find(c => c.priority === 1);
    if (existingContact1) {
      // Update existing contact
      const [updated] = await db.update(contacts)
        .set({
          name: contactsData.contact1.name,
          phone: contactsData.contact1.phone,
          canViewLocation: contactsData.contact1.canViewLocation ?? true,
        })
        .where(eq(contacts.id, existingContact1.id))
        .returning();
      result.push(updated);
      // Regenerate token for updated contact
      await db.delete(contactTokens).where(eq(contactTokens.contactId, existingContact1.id));
      await this.generateToken(existingContact1.id);
    } else {
      // Create new contact
      const [contact1] = await db.insert(contacts).values({
        userId,
        name: contactsData.contact1.name,
        phone: contactsData.contact1.phone,
        priority: 1,
        canViewLocation: contactsData.contact1.canViewLocation ?? true,
      }).returning();
      result.push(contact1);
      await this.generateToken(contact1.id);
    }

    // Handle contact 2
    const existingContact2 = existing.find(c => c.priority === 2);
    if (contactsData.contact2?.name && contactsData.contact2?.phone) {
      if (existingContact2) {
        // Update existing contact 2
        const [updated] = await db.update(contacts)
          .set({
            name: contactsData.contact2.name,
            phone: contactsData.contact2.phone,
            canViewLocation: contactsData.contact2.canViewLocation ?? true,
          })
          .where(eq(contacts.id, existingContact2.id))
          .returning();
        result.push(updated);
        // Regenerate token for updated contact
        await db.delete(contactTokens).where(eq(contactTokens.contactId, existingContact2.id));
        await this.generateToken(existingContact2.id);
      } else {
        // Create new contact 2
        const [contact2] = await db.insert(contacts).values({
          userId,
          name: contactsData.contact2.name,
          phone: contactsData.contact2.phone,
          priority: 2,
          canViewLocation: contactsData.contact2.canViewLocation ?? true,
        }).returning();
        result.push(contact2);
        await this.generateToken(contact2.id);
      }
    } else if (existingContact2) {
      // Remove contact 2 if no longer provided - but clear any incident references first
      await db.update(incidents)
        .set({ handledByContactId: null })
        .where(eq(incidents.handledByContactId, existingContact2.id));
      await db.delete(contactTokens).where(eq(contactTokens.contactId, existingContact2.id));
      await db.delete(contacts).where(eq(contacts.id, existingContact2.id));
    }

    return result;
  }

  async getContactLimit(userId: string): Promise<number> {
    const user = await this.getUser(userId);
    return user?.isPremium ? 999 : 2;
  }

  async saveContactsList(userId: string, contactsList: { name: string; phone: string; email?: string | null; priority: number }[]): Promise<Contact[]> {
    const existing = await this.getContacts(userId);
    const result: Contact[] = [];
    const processedIds = new Set<string>();

    for (const contactData of contactsList) {
      const existingMatch = existing.find(c => c.priority === contactData.priority);
      
      if (existingMatch) {
        const [updated] = await db.update(contacts)
          .set({
            name: contactData.name,
            phone: contactData.phone,
            email: contactData.email || null,
            canViewLocation: true,
          })
          .where(eq(contacts.id, existingMatch.id))
          .returning();
        result.push(updated);
        processedIds.add(existingMatch.id);
        await db.delete(contactTokens).where(eq(contactTokens.contactId, existingMatch.id));
        await this.generateToken(existingMatch.id);
      } else {
        const [newContact] = await db.insert(contacts).values({
          userId,
          name: contactData.name,
          phone: contactData.phone,
          email: contactData.email || null,
          priority: contactData.priority,
          canViewLocation: true,
        }).returning();
        result.push(newContact);
        await this.generateToken(newContact.id);
      }
    }

    for (const existingContact of existing) {
      if (!processedIds.has(existingContact.id) && !contactsList.some(c => c.priority === existingContact.priority)) {
        await db.update(incidents)
          .set({ handledByContactId: null })
          .where(eq(incidents.handledByContactId, existingContact.id));
        await db.delete(contactTokens).where(eq(contactTokens.contactId, existingContact.id));
        await db.delete(contacts).where(eq(contacts.id, existingContact.id));
      }
    }

    return result.sort((a, b) => a.priority - b.priority);
  }

  async deleteContact(contactId: string): Promise<void> {
    await db.update(incidents)
      .set({ handledByContactId: null })
      .where(eq(incidents.handledByContactId, contactId));
    await db.delete(contactTokens).where(eq(contactTokens.contactId, contactId));
    await db.delete(contacts).where(eq(contacts.id, contactId));
  }

  async getContactByToken(token: string): Promise<{ contact: Contact; user: User } | undefined> {
    const [tokenRecord] = await db.select().from(contactTokens).where(
      and(eq(contactTokens.token, token), eq(contactTokens.revoked, false))
    );
    if (!tokenRecord) return undefined;
    
    if (tokenRecord.expiresAt && new Date(tokenRecord.expiresAt) < new Date()) {
      return undefined;
    }

    const contact = await this.getContact(tokenRecord.contactId);
    if (!contact) return undefined;

    const user = await this.getUser(contact.userId);
    if (!user) return undefined;

    return { contact, user };
  }

  async generateToken(contactId: string): Promise<ContactToken> {
    // Generate a short, URL-safe token (10 characters, mixed case alphanumeric)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let token = '';
    const bytes = randomBytes(10);
    for (let i = 0; i < 10; i++) {
      token += chars[bytes[i] % chars.length];
    }
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    const [result] = await db.insert(contactTokens).values({
      contactId,
      token,
      revoked: false,
      expiresAt,
    }).returning();
    return result;
  }

  async getLastCheckin(userId: string): Promise<Checkin | undefined> {
    const [checkin] = await db
      .select()
      .from(checkins)
      .where(eq(checkins.userId, userId))
      .orderBy(desc(checkins.createdAt))
      .limit(1);
    return checkin || undefined;
  }

  async createCheckin(userId: string, method: "button" | "auto" | "sms" = "button"): Promise<Checkin> {
    const [checkin] = await db.insert(checkins).values({
      userId,
      method,
    }).returning();

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
    const [incident] = await db
      .select()
      .from(incidents)
      .where(and(eq(incidents.userId, userId), ne(incidents.status, "resolved")));
    return incident || undefined;
  }

  async getIncidentsNeedingEscalation(): Promise<Incident[]> {
    const now = new Date();
    // Get incidents where:
    // 1. Status is not resolved AND
    // 2. Either:
    //    a) nextActionAt is set and has passed (normal case), OR
    //    b) nextActionAt is null (stalled incident needing recovery)
    const result = await db
      .select()
      .from(incidents)
      .where(
        and(
          ne(incidents.status, "resolved"),
          or(
            // Normal case: nextActionAt has passed
            and(
              gt(incidents.nextActionAt, new Date(0)),
              lt(incidents.nextActionAt, now)
            ),
            // Recovery case: active incident with null nextActionAt
            isNull(incidents.nextActionAt)
          )
        )
      );
    return result;
  }

  async createIncident(userId: string, reason: IncidentReason): Promise<Incident> {
    const [incident] = await db.insert(incidents).values({
      userId,
      status: "open",
      reason,
    }).returning();
    return incident;
  }

  async updateIncident(id: string, updates: Partial<Incident>): Promise<Incident> {
    const [incident] = await db
      .update(incidents)
      .set(updates)
      .where(eq(incidents.id, id))
      .returning();
    if (!incident) throw new Error("Incident not found");
    return incident;
  }

  async getActiveLocationSession(userId: string): Promise<LocationSession | undefined> {
    const [session] = await db
      .select()
      .from(locationSessions)
      .where(and(eq(locationSessions.userId, userId), eq(locationSessions.active, true)));
    return session || undefined;
  }

  async createLocationSession(
    userId: string,
    type: LocationSessionType,
    incidentId?: string
  ): Promise<LocationSession> {
    const [session] = await db.insert(locationSessions).values({
      userId,
      incidentId: incidentId || null,
      type,
      active: true,
      expiresAt: addHours(new Date(), 1),
    }).returning();
    return session;
  }

  async updateLocationSession(
    id: string,
    lat: number,
    lng: number,
    accuracy: number
  ): Promise<LocationSession> {
    const [session] = await db
      .update(locationSessions)
      .set({
        lastLat: lat,
        lastLng: lng,
        lastAccuracy: accuracy,
        lastTimestamp: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(locationSessions.id, id))
      .returning();
    if (!session) throw new Error("Location session not found");
    return session;
  }

  async endLocationSession(id: string): Promise<void> {
    await db
      .update(locationSessions)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(locationSessions.id, id));
  }

  async getUserStatus(userId: string): Promise<UserStatus> {
    const user = await this.getUser(userId);
    if (!user) throw new Error("User not found");

    const userSettings = await this.getSettings(userId);
    if (!userSettings) throw new Error("Settings not found");

    const userContacts = await this.getContacts(userId);
    const lastCheckin = await this.getLastCheckin(userId);
    const openIncident = await this.getOpenIncident(userId);
    const activeLocationSession = await this.getActiveLocationSession(userId);

    // Calculate next checkin due
    let nextCheckinDue: Date;
    if (lastCheckin) {
      nextCheckinDue = addHours(lastCheckin.createdAt, userSettings.checkinIntervalHours);
    } else {
      nextCheckinDue = addHours(user.createdAt, userSettings.checkinIntervalHours);
    }

    const contactLimit = await this.getContactLimit(userId);

    return {
      user,
      settings: userSettings,
      contacts: userContacts,
      lastCheckin: lastCheckin || null,
      nextCheckinDue,
      openIncident: openIncident || null,
      activeLocationSession: activeLocationSession || null,
      contactLimit,
      isPremium: user.isPremium,
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

  async getOverdueUsersWithSettings(): Promise<{ user: User; settings: Settings; isDueForReminder: boolean; isDueForAlert: boolean }[]> {
    const now = new Date();
    const allUsers = await db.select().from(users);
    const results: { user: User; settings: Settings; isDueForReminder: boolean; isDueForAlert: boolean }[] = [];

    for (const user of allUsers) {
      const userSettings = await this.getSettings(user.id);
      if (!userSettings) continue;

      // Skip if paused
      if (userSettings.pauseUntil && userSettings.pauseUntil > now) continue;

      // Skip if already has open incident
      const openIncident = await this.getOpenIncident(user.id);
      if (openIncident) continue;

      // Check timing
      const lastCheckin = await this.getLastCheckin(user.id);
      const lastTime = lastCheckin?.createdAt || user.createdAt;
      const dueTime = addHours(lastTime, userSettings.checkinIntervalHours);
      const graceTime = new Date(dueTime.getTime() + userSettings.graceMinutes * 60 * 1000);

      if (now > dueTime) {
        results.push({ user, settings: userSettings, isDueForReminder: true, isDueForAlert: now > graceTime });
      }
    }

    return results;
  }

  async getDueUsers(): Promise<User[]> {
    const results = await this.getOverdueUsersWithSettings();
    return results.filter(r => r.isDueForAlert).map(r => r.user);
  }

  async getContactTokensForUser(userId: string): Promise<{ contact: Contact; token: string }[]> {
    const userContacts = await this.getContacts(userId);
    const result: { contact: Contact; token: string }[] = [];

    for (const contact of userContacts) {
      const [tokenRecord] = await db
        .select()
        .from(contactTokens)
        .where(and(eq(contactTokens.contactId, contact.id), eq(contactTokens.revoked, false)));
      if (tokenRecord) {
        result.push({ contact, token: tokenRecord.token });
      }
    }

    return result.sort((a, b) => a.contact.priority - b.contact.priority);
  }

  async savePushSubscription(userId: string, endpoint: string, p256dh: string, auth: string): Promise<PushSubscription> {
    const existing = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint));

    if (existing.length > 0) {
      const [updated] = await db
        .update(pushSubscriptions)
        .set({ userId, p256dh, auth })
        .where(eq(pushSubscriptions.endpoint, endpoint))
        .returning();
      return updated;
    }

    const [sub] = await db
      .insert(pushSubscriptions)
      .values({ userId, endpoint, p256dh, auth })
      .returning();
    return sub;
  }

  async getPushSubscriptions(userId: string): Promise<PushSubscription[]> {
    return db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  }

  async deletePushSubscription(endpoint: string): Promise<void> {
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  }

  async deletePushSubscriptionForUser(userId: string, endpoint: string): Promise<void> {
    await db.delete(pushSubscriptions).where(
      and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint))
    );
  }

  async saveMessage(senderId: string, receiverId: string, content: string): Promise<Message> {
    const [msg] = await db.insert(messages).values({
      senderId,
      receiverId,
      content,
      read: false,
    }).returning();
    return msg;
  }

  async getMessages(userId1: string, userId2: string, limit = 50): Promise<Message[]> {
    const result = await db.select().from(messages).where(
      or(
        and(eq(messages.senderId, userId1), eq(messages.receiverId, userId2)),
        and(eq(messages.senderId, userId2), eq(messages.receiverId, userId1))
      )
    ).orderBy(desc(messages.createdAt)).limit(limit);
    return result.reverse();
  }

  async markMessagesRead(senderId: string, receiverId: string): Promise<void> {
    await db.update(messages).set({ read: true }).where(
      and(eq(messages.senderId, senderId), eq(messages.receiverId, receiverId), eq(messages.read, false))
    );
  }

  async getUnreadCount(userId: string): Promise<number> {
    const result = await db.select().from(messages).where(
      and(eq(messages.receiverId, userId), eq(messages.read, false))
    );
    return result.length;
  }

  async getCall(id: string): Promise<Call | undefined> {
    const [call] = await db.select().from(calls).where(eq(calls.id, id));
    return call;
  }

  async createCall(callerId: string, receiverId: string, callType: CallType): Promise<Call> {
    const [call] = await db.insert(calls).values({
      callerId,
      receiverId,
      status: "ringing",
      callType,
    }).returning();
    return call;
  }

  async updateCall(id: string, updates: Partial<Call>): Promise<Call> {
    const [call] = await db.update(calls).set(updates).where(eq(calls.id, id)).returning();
    if (!call) throw new Error("Call not found");
    return call;
  }

  async getUserByPhone(phone: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.phone, phone));
    return user || undefined;
  }

  async findContactsByPhone(phone: string): Promise<Contact[]> {
    return db.select().from(contacts).where(eq(contacts.phone, phone));
  }

  async linkContactToUser(contactId: string, linkedUserId: string | null): Promise<Contact> {
    const [contact] = await db.update(contacts)
      .set({ linkedUserId })
      .where(eq(contacts.id, contactId))
      .returning();
    return contact;
  }

  async getWatchedUsers(watcherUserId: string): Promise<WatchedUser[]> {
    const watcherUser = await this.getUser(watcherUserId);
    if (!watcherUser?.phone) return [];

    const linkedContacts = await db.select().from(contacts).where(
      eq(contacts.linkedUserId, watcherUserId)
    );

    const result: WatchedUser[] = [];

    for (const contact of linkedContacts) {
      const user = await this.getUser(contact.userId);
      if (!user) continue;

      const userSettings = await this.getSettings(user.id);
      const lastCheckin = await this.getLastCheckin(user.id);
      const openIncident = await this.getOpenIncident(user.id);

      let nextCheckinDue: Date;
      if (lastCheckin) {
        nextCheckinDue = addHours(lastCheckin.createdAt, userSettings?.checkinIntervalHours || 24);
      } else {
        nextCheckinDue = addHours(user.createdAt, userSettings?.checkinIntervalHours || 24);
      }

      result.push({
        userId: user.id,
        userName: user.name,
        lastCheckinAt: lastCheckin?.createdAt || null,
        nextCheckinDue,
        hasOpenIncident: !!openIncident,
        incidentReason: openIncident?.reason || null,
        contactId: contact.id,
      });
    }

    return result;
  }

  async getContactsLinkedToUser(linkedUserId: string): Promise<Contact[]> {
    return db.select().from(contacts).where(eq(contacts.linkedUserId, linkedUserId));
  }

  async saveVoipToken(userId: string, token: string, platform: string): Promise<void> {
    await db.delete(voipTokens).where(
      and(eq(voipTokens.userId, userId), eq(voipTokens.token, token))
    );
    await db.insert(voipTokens).values({ userId, token, platform });
  }

  async getVoipTokens(userId: string): Promise<{ token: string; platform: string }[]> {
    const rows = await db.select({
      token: voipTokens.token,
      platform: voipTokens.platform,
    }).from(voipTokens).where(eq(voipTokens.userId, userId));
    return rows;
  }

  async deleteVoipToken(userId: string, token: string): Promise<void> {
    await db.delete(voipTokens).where(
      and(eq(voipTokens.userId, userId), eq(voipTokens.token, token))
    );
  }

  async getPasskeysByUserId(userId: string): Promise<Passkey[]> {
    return db.select().from(passkeys).where(eq(passkeys.userId, userId));
  }

  async getPasskeyByCredentialId(credentialId: string): Promise<Passkey | undefined> {
    const [row] = await db.select().from(passkeys).where(eq(passkeys.credentialId, credentialId));
    return row || undefined;
  }

  async createPasskey(data: { userId: string; credentialId: string; publicKey: string; counter: number; transports?: string; deviceType?: string; backedUp: boolean }): Promise<Passkey> {
    const [row] = await db.insert(passkeys).values(data).returning();
    return row;
  }

  async updatePasskeyCounter(credentialId: string, counter: number): Promise<void> {
    await db.update(passkeys).set({ counter }).where(eq(passkeys.credentialId, credentialId));
  }

  async deletePasskey(id: string, userId: string): Promise<void> {
    await db.delete(passkeys).where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)));
  }

  async saveHeartRateReadings(userId: string, readings: { bpm: number; recordedAt: Date; source?: string }[]): Promise<HeartRateReading[]> {
    if (readings.length === 0) return [];
    const values = readings.map(r => ({
      userId,
      bpm: r.bpm,
      source: r.source || "watch",
      recordedAt: r.recordedAt,
    }));
    return db.insert(heartRateReadings).values(values).returning();
  }

  async getLatestHeartRate(userId: string): Promise<HeartRateReading | undefined> {
    const [row] = await db.select()
      .from(heartRateReadings)
      .where(eq(heartRateReadings.userId, userId))
      .orderBy(desc(heartRateReadings.recordedAt))
      .limit(1);
    return row || undefined;
  }

  async getHeartRateHistory(userId: string, hours: number = 24): Promise<HeartRateReading[]> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    return db.select()
      .from(heartRateReadings)
      .where(and(
        eq(heartRateReadings.userId, userId),
        gt(heartRateReadings.recordedAt, since)
      ))
      .orderBy(desc(heartRateReadings.recordedAt));
  }

  async createHeartRateAlert(userId: string, alertType: string, bpm: number): Promise<HeartRateAlert> {
    const [row] = await db.insert(heartRateAlerts).values({
      userId,
      alertType,
      bpm,
    }).returning();
    return row;
  }

  async getActiveHeartRateAlerts(userId: string): Promise<HeartRateAlert[]> {
    return db.select()
      .from(heartRateAlerts)
      .where(and(
        eq(heartRateAlerts.userId, userId),
        eq(heartRateAlerts.resolved, false)
      ))
      .orderBy(desc(heartRateAlerts.createdAt));
  }

  async resolveHeartRateAlert(alertId: string): Promise<void> {
    await db.update(heartRateAlerts).set({
      resolved: true,
      resolvedAt: new Date(),
    }).where(eq(heartRateAlerts.id, alertId));
  }

  async getGeofences(userId: string): Promise<Geofence[]> {
    return db.select().from(geofences).where(eq(geofences.userId, userId));
  }

  async createGeofence(userId: string, data: { name: string; lat: number; lng: number; radiusMeters: number; type: string }): Promise<Geofence> {
    const [row] = await db.insert(geofences).values({
      userId,
      name: data.name,
      lat: data.lat,
      lng: data.lng,
      radiusMeters: data.radiusMeters,
      type: data.type as any,
    }).returning();
    return row;
  }

  async updateGeofence(id: string, userId: string, data: Partial<{ name: string; lat: number; lng: number; radiusMeters: number; active: boolean }>): Promise<Geofence> {
    const [row] = await db.update(geofences).set(data).where(and(eq(geofences.id, id), eq(geofences.userId, userId))).returning();
    return row;
  }

  async deleteGeofence(id: string, userId: string): Promise<void> {
    await db.delete(geofences).where(and(eq(geofences.id, id), eq(geofences.userId, userId)));
  }

  async saveBreadcrumb(userId: string, sessionId: string | null, lat: number, lng: number, accuracy: number | null): Promise<LocationBreadcrumb> {
    const [row] = await db.insert(locationBreadcrumbs).values({
      userId,
      sessionId,
      lat,
      lng,
      accuracy,
      recordedAt: new Date(),
    }).returning();
    return row;
  }

  async getBreadcrumbs(userId: string, sessionId?: string, limit: number = 100): Promise<LocationBreadcrumb[]> {
    const conditions = [eq(locationBreadcrumbs.userId, userId)];
    if (sessionId) conditions.push(eq(locationBreadcrumbs.sessionId, sessionId));
    return db.select()
      .from(locationBreadcrumbs)
      .where(and(...conditions))
      .orderBy(desc(locationBreadcrumbs.recordedAt))
      .limit(limit);
  }

  async getSatelliteDevices(userId: string): Promise<SatelliteDevice[]> {
    return db.select().from(satelliteDevices).where(eq(satelliteDevices.userId, userId));
  }

  async registerSatelliteDevice(userId: string, data: { deviceType: string; deviceId: string; name: string }): Promise<SatelliteDevice> {
    const existing = await db.select().from(satelliteDevices)
      .where(and(eq(satelliteDevices.userId, userId), eq(satelliteDevices.deviceId, data.deviceId)));
    if (existing.length > 0) {
      const [updated] = await db.update(satelliteDevices)
        .set({ name: data.name, active: true, lastSeenAt: new Date() })
        .where(eq(satelliteDevices.id, existing[0].id))
        .returning();
      return updated;
    }
    const [row] = await db.insert(satelliteDevices).values({
      userId,
      deviceType: data.deviceType,
      deviceId: data.deviceId,
      name: data.name,
    }).returning();
    return row;
  }

  async getSatelliteDeviceByDeviceId(deviceId: string): Promise<(SatelliteDevice & { user: User }) | undefined> {
    const [device] = await db.select().from(satelliteDevices)
      .where(and(eq(satelliteDevices.deviceId, deviceId), eq(satelliteDevices.active, true)));
    if (!device) return undefined;
    const user = await this.getUser(device.userId);
    if (!user) return undefined;
    return { ...device, user };
  }

  async deleteSatelliteDevice(id: string, userId: string): Promise<void> {
    await db.delete(satelliteDevices).where(and(eq(satelliteDevices.id, id), eq(satelliteDevices.userId, userId)));
  }
}

export const storage = new DatabaseStorage();
