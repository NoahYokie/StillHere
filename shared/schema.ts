import { pgTable, uuid, text, timestamp, integer, boolean, real, pgEnum, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Enums
export const locationModeEnum = pgEnum("location_mode", ["off", "emergency_only", "on_shift_only", "both"]);
export const reminderModeEnum = pgEnum("reminder_mode", ["none", "one", "two"]);
export const incidentStatusEnum = pgEnum("incident_status", ["open", "paused", "resolved"]);
export const incidentReasonEnum = pgEnum("incident_reason", ["missed_checkin", "sos", "test"]);
export const locationSessionTypeEnum = pgEnum("location_session_type", ["emergency", "shift"]);
export const checkinMethodEnum = pgEnum("checkin_method", ["button", "auto", "sms"]);
export const callStatusEnum = pgEnum("call_status", ["ringing", "active", "ended", "missed"]);
export const callTypeEnum = pgEnum("call_type", ["video", "audio"]);
export const reportFrequencyEnum = pgEnum("report_frequency", ["daily", "weekly", "fortnightly", "monthly"]);

// Users table
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  phone: text("phone"),
  timezone: text("timezone").notNull().default("Australia/Melbourne"),
  isPremium: boolean("is_premium").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const usersRelations = relations(users, ({ one, many }) => ({
  settings: one(settings),
  contacts: many(contacts),
  checkins: many(checkins),
  incidents: many(incidents),
  locationSessions: many(locationSessions),
}));

// Settings table (1:1 with users)
export const settings = pgTable("settings", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  checkinIntervalHours: integer("checkin_interval_hours").notNull().default(24),
  preferredCheckinTime: text("preferred_checkin_time").notNull().default("09:00"),
  graceMinutes: integer("grace_minutes").notNull().default(15),
  locationMode: locationModeEnum("location_mode").notNull().default("off"),
  reminderMode: reminderModeEnum("reminder_mode").notNull().default("one"),
  autoCheckin: boolean("auto_checkin").notNull().default(false),
  fallDetection: boolean("fall_detection").notNull().default(false),
  discreetSos: boolean("discreet_sos").notNull().default(false),
  escalationMinutes: integer("escalation_minutes").notNull().default(20),
  smsCheckinEnabled: boolean("sms_checkin_enabled").notNull().default(false),
  allowReports: boolean("allow_reports").notNull().default(true),
  remindersSent: integer("reminders_sent").notNull().default(0),
  lastReminderAt: timestamp("last_reminder_at"),
  pauseUntil: timestamp("pause_until"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const settingsRelations = relations(settings, ({ one }) => ({
  user: one(users, {
    fields: [settings.userId],
    references: [users.id],
  }),
}));

// Contacts table
export const contacts = pgTable("contacts", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  email: text("email"),
  priority: integer("priority").notNull(),
  canViewLocation: boolean("can_view_location").notNull().default(true),
  linkedUserId: uuid("linked_user_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("contacts_user_id_idx").on(table.userId),
  index("contacts_linked_user_id_idx").on(table.linkedUserId),
  index("contacts_phone_idx").on(table.phone),
]);

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  user: one(users, {
    fields: [contacts.userId],
    references: [users.id],
  }),
  tokens: many(contactTokens),
}));

// Contact Tokens table
export const contactTokens = pgTable("contact_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  revoked: boolean("revoked").notNull().default(false),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const contactTokensRelations = relations(contactTokens, ({ one }) => ({
  contact: one(contacts, {
    fields: [contactTokens.contactId],
    references: [contacts.id],
  }),
}));

// Checkins table
export const checkins = pgTable("checkins", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  method: checkinMethodEnum("method").notNull().default("button"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const checkinsRelations = relations(checkins, ({ one }) => ({
  user: one(users, {
    fields: [checkins.userId],
    references: [users.id],
  }),
}));

// Incidents table
export const incidents = pgTable("incidents", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: incidentStatusEnum("status").notNull().default("open"),
  reason: incidentReasonEnum("reason").notNull(),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at"),
  handledByContactId: uuid("handled_by_contact_id").references(() => contacts.id),
  nextActionAt: timestamp("next_action_at"),
  escalationLevel: integer("escalation_level").notNull().default(0),
  notifiedContactIds: text("notified_contact_ids").notNull().default("[]"),
  lastContactNotifiedAt: timestamp("last_contact_notified_at"),
  allContactsNotifiedAt: timestamp("all_contacts_notified_at"),
  userNotifiedNoResponseAt: timestamp("user_notified_no_response_at"),
  contact1NotifiedAt: timestamp("contact1_notified_at"),
  contact2NotifiedAt: timestamp("contact2_notified_at"),
}, (table) => [
  index("incidents_user_id_idx").on(table.userId),
  index("incidents_status_idx").on(table.status),
  index("incidents_status_next_action_idx").on(table.status, table.nextActionAt),
]);

export const incidentsRelations = relations(incidents, ({ one, many }) => ({
  user: one(users, {
    fields: [incidents.userId],
    references: [users.id],
  }),
  handledByContact: one(contacts, {
    fields: [incidents.handledByContactId],
    references: [contacts.id],
  }),
  locationSessions: many(locationSessions),
}));

// Auth Sessions table
export const authSessions = pgTable("auth_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const authSessionsRelations = relations(authSessions, ({ one }) => ({
  user: one(users, {
    fields: [authSessions.userId],
    references: [users.id],
  }),
}));

