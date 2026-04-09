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
  reportPreferences,
  type ReportPreference,
  type DailyStatus,
  driveSessions,
  speedAlerts,
  type DriveSession,
  type SpeedAlert,
  errorReports,
  appRatings,
  type ErrorReport,
  type AppRating,
  liveLocationShares,
  liveLocationPoints,
  type LiveLocationShare,
  type LiveLocationPoint,
} from "@shared/schema";
import { addHours, startOfDay, format } from "date-fns";
import { gte, lte } from "drizzle-orm";

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
  softDeleteContact(contactId: string, deletedBy: string): Promise<Contact>;
  restoreContact(contactId: string): Promise<Contact>;
  getSoftDeletedContacts(userId: string): Promise<Contact[]>;
  getSoftDeletedContactsByWatcher(watcherUserId: string): Promise<(Contact & { ownerName: string })[]>;
  cleanupExpiredSoftDeletes(): Promise<number>;
  getContactLimit(userId: string): Promise<number>;
  
  // Contact Tokens
  getContactByToken(token: string): Promise<{ contact: Contact; user: User } | undefined>;
  generateToken(contactId: string): Promise<ContactToken>;
  
  // Checkins
  getLastCheckin(userId: string): Promise<Checkin | undefined>;
  createCheckin(userId: string, method?: "button" | "auto" | "sms", location?: { lat?: number; lng?: number; timezone?: string }): Promise<Checkin>;
  
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
  getConversations(userId: string): Promise<{ partnerId: string; partnerName: string; lastMessage: string; lastMessageAt: Date; unreadCount: number }[]>;

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

  // Report Preferences
  getReportPreferences(watcherId: string): Promise<ReportPreference[]>;
  getReportPreference(watcherId: string, watchedUserId: string): Promise<ReportPreference | undefined>;
  upsertReportPreference(data: { watcherId: string; watchedUserId: string; frequency: string; enabled: boolean; email?: string | null }): Promise<ReportPreference>;
  getDueReports(): Promise<ReportPreference[]>;
  updateReportLastSent(id: string): Promise<void>;

  // Drive Sessions
  createDriveSession(userId: string, lat?: number, lng?: number): Promise<DriveSession>;
  getActiveDriveSession(userId: string): Promise<DriveSession | undefined>;
  updateDriveSession(id: string, updates: Partial<{ endedAt: Date; maxSpeedKmh: number; avgSpeedKmh: number; distanceKm: number; crashDetected: boolean; endLat: number; endLng: number }>): Promise<DriveSession>;
  getDriveHistory(userId: string, limit?: number): Promise<DriveSession[]>;

  // Speed Alerts
  createSpeedAlert(userId: string, sessionId: string | null, speedKmh: number, speedLimitKmh: number, lat?: number, lng?: number): Promise<SpeedAlert>;
  getSpeedAlerts(userId: string, sessionId?: string): Promise<SpeedAlert[]>;

  // Error Reports
  createErrorReport(data: { userId?: string; type: string; message: string; stack?: string; url?: string; userAgent?: string; metadata?: string }): Promise<ErrorReport>;
  getErrorReports(limit?: number, resolved?: boolean, userId?: string): Promise<ErrorReport[]>;
  resolveErrorReport(id: string, userId?: string): Promise<boolean>;
  getErrorReportStats(userId?: string): Promise<{ total: number; unresolved: number; today: number }>;

  // App Ratings
  createAppRating(userId: string, rating: number, comment?: string, appVersion?: string): Promise<AppRating>;
  getUserRating(userId: string): Promise<AppRating | undefined>;
  getAppRatings(limit?: number): Promise<(AppRating & { userName?: string })[]>;
  getAppRatingStats(): Promise<{ average: number; total: number; distribution: Record<number, number> }>;

  // Live Location Sharing
  startLiveLocationShare(userId: string, expiresAt: Date | null): Promise<LiveLocationShare>;
  stopLiveLocationShare(userId: string): Promise<void>;
  getActiveLiveShare(userId: string): Promise<LiveLocationShare | undefined>;
  updateLiveLocation(shareId: string, userId: string, lat: number, lng: number, accuracy: number | null, speed: number | null, heading: number | null, activity: string): Promise<LiveLocationPoint>;
  getLiveLocationPoints(shareId: string, since?: Date, limit?: number): Promise<LiveLocationPoint[]>;
  getAllActiveLiveShares(): Promise<LiveLocationShare[]>;
  getActiveLiveSharesForWatcher(watcherUserId: string): Promise<(LiveLocationShare & { userName: string })[]>;

  // Report Data
  getCheckinHistory(userId: string, from: Date, to: Date): Promise<Checkin[]>;
  getIncidentHistory(userId: string, from: Date, to: Date): Promise<Incident[]>;
  getDailyStatus(watcherUserId: string, watchedUserId: string): Promise<DailyStatus>;
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
    return db.select().from(contacts).where(
      and(eq(contacts.userId, userId), isNull(contacts.softDeletedAt))
    ).orderBy(contacts.priority);
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

  async softDeleteContact(contactId: string, deletedBy: string): Promise<Contact> {
    await db.update(contactTokens)
      .set({ revoked: true })
      .where(eq(contactTokens.contactId, contactId));
    const [updated] = await db.update(contacts)
      .set({ softDeletedAt: new Date(), softDeletedBy: deletedBy })
      .where(eq(contacts.id, contactId))
      .returning();
    return updated;
  }

  async restoreContact(contactId: string): Promise<Contact> {
    const [updated] = await db.update(contacts)
      .set({ softDeletedAt: null, softDeletedBy: null })
      .where(eq(contacts.id, contactId))
      .returning();
    return updated;
  }

  async getSoftDeletedContacts(userId: string): Promise<Contact[]> {
    return db.select().from(contacts).where(
      and(eq(contacts.userId, userId), gt(contacts.softDeletedAt, new Date(0)))
    ).orderBy(desc(contacts.softDeletedAt));
  }

  async getSoftDeletedContactsByWatcher(watcherUserId: string): Promise<(Contact & { ownerName: string })[]> {
    const rows = await db.select().from(contacts).where(
      and(eq(contacts.linkedUserId, watcherUserId), gt(contacts.softDeletedAt, new Date(0)))
    ).orderBy(desc(contacts.softDeletedAt));
    const result: (Contact & { ownerName: string })[] = [];
    for (const row of rows) {
      const owner = await this.getUser(row.userId);
      result.push({ ...row, ownerName: owner?.name || "Unknown" });
    }
    return result;
  }

  async cleanupExpiredSoftDeletes(): Promise<number> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const expired = await db.select({ id: contacts.id }).from(contacts).where(
      and(gt(contacts.softDeletedAt, new Date(0)), lt(contacts.softDeletedAt, thirtyDaysAgo))
    );
    for (const row of expired) {
      await this.deleteContact(row.id);
    }
    return expired.length;
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
    if (contact.softDeletedAt) return undefined;

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

  async createCheckin(userId: string, method: "button" | "auto" | "sms" = "button", location?: { lat?: number; lng?: number; timezone?: string }): Promise<Checkin> {
    const [checkin] = await db.insert(checkins).values({
      userId,
      method,
      lat: location?.lat ?? null,
      lng: location?.lng ?? null,
      timezone: location?.timezone ?? null,
    }).returning();

    if (location?.timezone) {
      const user = await this.getUser(userId);
      if (user && user.timezone !== location.timezone) {
        await this.updateUser(userId, { timezone: location.timezone } as any);
      }
    }

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
      encrypted: false,
      iv: null,
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
    return result.reverse().map(m => {
      if (m.encrypted) {
        return { ...m, content: "This message is no longer available", encrypted: false, iv: null };
      }
      return m;
    });
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

  async getConversations(userId: string): Promise<{ partnerId: string; partnerName: string; lastMessage: string; lastMessageAt: Date; unreadCount: number }[]> {
    const allMessages = await db.select().from(messages).where(
      or(eq(messages.senderId, userId), eq(messages.receiverId, userId))
    ).orderBy(desc(messages.createdAt));

    const partnerMap = new Map<string, { lastMessage: string; lastMessageAt: Date; unreadCount: number }>();

    for (const msg of allMessages) {
      const partnerId = msg.senderId === userId ? msg.receiverId : msg.senderId;
      if (!partnerMap.has(partnerId)) {
        const preview = msg.encrypted ? "This message is no longer available" : msg.content;
        partnerMap.set(partnerId, {
          lastMessage: preview,
          lastMessageAt: msg.createdAt,
          unreadCount: 0,
        });
      }
      if (msg.receiverId === userId && !msg.read) {
        const entry = partnerMap.get(partnerId)!;
        entry.unreadCount++;
      }
    }

    const conversations: { partnerId: string; partnerName: string; lastMessage: string; lastMessageAt: Date; unreadCount: number }[] = [];
    for (const [partnerId, data] of Array.from(partnerMap)) {
      const partner = await this.getUser(partnerId);
      conversations.push({
        partnerId,
        partnerName: partner?.name || "Unknown",
        lastMessage: data.lastMessage,
        lastMessageAt: data.lastMessageAt,
        unreadCount: data.unreadCount,
      });
    }

    conversations.sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
    return conversations;
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
    const allContacts = await db.select().from(contacts).where(isNull(contacts.softDeletedAt));
    const normalized = phone.replace(/\s+/g, "");
    return allContacts.filter(c => {
      const cNorm = c.phone.replace(/\s+/g, "");
      if (cNorm === normalized) return true;
      if (normalized.startsWith("+61") && cNorm === "0" + normalized.slice(3)) return true;
      if (cNorm.startsWith("+61") && normalized === "0" + cNorm.slice(3)) return true;
      if (normalized.startsWith("+") && cNorm === normalized.slice(1)) return true;
      if (cNorm.startsWith("+") && normalized === cNorm.slice(1)) return true;
      return false;
    });
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
      and(eq(contacts.linkedUserId, watcherUserId), isNull(contacts.softDeletedAt))
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
    return db.select().from(contacts).where(
      and(eq(contacts.linkedUserId, linkedUserId), isNull(contacts.softDeletedAt))
    );
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

  async getReportPreferences(watcherId: string): Promise<ReportPreference[]> {
    return db.select().from(reportPreferences).where(eq(reportPreferences.watcherId, watcherId));
  }

  async getReportPreference(watcherId: string, watchedUserId: string): Promise<ReportPreference | undefined> {
    const [pref] = await db.select().from(reportPreferences)
      .where(and(eq(reportPreferences.watcherId, watcherId), eq(reportPreferences.watchedUserId, watchedUserId)));
    return pref || undefined;
  }

  async upsertReportPreference(data: { watcherId: string; watchedUserId: string; frequency: string; enabled: boolean; email?: string | null }): Promise<ReportPreference> {
    const existing = await this.getReportPreference(data.watcherId, data.watchedUserId);
    if (existing) {
      const [updated] = await db.update(reportPreferences)
        .set({ frequency: data.frequency as any, enabled: data.enabled, email: data.email || null })
        .where(eq(reportPreferences.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await db.insert(reportPreferences).values({
      watcherId: data.watcherId,
      watchedUserId: data.watchedUserId,
      frequency: data.frequency as any,
      enabled: data.enabled,
      email: data.email || null,
    }).returning();
    return created;
  }

  async getDueReports(): Promise<ReportPreference[]> {
    const allEnabled = await db.select().from(reportPreferences).where(eq(reportPreferences.enabled, true));
    const now = new Date();
    return allEnabled.filter(pref => {
      if (!pref.lastSentAt) return true;
      const elapsed = now.getTime() - pref.lastSentAt.getTime();
      const msPerDay = 86400000;
      switch (pref.frequency) {
        case "daily": return elapsed >= msPerDay;
        case "weekly": return elapsed >= 7 * msPerDay;
        case "fortnightly": return elapsed >= 14 * msPerDay;
        case "monthly": return elapsed >= 30 * msPerDay;
        default: return false;
      }
    });
  }

  async updateReportLastSent(id: string): Promise<void> {
    await db.update(reportPreferences).set({ lastSentAt: new Date() }).where(eq(reportPreferences.id, id));
  }

  async getCheckinHistory(userId: string, from: Date, to: Date): Promise<Checkin[]> {
    return db.select().from(checkins)
      .where(and(eq(checkins.userId, userId), gte(checkins.createdAt, from), lte(checkins.createdAt, to)))
      .orderBy(desc(checkins.createdAt));
  }

  async getIncidentHistory(userId: string, from: Date, to: Date): Promise<Incident[]> {
    return db.select().from(incidents)
      .where(and(eq(incidents.userId, userId), gte(incidents.startedAt, from), lte(incidents.startedAt, to)))
      .orderBy(desc(incidents.startedAt));
  }

  async getDailyStatus(watcherUserId: string, watchedUserId: string): Promise<DailyStatus> {
    const user = await this.getUser(watchedUserId);
    if (!user) throw new Error("User not found");

    const today = startOfDay(new Date());
    const todayCheckins = await db.select().from(checkins)
      .where(and(eq(checkins.userId, watchedUserId), gte(checkins.createdAt, today)))
      .orderBy(desc(checkins.createdAt));

    const lastCheckin = await this.getLastCheckin(watchedUserId);
    const openIncident = await this.getOpenIncident(watchedUserId);

    let heartRate: { bpm: number; recordedAt: string } | null = null;
    const latestHr = await this.getLatestHeartRate(watchedUserId);
    if (latestHr) {
      heartRate = { bpm: latestHr.bpm, recordedAt: latestHr.recordedAt.toISOString() };
    }

    return {
      userId: watchedUserId,
      userName: user.name,
      checkedInToday: todayCheckins.length > 0,
      todayCheckins: todayCheckins.map(c => ({
        time: format(c.createdAt, "h:mm a"),
        method: c.method,
      })),
      lastCheckinAt: lastCheckin?.createdAt?.toISOString() || null,
      hasOpenIncident: !!openIncident,
      incidentReason: openIncident?.reason || null,
      heartRate,
    };
  }
  async createDriveSession(userId: string, lat?: number, lng?: number): Promise<DriveSession> {
    const [session] = await db.insert(driveSessions).values({
      userId,
      startLat: lat ?? null,
      startLng: lng ?? null,
    }).returning();
    return session;
  }

  async getActiveDriveSession(userId: string): Promise<DriveSession | undefined> {
    const [session] = await db.select().from(driveSessions)
      .where(and(eq(driveSessions.userId, userId), isNull(driveSessions.endedAt)))
      .orderBy(desc(driveSessions.startedAt))
      .limit(1);
    return session || undefined;
  }

  async updateDriveSession(id: string, updates: Partial<{ endedAt: Date; maxSpeedKmh: number; avgSpeedKmh: number; distanceKm: number; crashDetected: boolean; endLat: number; endLng: number }>): Promise<DriveSession> {
    const [session] = await db.update(driveSessions).set(updates).where(eq(driveSessions.id, id)).returning();
    return session;
  }

  async getDriveHistory(userId: string, limit: number = 20): Promise<DriveSession[]> {
    return db.select().from(driveSessions)
      .where(eq(driveSessions.userId, userId))
      .orderBy(desc(driveSessions.startedAt))
      .limit(limit);
  }

  async createSpeedAlert(userId: string, sessionId: string | null, speedKmh: number, speedLimitKmh: number, lat?: number, lng?: number): Promise<SpeedAlert> {
    const [alert] = await db.insert(speedAlerts).values({
      userId,
      sessionId,
      speedKmh,
      speedLimitKmh,
      lat: lat ?? null,
      lng: lng ?? null,
    }).returning();
    return alert;
  }

  async getSpeedAlerts(userId: string, sessionId?: string): Promise<SpeedAlert[]> {
    const conditions = [eq(speedAlerts.userId, userId)];
    if (sessionId) conditions.push(eq(speedAlerts.sessionId, sessionId));
    return db.select().from(speedAlerts)
      .where(and(...conditions))
      .orderBy(desc(speedAlerts.createdAt))
      .limit(50);
  }
  async createErrorReport(data: { userId?: string; type: string; message: string; stack?: string; url?: string; userAgent?: string; metadata?: string }): Promise<ErrorReport> {
    const [report] = await db.insert(errorReports).values({
      userId: data.userId || null,
      type: data.type,
      message: data.message.slice(0, 2000),
      stack: data.stack?.slice(0, 10000) || null,
      url: data.url?.slice(0, 500) || null,
      userAgent: data.userAgent?.slice(0, 500) || null,
      metadata: data.metadata?.slice(0, 5000) || null,
    }).returning();
    return report;
  }

  async getErrorReports(limit: number = 50, resolved?: boolean, userId?: string): Promise<ErrorReport[]> {
    const conditions = [];
    if (resolved !== undefined) conditions.push(eq(errorReports.resolved, resolved));
    if (userId) conditions.push(eq(errorReports.userId, userId));
    return db.select().from(errorReports)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(errorReports.createdAt))
      .limit(limit);
  }

  async resolveErrorReport(id: string, userId?: string): Promise<boolean> {
    const conditions = [eq(errorReports.id, id)];
    if (userId) conditions.push(eq(errorReports.userId, userId));
    const result = await db.update(errorReports).set({ resolved: true }).where(and(...conditions)).returning();
    return result.length > 0;
  }

  async getErrorReportStats(userId?: string): Promise<{ total: number; unresolved: number; today: number }> {
    const conditions = userId ? [eq(errorReports.userId, userId)] : [];
    const all = await db.select().from(errorReports)
      .where(conditions.length > 0 ? and(...conditions) : undefined);
    const today = startOfDay(new Date());
    return {
      total: all.length,
      unresolved: all.filter(r => !r.resolved).length,
      today: all.filter(r => r.createdAt >= today).length,
    };
  }

  async createAppRating(userId: string, rating: number, comment?: string, appVersion?: string): Promise<AppRating> {
    const existing = await this.getUserRating(userId);
    if (existing) {
      const [updated] = await db.update(appRatings)
        .set({ rating, comment: comment || null, appVersion: appVersion || null })
        .where(eq(appRatings.id, existing.id))
        .returning();
      return updated;
    }
    const [newRating] = await db.insert(appRatings).values({
      userId,
      rating,
      comment: comment || null,
      appVersion: appVersion || null,
    }).returning();
    return newRating;
  }

  async getUserRating(userId: string): Promise<AppRating | undefined> {
    const [rating] = await db.select().from(appRatings)
      .where(eq(appRatings.userId, userId))
      .orderBy(desc(appRatings.createdAt))
      .limit(1);
    return rating || undefined;
  }

  async getAppRatings(limit: number = 50): Promise<(AppRating & { userName?: string })[]> {
    const results = await db.select({
      id: appRatings.id,
      userId: appRatings.userId,
      rating: appRatings.rating,
      comment: appRatings.comment,
      appVersion: appRatings.appVersion,
      createdAt: appRatings.createdAt,
      userName: users.name,
    })
      .from(appRatings)
      .leftJoin(users, eq(appRatings.userId, users.id))
      .orderBy(desc(appRatings.createdAt))
      .limit(limit);
    return results.map(r => ({
      id: r.id,
      userId: r.userId,
      rating: r.rating,
      comment: r.comment,
      appVersion: r.appVersion,
      createdAt: r.createdAt,
      userName: r.userName || undefined,
    }));
  }

  async getAppRatingStats(): Promise<{ average: number; total: number; distribution: Record<number, number> }> {
    const all = await db.select().from(appRatings);
    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sum = 0;
    for (const r of all) {
      sum += r.rating;
      distribution[r.rating] = (distribution[r.rating] || 0) + 1;
    }
    return {
      average: all.length > 0 ? sum / all.length : 0,
      total: all.length,
      distribution,
    };
  }
  async startLiveLocationShare(userId: string, expiresAt: Date | null): Promise<LiveLocationShare> {
    await db.update(liveLocationShares)
      .set({ active: false })
      .where(and(eq(liveLocationShares.userId, userId), eq(liveLocationShares.active, true)));

    const [share] = await db.insert(liveLocationShares).values({
      userId,
      active: true,
      expiresAt,
    }).returning();
    return share;
  }

  async stopLiveLocationShare(userId: string): Promise<void> {
    await db.update(liveLocationShares)
      .set({ active: false })
      .where(and(eq(liveLocationShares.userId, userId), eq(liveLocationShares.active, true)));
  }

  async getActiveLiveShare(userId: string): Promise<LiveLocationShare | undefined> {
    const [share] = await db.select().from(liveLocationShares)
      .where(and(eq(liveLocationShares.userId, userId), eq(liveLocationShares.active, true)))
      .limit(1);
    return share;
  }

  async updateLiveLocation(
    shareId: string, userId: string, lat: number, lng: number,
    accuracy: number | null, speed: number | null, heading: number | null, activity: string
  ): Promise<LiveLocationPoint> {
    const now = new Date();
    await db.update(liveLocationShares).set({
      lastLat: lat,
      lastLng: lng,
      lastAccuracy: accuracy,
      lastSpeed: speed,
      lastHeading: heading,
      lastActivity: activity as any,
      lastUpdatedAt: now,
    }).where(eq(liveLocationShares.id, shareId));

    const [point] = await db.insert(liveLocationPoints).values({
      shareId,
      userId,
      lat, lng, accuracy, speed, heading,
      activity: activity as any,
    }).returning();
    return point;
  }

  async getLiveLocationPoints(shareId: string, since?: Date, limit: number = 200): Promise<LiveLocationPoint[]> {
    const conditions = [eq(liveLocationPoints.shareId, shareId)];
    if (since) conditions.push(gt(liveLocationPoints.recordedAt, since));

    return db.select().from(liveLocationPoints)
      .where(and(...conditions))
      .orderBy(desc(liveLocationPoints.recordedAt))
      .limit(limit);
  }

  async getAllActiveLiveShares(): Promise<LiveLocationShare[]> {
    return db.select().from(liveLocationShares).where(eq(liveLocationShares.active, true));
  }

  async getActiveLiveSharesForWatcher(watcherUserId: string): Promise<(LiveLocationShare & { userName: string })[]> {
    const watcherContacts = await db.select().from(contacts)
      .where(and(
        eq(contacts.linkedUserId, watcherUserId),
        isNull(contacts.softDeletedAt)
      ));

    const results: (LiveLocationShare & { userName: string })[] = [];
    for (const contact of watcherContacts) {
      const [share] = await db.select().from(liveLocationShares)
        .where(and(eq(liveLocationShares.userId, contact.userId), eq(liveLocationShares.active, true)))
        .limit(1);
      if (share) {
        const user = await this.getUser(contact.userId);
        if (user) {
          results.push({ ...share, userName: user.name });
        }
      }
    }
    return results;
  }
}

export const storage = new DatabaseStorage();
