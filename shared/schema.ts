import { pgTable, uuid, text, timestamp, integer, boolean, real, pgEnum } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Enums
export const locationModeEnum = pgEnum("location_mode", ["off", "emergency_only", "on_shift_only"]);
export const incidentStatusEnum = pgEnum("incident_status", ["open", "paused", "resolved"]);
export const incidentReasonEnum = pgEnum("incident_reason", ["missed_checkin", "sos", "test"]);
export const locationSessionTypeEnum = pgEnum("location_session_type", ["emergency", "shift"]);
export const checkinMethodEnum = pgEnum("checkin_method", ["button"]);

// Users table
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  phone: text("phone"),
  timezone: text("timezone").notNull().default("Australia/Melbourne"),
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
  priority: integer("priority").notNull(),
  canViewLocation: boolean("can_view_location").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

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
});

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

// Insert Schemas
export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true });
export const insertSettingsSchema = createInsertSchema(settings).omit({ userId: true, updatedAt: true });
export const insertContactSchema = createInsertSchema(contacts).omit({ id: true, userId: true, createdAt: true });
export const insertCheckinSchema = createInsertSchema(checkins).omit({ id: true, createdAt: true });
export const insertIncidentSchema = createInsertSchema(incidents).omit({ id: true, startedAt: true });
export const insertLocationSessionSchema = createInsertSchema(locationSessions).omit({ id: true, updatedAt: true });
export const insertOtpCodeSchema = createInsertSchema(otpCodes).omit({ id: true, createdAt: true });
export const insertAuthSessionSchema = createInsertSchema(authSessions).omit({ id: true, createdAt: true });

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

export type AuthSession = typeof authSessions.$inferSelect;
export type OtpCode = typeof otpCodes.$inferSelect;

// API Response Types
export interface UserStatus {
  user: User;
  settings: Settings;
  contacts: Contact[];
  lastCheckin: Checkin | null;
  nextCheckinDue: Date;
  openIncident: Incident | null;
  activeLocationSession: LocationSession | null;
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