// OTP Codes table
export const otpCodes = pgTable("otp_codes", {
  id: uuid("id").defaultRandom().primaryKey(),
  phone: text("phone").notNull(),
  code: text("code").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// OTP Rate Limit table
export const otpRateLimits = pgTable("otp_rate_limits", {
  id: uuid("id").defaultRandom().primaryKey(),
  phone: text("phone").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Push Subscriptions table
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const pushSubscriptionsRelations = relations(pushSubscriptions, ({ one }) => ({
  user: one(users, {
    fields: [pushSubscriptions.userId],
    references: [users.id],
  }),
}));

// Location Sessions table
export const locationSessions = pgTable("location_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  incidentId: uuid("incident_id").references(() => incidents.id),
  type: locationSessionTypeEnum("type").notNull(),
  active: boolean("active").notNull().default(true),
  expiresAt: timestamp("expires_at").notNull(),
  lastLat: real("last_lat"),
  lastLng: real("last_lng"),
  lastAccuracy: real("last_accuracy"),
  lastTimestamp: timestamp("last_timestamp"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const locationSessionsRelations = relations(locationSessions, ({ one }) => ({
  user: one(users, {
    fields: [locationSessions.userId],
    references: [users.id],
  }),
  incident: one(incidents, {
    fields: [locationSessions.incidentId],
    references: [incidents.id],
  }),
}));

// Messages table
export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  senderId: uuid("sender_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  receiverId: uuid("receiver_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  read: boolean("read").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("messages_sender_receiver_idx").on(table.senderId, table.receiverId),
  index("messages_receiver_read_idx").on(table.receiverId, table.read),
]);

export const messagesRelations = relations(messages, ({ one }) => ({
  sender: one(users, {
    fields: [messages.senderId],
    references: [users.id],
    relationName: "sentMessages",
  }),
  receiver: one(users, {
    fields: [messages.receiverId],
    references: [users.id],
    relationName: "receivedMessages",
  }),
}));

// Calls table
export const calls = pgTable("calls", {
  id: uuid("id").defaultRandom().primaryKey(),
  callerId: uuid("caller_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  receiverId: uuid("receiver_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: callStatusEnum("status").notNull().default("ringing"),
  callType: callTypeEnum("call_type").notNull().default("video"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  answeredAt: timestamp("answered_at"),
  endedAt: timestamp("ended_at"),
});

export const callsRelations = relations(calls, ({ one }) => ({
  caller: one(users, {
    fields: [calls.callerId],
    references: [users.id],
    relationName: "outgoingCalls",
  }),
  receiver: one(users, {
    fields: [calls.receiverId],
    references: [users.id],
    relationName: "incomingCalls",
  }),
}));

// VoIP Push Tokens table (for iOS CallKit / Android ConnectionService)
export const voipTokens = pgTable("voip_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  platform: text("platform").notNull(), // 'ios' or 'android'
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const voipTokensRelations = relations(voipTokens, ({ one }) => ({
  user: one(users, {
    fields: [voipTokens.userId],
    references: [users.id],
  }),
}));

// Passkeys table (WebAuthn/FIDO2 credentials)
export const passkeys = pgTable("passkeys", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  credentialId: text("credential_id").notNull().unique(),
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull().default(0),
  transports: text("transports"),
  deviceType: text("device_type"),
  backedUp: boolean("backed_up").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const passkeysRelations = relations(passkeys, ({ one }) => ({
  user: one(users, {
    fields: [passkeys.userId],
    references: [users.id],
  }),
}));

// Heart Rate Readings table
export const heartRateReadings = pgTable("heart_rate_readings", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  bpm: integer("bpm").notNull(),
  source: text("source").notNull().default("watch"),
  recordedAt: timestamp("recorded_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("heart_rate_user_id_idx").on(table.userId),
  index("heart_rate_recorded_at_idx").on(table.userId, table.recordedAt),
]);

export const heartRateReadingsRelations = relations(heartRateReadings, ({ one }) => ({
  user: one(users, {
    fields: [heartRateReadings.userId],
    references: [users.id],
  }),
}));

// Heart Rate Alerts table
export const heartRateAlerts = pgTable("heart_rate_alerts", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  alertType: text("alert_type").notNull(),
  bpm: integer("bpm").notNull(),
  resolved: boolean("resolved").notNull().default(false),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("heart_rate_alerts_user_id_idx").on(table.userId),
]);

export const heartRateAlertsRelations = relations(heartRateAlerts, ({ one }) => ({
  user: one(users, {
    fields: [heartRateAlerts.userId],
    references: [users.id],
  }),
}));

// Geofences table
export const geofenceTypeEnum = pgEnum("geofence_type", ["home", "work", "custom"]);

export const geofences = pgTable("geofences", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  lat: real("lat").notNull(),
  lng: real("lng").notNull(),
  radiusMeters: integer("radius_meters").notNull().default(200),
  type: geofenceTypeEnum("type").notNull().default("home"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("geofences_user_id_idx").on(table.userId),
]);

export const geofencesRelations = relations(geofences, ({ one }) => ({
  user: one(users, {
    fields: [geofences.userId],
    references: [users.id],
  }),
}));

// Location Breadcrumbs table
export const locationBreadcrumbs = pgTable("location_breadcrumbs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").references(() => locationSessions.id),
  lat: real("lat").notNull(),
  lng: real("lng").notNull(),
  accuracy: real("accuracy"),
  recordedAt: timestamp("recorded_at").defaultNow().notNull(),
}, (table) => [
  index("breadcrumbs_user_session_idx").on(table.userId, table.sessionId),
  index("breadcrumbs_recorded_at_idx").on(table.userId, table.recordedAt),
]);

export const locationBreadcrumbsRelations = relations(locationBreadcrumbs, ({ one }) => ({
  user: one(users, {
    fields: [locationBreadcrumbs.userId],
    references: [users.id],
  }),
  session: one(locationSessions, {
    fields: [locationBreadcrumbs.sessionId],
    references: [locationSessions.id],
  }),
}));

// Satellite Devices table
export const satelliteDevices = pgTable("satellite_devices", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  deviceType: text("device_type").notNull(),
  deviceId: text("device_id").notNull(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  lastSeenAt: timestamp("last_seen_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("satellite_devices_user_id_idx").on(table.userId),
  index("satellite_devices_device_id_idx").on(table.deviceId),
]);

export const satelliteDevicesRelations = relations(satelliteDevices, ({ one }) => ({
  user: one(users, {
    fields: [satelliteDevices.userId],
    references: [users.id],
  }),
}));

// Report Preferences table (watcher configures per watched user)
export const reportPreferences = pgTable("report_preferences", {
  id: uuid("id").defaultRandom().primaryKey(),
  watcherId: uuid("watcher_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  watchedUserId: uuid("watched_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  frequency: reportFrequencyEnum("frequency").notNull().default("weekly"),
  enabled: boolean("enabled").notNull().default(true),
  email: text("email"),
  lastSentAt: timestamp("last_sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("report_preferences_watcher_idx").on(table.watcherId),
  index("report_preferences_watched_idx").on(table.watchedUserId),
]);

export const reportPreferencesRelations = relations(reportPreferences, ({ one }) => ({
  watcher: one(users, {
    fields: [reportPreferences.watcherId],
    references: [users.id],
  }),
}));

// Insert Schemas
export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true });
export const insertSettingsSchema = createInsertSchema(settings).omit({ userId: true, updatedAt: true });
export const insertContactSchema = createInsertSchema(contacts).omit({ id: true, userId: true, createdAt: true });
export const insertCheckinSchema = createInsertSchema(checkins).omit({ id: true, createdAt: true });
export const insertIncidentSchema = createInsertSchema(incidents).omit({ id: true, startedAt: true });
export const insertLocationSessionSchema = createInsertSchema(locationSessions).omit({ id: true, updatedAt: true });
export const insertOtpCodeSchema = createInsertSchema(otpCodes).omit({ id: true, createdAt: true });
export const insertAuthSessionSchema = createInsertSchema(authSessions).omit({ id: true, createdAt: true });
export const insertPushSubscriptionSchema = createInsertSchema(pushSubscriptions).omit({ id: true, createdAt: true });
export const insertMessageSchema = createInsertSchema(messages).omit({ id: true, createdAt: true });
export const insertCallSchema = createInsertSchema(calls).omit({ id: true, startedAt: true });
export const insertVoipTokenSchema = createInsertSchema(voipTokens).omit({ id: true, createdAt: true });
export const insertPasskeySchema = createInsertSchema(passkeys).omit({ id: true, createdAt: true });
export const insertHeartRateReadingSchema = createInsertSchema(heartRateReadings).omit({ id: true, createdAt: true });
export const insertHeartRateAlertSchema = createInsertSchema(heartRateAlerts).omit({ id: true, createdAt: true });
export const insertGeofenceSchema = createInsertSchema(geofences).omit({ id: true, createdAt: true });
export const insertLocationBreadcrumbSchema = createInsertSchema(locationBreadcrumbs).omit({ id: true });
export const insertSatelliteDeviceSchema = createInsertSchema(satelliteDevices).omit({ id: true, createdAt: true });
export const insertReportPreferenceSchema = createInsertSchema(reportPreferences).omit({ id: true, createdAt: true });

// Types
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

export type Settings = typeof settings.$inferSelect;
export type InsertSettings = z.infer<typeof insertSettingsSchema>;

export type Contact = typeof contacts.$inferSelect;
export type InsertContact = z.infer<typeof insertContactSchema>;

export type ContactToken = typeof contactTokens.$inferSelect;

export type Checkin = typeof checkins.$inferSelect;

export type Incident = typeof incidents.$inferSelect;
export type IncidentStatus = Incident["status"];
export type IncidentReason = Incident["reason"];

export type LocationSession = typeof locationSessions.$inferSelect;
export type LocationSessionType = LocationSession["type"];
export type LocationMode = Settings["locationMode"];
export type ReminderMode = Settings["reminderMode"];

export type AuthSession = typeof authSessions.$inferSelect;
export type OtpCode = typeof otpCodes.$inferSelect;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type InsertPushSubscription = z.infer<typeof insertPushSubscriptionSchema>;

export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;

export type VoipToken = typeof voipTokens.$inferSelect;
export type InsertVoipToken = z.infer<typeof insertVoipTokenSchema>;

export type Call = typeof calls.$inferSelect;
export type InsertCall = z.infer<typeof insertCallSchema>;
export type CallStatus = Call["status"];
export type CallType = Call["callType"];

export type Passkey = typeof passkeys.$inferSelect;
export type InsertPasskey = z.infer<typeof insertPasskeySchema>;

export type HeartRateReading = typeof heartRateReadings.$inferSelect;
export type InsertHeartRateReading = z.infer<typeof insertHeartRateReadingSchema>;

export type HeartRateAlert = typeof heartRateAlerts.$inferSelect;
export type InsertHeartRateAlert = z.infer<typeof insertHeartRateAlertSchema>;

export type Geofence = typeof geofences.$inferSelect;
export type InsertGeofence = z.infer<typeof insertGeofenceSchema>;

export type LocationBreadcrumb = typeof locationBreadcrumbs.$inferSelect;
export type InsertLocationBreadcrumb = z.infer<typeof insertLocationBreadcrumbSchema>;

export type SatelliteDevice = typeof satelliteDevices.$inferSelect;
export type InsertSatelliteDevice = z.infer<typeof insertSatelliteDeviceSchema>;

export type ReportPreference = typeof reportPreferences.$inferSelect;
export type InsertReportPreference = z.infer<typeof insertReportPreferenceSchema>;

export interface ReportData {
  userName: string;
  periodStart: string;
  periodEnd: string;
  checkins: { date: string; time: string; method: string }[];
  totalCheckins: number;
  missedCheckins: number;
  complianceRate: number;
  incidents: { date: string; reason: string; resolved: boolean; duration: string | null }[];
  heartRateSummary: { avgBpm: number; minBpm: number; maxBpm: number; alerts: number } | null;
  locationEnabled: boolean;
  fallDetectionEnabled: boolean;
  fallAlerts: number;
}

export interface DailyStatus {
  userId: string;
  userName: string;
  checkedInToday: boolean;
  todayCheckins: { time: string; method: string }[];
  lastCheckinAt: string | null;
  hasOpenIncident: boolean;
  incidentReason: string | null;
  heartRate: { bpm: number; recordedAt: string } | null;
}

// API Response Types
export interface UserStatus {
  user: User;
  settings: Settings;
  contacts: Contact[];
  lastCheckin: Checkin | null;
  nextCheckinDue: Date;
  openIncident: Incident | null;
  activeLocationSession: LocationSession | null;
  contactLimit: number;
  isPremium: boolean;
}

export interface WatchedUser {
  userId: string;
  userName: string;
  lastCheckinAt: Date | null;
  nextCheckinDue: Date;
  hasOpenIncident: boolean;
  incidentReason: string | null;
  contactId: string;
}

export interface ContactPageData {
  user: {
    id: string;
    name: string;
    phone: string | null;
  };
  contact: Contact;
  lastCheckin: Checkin | null;
  incident: Incident | null;
  locationSession: LocationSession | null;
  handlingContact: Contact | null;
}
