import { pgTable, uuid, text, timestamp, integer, boolean, real, doublePrecision, pgEnum, index } from "drizzle-orm/pg-core";
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
export const safetyStateEnum = pgEnum("safety_state", ["active", "quiet", "concern"]);
export const sharingModeEnum = pgEnum("sharing_mode", ["precise", "area", "presence", "paused"]);
export const circleRoleEnum = pgEnum("circle_role", ["primary", "backup", "support"]);
export const messageTypeEnum = pgEnum("message_type", ["user", "system_alert", "system_safe", "system_info"]);
export const familyRoleEnum = pgEnum("family_role", ["admin", "adult", "teen", "child"]);
export const familyMemberStatusEnum = pgEnum("family_member_status", [
  "active",
  "invited",
  "paused",
  "removed",
  // Consent fix: explicit accept required before family data is exposed.
  "pending",
  // One-time backfill marker for rows that existed before the explicit-accept
  // requirement. Treated as `active` until `legacyConfirmDeadline`, then the
  // helper layer treats them as `pending` until the user re-confirms.
  "active_legacy",
  // Terminal: invitee declined. New invites create new rows after a 24h
  // anti-harassment cooldown.
  "declined",
]);
// Outbound communication audit channels. `in_app` covers system_alert / system_safe
// messages that are delivered through the chat / socket layer (no carrier cost,
// but still spam-eligible if a buggy loop fires).
export const outboundChannelEnum = pgEnum("outbound_channel", ["sms", "email", "push", "voice", "in_app"]);
// Why we sent a message. Drives per-purpose limits + dedupe scoping.
// Category A (strict per-user/IP/destination limits): otp, family_invite, contact_test,
//   safety_drill, test_broadcast, marketing.
// Category B (incident-driven, dedupe-only): sos_alert, missed_checkin_alert,
//   wellness_call, escalation_alert, all_clear, contact_responded, no_response,
//   handling_timeout, drive_crash, geofence, reminder, presence, system_alert.
export const outboundPurposeEnum = pgEnum("outbound_purpose", [
  "otp",
  "family_invite",
  "contact_test",
  "safety_drill",
  "test_broadcast",
  "marketing",
  "sos_alert",
  "missed_checkin_alert",
  "wellness_call",
  "escalation_alert",
  "all_clear",
  "contact_responded",
  "no_response",
  "handling_timeout",
  "drive_crash",
  "geofence",
  "reminder",
  "presence",
  "system_alert",
  "drill_acknowledgement",
  "concern",
  "recovery",
]);
// Lifecycle of a single outbound attempt. `queued` = policy passed, send in flight.
// `sent` = provider accepted (Twilio messageId returned, push accepted, etc).
// `delivered` = provider callback confirmed delivery. `failed` = provider error.
// `blocked_policy` = enforceSendPolicy refused (limit or duplicate).
// `blocked_optout` = recipient opted out (carrier STOP or in-app flag).
// `provider_unconfigured` = transport not wired (Twilio/VAPID/Resend missing).
export const outboundStatusEnum = pgEnum("outbound_status", [
  "queued",
  "sent",
  "delivered",
  "failed",
  "blocked_policy",
  "blocked_optout",
  "provider_unconfigured",
  // Phase 1.1: dedupe-loop suppression. Distinct from `blocked_policy` so the
  // ops dashboard can separate "abuse limit hit" from "worker loop collapsed".
  // Used for both Cat-B 5-min dedupe AND safety-critical worker-loop dedupe.
  "deduped",
]);

// Users table
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  phone: text("phone").unique(),
  timezone: text("timezone").notNull().default("Australia/Melbourne"),
  isPremium: boolean("is_premium").notNull().default(false),
  publicKey: text("public_key"),
  lastHeartbeatAt: timestamp("last_heartbeat_at"),
  lastHeartbeatLat: doublePrecision("last_heartbeat_lat"),
  lastHeartbeatLng: doublePrecision("last_heartbeat_lng"),
  lastHeartbeatAcc: doublePrecision("last_heartbeat_acc"),
  batteryLevel: real("battery_level"),
  batteryCharging: boolean("battery_charging"),
  networkType: text("network_type"),
  lastDeviceStatusAt: timestamp("last_device_status_at"),
  safetyState: safetyStateEnum("safety_state").notNull().default("active"),
  safetyStateReason: text("safety_state_reason").notNull().default("No heartbeat yet"),
  safetyStateChangedAt: timestamp("safety_state_changed_at").defaultNow().notNull(),
  learningModeUntil: timestamp("learning_mode_until"),
  sleepStart: text("sleep_start").notNull().default("22:30"),
  sleepEnd: text("sleep_end").notNull().default("07:00"),
  sharingMode: sharingModeEnum("sharing_mode").notNull().default("precise"),
  setupConfirmedAt: timestamp("setup_confirmed_at"),
  // Billing / subscription state. `premiumUntil` is the unified entitlement
  // expiry across Stripe (web) and RevenueCat (iOS/Android). `premiumSource`
  // records which store granted it so we can route portal links correctly.
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  premiumUntil: timestamp("premium_until"),
  premiumSource: text("premium_source"),
  // Privacy: how long historical location data is retained for this user
  // before the daily cron deletes it. Default 30 days. UI exposes 7/30/90.
  // Active live tracking sessions are NEVER deleted regardless of this value.
  locationDataRetentionDays: integer("location_data_retention_days").notNull().default(30),
  // SMS opt-out (in-app tracking, in addition to Twilio carrier-level STOP).
  // Set true when the user replies STOP/CANCEL/etc to our messaging service;
  // cleared when they reply START/UNSTOP. Sends are short-circuited when true.
  smsOptedOut: boolean("sms_opted_out").notNull().default(false),
  smsOptedOutAt: timestamp("sms_opted_out_at"),
  // Review-account flag. Set on the dedicated Apple/Play review user that
  // logs in via the env-gated review login (NOT the normal OTP flow). When
  // true: outbound SMS/push and emergency-contact escalation are suppressed
  // so the reviewer can exercise every screen without paging real people.
  // Real users always have this false.
  isReviewAccount: boolean("is_review_account").notNull().default(false),
  // Last known location snapshot (mirrored from live-location updates and
  // SOS payloads). Used by emergency emails and watcher previews when no
  // active live share exists.
  lastLat: doublePrecision("last_lat"),
  lastLng: doublePrecision("last_lng"),
  lastLocationAt: timestamp("last_location_at"),
  // Set when the user has read and acknowledged the Limitations of Service
  // screen ("What StillHere is, and what it isn't"). Null until they tap
  // Continue. Used as a calm-time gate before main app use; never blocks
  // urgent safety flows (SOS, active incident, Safe Walk, Safety Timer,
  // Drive Safety, etc).
  acknowledgedLimitationsAt: timestamp("acknowledged_limitations_at"),
  // Heart-rate opt-in (Apple Privacy Nutrition Label compliance).
  // Both default false. When `heartRateMonitoringEnabled` is false the Watch
  // does not request HealthKit, the server `/api/heartrate` ingest is a no-op,
  // and the weekly safety report omits any heart-rate section. When that flag
  // is true but `heartRateAlertsEnabled` is false, readings are persisted but
  // no `heart_rate_alerts` rows are ever created (so contacts are not paged
  // for high/low BPM crossings). Both must be true for an alert to fire.
  // 120 BPM / 40 BPM are StillHere alert thresholds, NOT medical thresholds.
  heartRateMonitoringEnabled: boolean("heart_rate_monitoring_enabled").notNull().default(false),
  heartRateAlertsEnabled: boolean("heart_rate_alerts_enabled").notNull().default(false),
  // COPPA / age gate (Batch 3). Set when a NEW user confirms "I am 13 or
  // older" during signup. Nullable so existing rows (created before the
  // gate) are not broken; we do not retroactively prompt existing users in
  // this batch. Server refuses to insert a new user row without this set
  // (see verifyOtp). No date of birth is collected. Under-13 users are not
  // supported in v1; no parental consent flow exists.
  ageGateAcceptedAt: timestamp("age_gate_accepted_at"),
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
  smsCheckinEnabled: boolean("sms_checkin_enabled").notNull().default(true),
  drivingSafety: boolean("driving_safety").notNull().default(false),
  speedLimitKmh: integer("speed_limit_kmh").notNull().default(120),
  autoWellnessCall: boolean("auto_wellness_call").notNull().default(false),
  allowReports: boolean("allow_reports").notNull().default(true),
  remindersSent: integer("reminders_sent").notNull().default(0),
  lastReminderAt: timestamp("last_reminder_at"),
  reminderTimeline: text("reminder_timeline").notNull().default("[]"),
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
  circleRole: circleRoleEnum("circle_role").notNull().default("primary"),
  linkedUserId: uuid("linked_user_id").references(() => users.id),
  watcherConsentStatus: text("watcher_consent_status").notNull().default("pending"),
  watcherConsentRequestedAt: timestamp("watcher_consent_requested_at").defaultNow(),
  watcherConsentAcceptedAt: timestamp("watcher_consent_accepted_at"),
  watcherConsentDeclinedAt: timestamp("watcher_consent_declined_at"),
  softDeletedAt: timestamp("soft_deleted_at"),
  softDeletedBy: text("soft_deleted_by"),
  // SMS opt-out for this contact (replies STOP/CANCEL/etc to our service).
  // sendSms() short-circuits sends to opted-out numbers; escalation continues
  // via push, voice call, and email.
  smsOptedOut: boolean("sms_opted_out").notNull().default(false),
  smsOptedOutAt: timestamp("sms_opted_out_at"),
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
// Purpose:
//   'standing'  - default watcher link, refreshed lazily, max 24h lifetime
//   'incident'  - link to live incident view, expires when incident resolves + small grace
//   'allclear'  - read-only "they're safe" link sent in resolution SMS, 4h lifetime, no location data
export const contactTokens = pgTable("contact_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  revoked: boolean("revoked").notNull().default(false),
  purpose: text("purpose").notNull().default("standing"),
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
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  timezone: text("timezone"),
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
  escalationTimeline: text("escalation_timeline").notNull().default("[]"),
  pushSentAt: timestamp("push_sent_at"),
  smsSentAt: timestamp("sms_sent_at"),
  callSentAt: timestamp("call_sent_at"),
  lastEscalationStep: text("last_escalation_step"),
  claimedByContactId: uuid("claimed_by_contact_id").references(() => contacts.id),
  claimedAt: timestamp("claimed_at"),
  isDrill: boolean("is_drill").notNull().default(false),
  drillAcknowledgedAt: timestamp("drill_acknowledged_at"),
  drillAcknowledgedByContactId: uuid("drill_acknowledged_by_contact_id").references(() => contacts.id),
  drillResponses: text("drill_responses").notNull().default("[]"),
  wellnessCallStatus: text("wellness_call_status"),
  // Set true when the notification engine could not deliver via the
  // primary intended channel (SMS or voice) due to a circuit-breaker /
  // policy block / provider error and had to fall back to push, in-app,
  // or email. The watcher UI can surface a soft warning ("Some delivery
  // channels may be delayed"). Never used to alarm  -  it just means we
  // routed around a degraded transport. See server/outbound-policy.ts.
  degradedDelivery: boolean("degraded_delivery").notNull().default(false),
  // Set true ONLY when every channel we attempted for this incident
  // ultimately failed (no SMS, no push, no in-app, no email). Used by
  // the resolution UI to flag "we could not reach anyone". Distinct from
  // degradedDelivery (which means we found a working fallback).
  deliveryFailed: boolean("delivery_failed").notNull().default(false),
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
  lastLat: doublePrecision("last_lat"),
  lastLng: doublePrecision("last_lng"),
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

// SMS delivery telemetry. Twilio calls /api/sms/status as a message moves
// through queued -> sent -> delivered (or failed/undelivered). We store the
// last status per messageSid so the system can react to undelivered alerts
// during an active incident, and so operators have an audit trail.
// PII minimization: we store only the last 4 digits of the recipient number.
export const smsDeliveryLogs = pgTable("sms_delivery_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  messageSid: text("message_sid").notNull().unique(),
  toLast4: text("to_last4").notNull(),
  status: text("status").notNull(),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("sms_delivery_logs_status_idx").on(table.status),
]);
export type SmsDeliveryLog = typeof smsDeliveryLogs.$inferSelect;

// Messages table
// Conversations exist only between a user and members of their Safety Circle
// (watchers / emergency contacts). Authorization is enforced at the route layer.
export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  senderId: uuid("sender_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  receiverId: uuid("receiver_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  read: boolean("read").notNull().default(false),
  encrypted: boolean("encrypted").notNull().default(false),
  iv: text("iv"),
  // Message kind: regular user chat, or a system-generated safety event
  // (alert / safe / info). System messages render as full-width cards in the UI.
  messageType: messageTypeEnum("message_type").notNull().default("user"),
  // Optional structured payload for system messages (e.g. incidentId, lat/lng)
  meta: text("meta"),
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
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
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
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
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

// Live Location Sharing table
export const activityTypeEnum = pgEnum("activity_type", ["stationary", "walking", "running", "cycling", "driving"]);

export const liveLocationShares = pgTable("live_location_shares", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  active: boolean("active").notNull().default(true),
  expiresAt: timestamp("expires_at"),
  lastLat: doublePrecision("last_lat"),
  lastLng: doublePrecision("last_lng"),
  lastAccuracy: real("last_accuracy"),
  lastSpeed: real("last_speed"),
  lastHeading: real("last_heading"),
  lastActivity: activityTypeEnum("last_activity").default("stationary"),
  lastUpdatedAt: timestamp("last_updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("live_location_user_idx").on(table.userId),
  index("live_location_active_idx").on(table.userId, table.active),
]);

export const liveLocationSharesRelations = relations(liveLocationShares, ({ one }) => ({
  user: one(users, {
    fields: [liveLocationShares.userId],
    references: [users.id],
  }),
}));

export const liveLocationPoints = pgTable("live_location_points", {
  id: uuid("id").defaultRandom().primaryKey(),
  shareId: uuid("share_id").notNull().references(() => liveLocationShares.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  accuracy: real("accuracy"),
  speed: real("speed"),
  heading: real("heading"),
  activity: activityTypeEnum("activity").default("stationary"),
  recordedAt: timestamp("recorded_at").defaultNow().notNull(),
}, (table) => [
  index("live_points_share_idx").on(table.shareId, table.recordedAt),
  index("live_points_user_idx").on(table.userId, table.recordedAt),
]);

export const liveLocationPointsRelations = relations(liveLocationPoints, ({ one }) => ({
  share: one(liveLocationShares, {
    fields: [liveLocationPoints.shareId],
    references: [liveLocationShares.id],
  }),
  user: one(users, {
    fields: [liveLocationPoints.userId],
    references: [users.id],
  }),
}));

export const insertLiveLocationShareSchema = createInsertSchema(liveLocationShares).omit({ id: true, createdAt: true, lastUpdatedAt: true });
export type LiveLocationShare = typeof liveLocationShares.$inferSelect;
export type InsertLiveLocationShare = z.infer<typeof insertLiveLocationShareSchema>;

export const insertLiveLocationPointSchema = createInsertSchema(liveLocationPoints).omit({ id: true, recordedAt: true });
export type LiveLocationPoint = typeof liveLocationPoints.$inferSelect;
export type InsertLiveLocationPoint = z.infer<typeof insertLiveLocationPointSchema>;

export const contextEventTypeEnum = pgEnum("context_event_type", ["dwell_start", "dwell_end", "trip_start", "trip_end"]);

export const contextEvents = pgTable("context_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: contextEventTypeEnum("type").notNull(),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  placeName: text("place_name"),
  placeType: text("place_type"),
  detail: text("detail"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("context_events_user_idx").on(table.userId, table.createdAt),
]);

export const contextEventsRelations = relations(contextEvents, ({ one }) => ({
  user: one(users, {
    fields: [contextEvents.userId],
    references: [users.id],
  }),
}));

export type ContextEvent = typeof contextEvents.$inferSelect;

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

// Watcher Notification Preferences (per watched user)
export const watcherNotificationPrefs = pgTable("watcher_notification_prefs", {
  id: uuid("id").defaultRandom().primaryKey(),
  watcherId: uuid("watcher_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  watchedUserId: uuid("watched_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  arrivalNotifications: boolean("arrival_notifications").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("watcher_notif_prefs_watcher_idx").on(table.watcherId),
  index("watcher_notif_prefs_watched_idx").on(table.watchedUserId),
]);

export const watcherNotificationPrefsRelations = relations(watcherNotificationPrefs, ({ one }) => ({
  watcher: one(users, {
    fields: [watcherNotificationPrefs.watcherId],
    references: [users.id],
  }),
}));

// Drive Sessions table
export const driveSessions = pgTable("drive_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  endedAt: timestamp("ended_at"),
  maxSpeedKmh: doublePrecision("max_speed_kmh").notNull().default(0),
  avgSpeedKmh: doublePrecision("avg_speed_kmh").notNull().default(0),
  distanceKm: doublePrecision("distance_km").notNull().default(0),
  crashDetected: boolean("crash_detected").notNull().default(false),
  startLat: doublePrecision("start_lat"),
  startLng: doublePrecision("start_lng"),
  endLat: doublePrecision("end_lat"),
  endLng: doublePrecision("end_lng"),
}, (table) => [
  index("drive_sessions_user_id_idx").on(table.userId),
  index("drive_sessions_started_at_idx").on(table.userId, table.startedAt),
]);

export const driveSessionsRelations = relations(driveSessions, ({ one }) => ({
  user: one(users, {
    fields: [driveSessions.userId],
    references: [users.id],
  }),
}));

// Speed Alerts table
export const speedAlerts = pgTable("speed_alerts", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").references(() => driveSessions.id, { onDelete: "cascade" }),
  speedKmh: doublePrecision("speed_kmh").notNull(),
  speedLimitKmh: integer("speed_limit_kmh").notNull(),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("speed_alerts_user_id_idx").on(table.userId),
  index("speed_alerts_session_id_idx").on(table.sessionId),
]);

export const speedAlertsRelations = relations(speedAlerts, ({ one }) => ({
  user: one(users, {
    fields: [speedAlerts.userId],
    references: [users.id],
  }),
  session: one(driveSessions, {
    fields: [speedAlerts.sessionId],
    references: [driveSessions.id],
  }),
}));

// Error Reports table (crash/error tracking)
export const errorReports = pgTable("error_reports", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  type: text("type").notNull().default("error"),
  message: text("message").notNull(),
  stack: text("stack"),
  url: text("url"),
  userAgent: text("user_agent"),
  metadata: text("metadata"),
  resolved: boolean("resolved").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("error_reports_created_at_idx").on(table.createdAt),
  index("error_reports_type_idx").on(table.type),
]);

export const errorReportsRelations = relations(errorReports, ({ one }) => ({
  user: one(users, {
    fields: [errorReports.userId],
    references: [users.id],
  }),
}));

// App Ratings table
export const appRatings = pgTable("app_ratings", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  rating: integer("rating").notNull(),
  comment: text("comment"),
  appVersion: text("app_version"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("app_ratings_user_id_idx").on(table.userId),
  index("app_ratings_created_at_idx").on(table.createdAt),
]);

export const appRatingsRelations = relations(appRatings, ({ one }) => ({
  user: one(users, {
    fields: [appRatings.userId],
    references: [users.id],
  }),
}));

// Safety Timer (Dead Man's Switch)
export const safetyTimerStatusEnum = pgEnum("safety_timer_status", ["active", "grace_period", "escalated", "cancelled", "safe"]);

export const safetyTimers = pgTable("safety_timers", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  durationMinutes: integer("duration_minutes").notNull(),
  note: text("note"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  status: safetyTimerStatusEnum("status").notNull().default("active"),
  lastLat: doublePrecision("last_lat"),
  lastLng: doublePrecision("last_lng"),
  lastActivity: text("last_activity"),
  lastSpeed: doublePrecision("last_speed"),
  lastLocationAt: timestamp("last_location_at"),
  resolvedAt: timestamp("resolved_at"),
}, (table) => [
  index("safety_timer_user_idx").on(table.userId),
  index("safety_timer_status_idx").on(table.status),
]);

export const safetyTimersRelations = relations(safetyTimers, ({ one }) => ({
  user: one(users, {
    fields: [safetyTimers.userId],
    references: [users.id],
  }),
}));

// Safe Walk / Safe Ride
export const safeWalkStatusEnum = pgEnum("safe_walk_status", ["active", "arrived", "overdue", "escalated", "cancelled"]);

export const safeWalks = pgTable("safe_walks", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  destinationLat: doublePrecision("destination_lat").notNull(),
  destinationLng: doublePrecision("destination_lng").notNull(),
  destinationName: text("destination_name"),
  destinationType: text("destination_type").notNull().default("pin"),
  note: text("note"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  expectedArrivalAt: timestamp("expected_arrival_at").notNull(),
  arrivalRadiusMeters: integer("arrival_radius_meters").notNull().default(200),
  status: safeWalkStatusEnum("status").notNull().default("active"),
  lastLat: doublePrecision("last_lat"),
  lastLng: doublePrecision("last_lng"),
  lastActivity: text("last_activity"),
  lastSpeed: doublePrecision("last_speed"),
  lastLocationAt: timestamp("last_location_at"),
  resolvedAt: timestamp("resolved_at"),
}, (table) => [
  index("safe_walk_user_idx").on(table.userId),
  index("safe_walk_status_idx").on(table.status),
]);

export const safeWalksRelations = relations(safeWalks, ({ one }) => ({
  user: one(users, {
    fields: [safeWalks.userId],
    references: [users.id],
  }),
}));

// Trip Points (location trail for Safety Timer and Safe Walk)
export const tripPoints = pgTable("trip_points", {
  id: uuid("id").defaultRandom().primaryKey(),
  tripId: uuid("trip_id").notNull(),
  tripType: text("trip_type").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  speed: doublePrecision("speed"),
  activity: text("activity"),
  recordedAt: timestamp("recorded_at").defaultNow().notNull(),
}, (table) => [
  index("trip_points_trip_idx").on(table.tripId, table.tripType),
  index("trip_points_user_idx").on(table.userId),
]);

export const tripPointsRelations = relations(tripPoints, ({ one }) => ({
  user: one(users, {
    fields: [tripPoints.userId],
    references: [users.id],
  }),
}));

// Insert Schemas
export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true });
export const insertSettingsSchema = createInsertSchema(settings).omit({ userId: true, updatedAt: true });
export const insertContactSchema = createInsertSchema(contacts).omit({ id: true, userId: true, createdAt: true }).extend({
  email: z.string().trim().email("Please enter a valid email address").nullish().or(z.literal("").transform(() => null)),
});
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
export const insertWatcherNotificationPrefSchema = createInsertSchema(watcherNotificationPrefs).omit({ id: true, createdAt: true });
export const insertDriveSessionSchema = createInsertSchema(driveSessions).omit({ id: true, startedAt: true });
export const insertSpeedAlertSchema = createInsertSchema(speedAlerts).omit({ id: true, createdAt: true });
export const insertErrorReportSchema = createInsertSchema(errorReports).omit({ id: true, createdAt: true });
export const insertAppRatingSchema = createInsertSchema(appRatings).omit({ id: true, createdAt: true });
export const insertSafetyTimerSchema = createInsertSchema(safetyTimers).omit({ id: true, startedAt: true });
export const insertSafeWalkSchema = createInsertSchema(safeWalks).omit({ id: true, startedAt: true });
export const insertTripPointSchema = createInsertSchema(tripPoints).omit({ id: true, recordedAt: true });

// ===== Family Mode =====
// Family Mode is a *safety* group, NOT parental control / app-usage tracking.
export const families = pgTable("families", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  adminUserId: uuid("admin_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("families_admin_user_id_idx").on(table.adminUserId),
]);

export const familyMembers = pgTable("family_members", {
  id: uuid("id").defaultRandom().primaryKey(),
  familyId: uuid("family_id").notNull().references(() => families.id, { onDelete: "cascade" }),
  // For pending invites userId is null until the invitee accepts (we resolve by phone)
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  invitePhone: text("invite_phone"),
  inviteName: text("invite_name"),
  nickname: text("nickname"),
  role: familyRoleEnum("role").notNull().default("adult"),
  status: familyMemberStatusEnum("status").notNull().default("invited"),
  sharingMode: sharingModeEnum("sharing_mode").notNull().default("precise"),
  parentalConsentRequired: boolean("parental_consent_required").notNull().default(false),
  parentalConsentGranted: boolean("parental_consent_granted").notNull().default(false),
  invitedBy: uuid("invited_by").references(() => users.id),
  // Consent audit trail (added with the explicit-accept requirement). Nullable
  // because legacy rows pre-date these fields; they are populated on the next
  // accept/decline transition for those rows.
  invitedAt: timestamp("invited_at"),
  acceptedAt: timestamp("accepted_at"),
  declinedAt: timestamp("declined_at"),
  // Set on rows backfilled from the pre-consent era. While in the future,
  // helpers treat status="active_legacy" as effectively-active. Once it
  // passes, helpers treat the row as pending until the user re-confirms.
  legacyConfirmDeadline: timestamp("legacy_confirm_deadline"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("family_members_family_id_idx").on(table.familyId),
  index("family_members_user_id_idx").on(table.userId),
  index("family_members_invite_phone_idx").on(table.invitePhone),
]);

export const familiesRelations = relations(families, ({ one, many }) => ({
  admin: one(users, { fields: [families.adminUserId], references: [users.id] }),
  members: many(familyMembers),
}));

export const familyMembersRelations = relations(familyMembers, ({ one }) => ({
  family: one(families, { fields: [familyMembers.familyId], references: [families.id] }),
  user: one(users, { fields: [familyMembers.userId], references: [users.id] }),
}));

// Family group chat - everyone in the family can see and send.
// Kind 'system' covers Family Pulse, "arrived at Home", panic alerts, etc.
export const familyMessages = pgTable("family_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  familyId: uuid("family_id").notNull().references(() => families.id, { onDelete: "cascade" }),
  senderId: uuid("sender_id").references(() => users.id, { onDelete: "set null" }),
  body: text("body").notNull(),
  kind: text("kind").notNull().default("user"), // 'user' | 'pulse' | 'panic' | 'system'
  meta: text("meta"), // JSON string
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("family_messages_family_id_idx").on(table.familyId),
  index("family_messages_created_at_idx").on(table.createdAt),
]);

// Saved Places for the family (Home, School, Work, etc.) - shared across the family.
// Used to render named markers on the family map and to detect arrivals/departures.
export const familyPlaces = pgTable("family_places", {
  id: uuid("id").defaultRandom().primaryKey(),
  familyId: uuid("family_id").notNull().references(() => families.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  icon: text("icon").notNull().default("pin"), // 'home' | 'school' | 'work' | 'gym' | 'park' | 'pin'
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  radiusMeters: integer("radius_meters").notNull().default(150),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("family_places_family_id_idx").on(table.familyId),
]);

// Per-member expectations for a saved place. Example: "Sarah at School,
// Mon-Fri, 08:30-15:30". If she isn't inside the place's radius by the end
// of the window (+ grace), the family chat gets a one-time alert that day.
export const familyPlaceSchedules = pgTable("family_place_schedules", {
  id: uuid("id").defaultRandom().primaryKey(),
  familyId: uuid("family_id").notNull().references(() => families.id, { onDelete: "cascade" }),
  placeId: uuid("place_id").notNull().references(() => familyPlaces.id, { onDelete: "cascade" }),
  memberId: uuid("member_id").notNull().references(() => familyMembers.id, { onDelete: "cascade" }),
  // Days of week as CSV: "1,2,3,4,5" where 0=Sun..6=Sat
  daysOfWeek: text("days_of_week").notNull(),
  // Local-time window expressed as minutes from midnight (0..1439)
  expectedStartMinutes: integer("expected_start_minutes").notNull(),
  expectedEndMinutes: integer("expected_end_minutes").notNull(),
  graceMinutes: integer("grace_minutes").notNull().default(15),
  active: boolean("active").notNull().default(true),
  // YYYY-MM-DD of last day the family was alerted, prevents repeat pings
  lastAlertedDate: text("last_alerted_date"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("family_place_schedules_family_id_idx").on(table.familyId),
  index("family_place_schedules_place_id_idx").on(table.placeId),
  index("family_place_schedules_member_id_idx").on(table.memberId),
]);

export const insertFamilySchema = createInsertSchema(families).omit({ id: true, createdAt: true, updatedAt: true });
export const insertFamilyMemberSchema = createInsertSchema(familyMembers).omit({ id: true, createdAt: true, updatedAt: true });
export const insertFamilyMessageSchema = createInsertSchema(familyMessages).omit({ id: true, createdAt: true });
export const insertFamilyPlaceSchema = createInsertSchema(familyPlaces).omit({ id: true, createdAt: true });
export const insertFamilyPlaceScheduleSchema = createInsertSchema(familyPlaceSchedules).omit({ id: true, createdAt: true, lastAlertedDate: true });

// Per-attempt audit log for every outbound communication. One row per attempt
// (queued/sent/delivered/failed/blocked). Used by:
//   - server/outbound-policy.ts to enforce windowed user / IP / per-destination
//     rate limits and Category-B dedupe.
//   - back-office reporting (cost, abuse, deliverability).
//
// PII rules:
//   * `destinationHash` is HMAC-SHA256(OUTBOUND_LOG_SECRET, normalizedDest).
//     Phone numbers, emails, push endpoints and userIds are HASHED, never raw.
//   * `dedupeKey` is caller-provided and may itself be a hash. Limit it to
//     opaque tokens (e.g. `incident:<id>:sms` or `family_invite:<phoneHash>`).
//
// Retention: keep ~30 days for abuse/cost auditing; the daily privacy-cron
// already deletes old rows by createdAt. Active incidents reference rows by
// `dedupeKey` rather than by id, so deletion is safe.
export const outboundSendLog = pgTable("outbound_send_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  channel: outboundChannelEnum("channel").notNull(),
  purpose: outboundPurposeEnum("purpose").notNull(),
  status: outboundStatusEnum("status").notNull(),
  // HMAC of the destination identifier (phone / email / push endpoint / userId).
  destinationHash: text("destination_hash").notNull(),
  // Optional grouping key for Category-B dedupe (e.g. `incident:<id>:sms`).
  // When set, enforceSendPolicy collapses duplicate sends within a 5-min window.
  dedupeKey: text("dedupe_key"),
  // Originating user (the SUBJECT of the safety event), if known. Null for
  // OTP / account-recovery / public webhook traffic.
  userId: uuid("user_id"),
  // Incident this send is part of, if applicable. Lets escalation queries
  // reconstruct a per-incident delivery timeline without scanning all rows.
  incidentId: uuid("incident_id"),
  // Hashed source IP (Category-A IP-layer enforcement). Never the raw IP.
  ipHash: text("ip_hash"),
  // Provider-side identifier (Twilio messageSid, push endpoint id, etc).
  providerId: text("provider_id"),
  // Short error message when status='failed' / 'blocked_*'. Truncated to 500
  // chars at write time. Never includes recipient PII.
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("outbound_log_dedupe_idx").on(table.dedupeKey, table.createdAt),
  index("outbound_log_user_purpose_idx").on(table.userId, table.purpose, table.createdAt),
  index("outbound_log_ip_purpose_idx").on(table.ipHash, table.purpose, table.createdAt),
  index("outbound_log_dest_purpose_idx").on(table.destinationHash, table.purpose, table.createdAt),
  index("outbound_log_channel_created_idx").on(table.channel, table.createdAt),
  index("outbound_log_incident_idx").on(table.incidentId),
]);

export const insertOutboundSendLogSchema = createInsertSchema(outboundSendLog).omit({ id: true, createdAt: true });
export type InsertOutboundSendLog = z.infer<typeof insertOutboundSendLogSchema>;
export type OutboundSendLog = typeof outboundSendLog.$inferSelect;

// Processor cleanup queue (Batch 2: account deletion).
// One row per account-deletion event. The user row is gone by the time this is
// inserted (or moments after) so userId is a SNAPSHOT, not a foreign key, and
// the row carries the snapshot of processor IDs we need to retry calls. Steps
// that succeed inline are removed from `stepsRemaining`. Cron drainer retries
// any remaining steps with exponential backoff; rows are pruned 90 days after
// completion. Step keys: 'stripe_sub_cancel', 'stripe_customer_del',
// 'revenuecat_delete', 'outbound_log_purge'.
export const processorCleanupQueue = pgTable("processor_cleanup_queue", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull(),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  stepsRemaining: text("steps_remaining").array().notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastAttemptAt: timestamp("last_attempt_at"),
  lastError: text("last_error"),
  nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("proc_cleanup_next_attempt_idx").on(table.nextAttemptAt, table.completedAt),
  index("proc_cleanup_user_idx").on(table.userId),
  index("proc_cleanup_completed_idx").on(table.completedAt),
]);

export type ProcessorCleanupQueueRow = typeof processorCleanupQueue.$inferSelect;
export type FamilyMessage = typeof familyMessages.$inferSelect;
export type InsertFamilyMessage = z.infer<typeof insertFamilyMessageSchema>;
export type FamilyPlace = typeof familyPlaces.$inferSelect;
export type InsertFamilyPlace = z.infer<typeof insertFamilyPlaceSchema>;
export type FamilyPlaceSchedule = typeof familyPlaceSchedules.$inferSelect;
export type InsertFamilyPlaceSchedule = z.infer<typeof insertFamilyPlaceScheduleSchema>;

export type Family = typeof families.$inferSelect;
export type InsertFamily = z.infer<typeof insertFamilySchema>;
export type FamilyMember = typeof familyMembers.$inferSelect;
export type InsertFamilyMember = z.infer<typeof insertFamilyMemberSchema>;
export type FamilyRole = "admin" | "adult" | "teen" | "child";
export type FamilyMemberStatus =
  | "active"
  | "invited"
  | "paused"
  | "removed"
  | "pending"
  | "active_legacy"
  | "declined";

// Hydrated row for the Family page
export interface FamilyMemberView {
  id: string;
  userId: string | null;
  name: string;
  nickname: string | null;
  phone: string | null;
  role: FamilyRole;
  status: FamilyMemberStatus;
  sharingMode: "precise" | "area" | "presence" | "paused";
  parentalConsentRequired: boolean;
  parentalConsentGranted: boolean;
  isAdmin: boolean;
  // Safety + presence (best-effort, may be null for pending invites)
  safetyState: "active" | "quiet" | "concern" | null;
  lastSeenAt: Date | null;
  lastLat: number | null;
  lastLng: number | null;
  lastAccuracy: number | null;
  lastActivity: "stationary" | "walking" | "running" | "cycling" | "driving" | null;
  hasActiveIncident: boolean;
  // IANA timezone (e.g. "America/New_York") so the family UI can show each
  // member's local clock when they're in a different time zone.
  timezone: string | null;
}

export interface FamilyOverview {
  family: Family | null;
  isAdmin: boolean;
  members: FamilyMemberView[];
}

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

export type WatcherNotificationPref = typeof watcherNotificationPrefs.$inferSelect;
export type InsertWatcherNotificationPref = z.infer<typeof insertWatcherNotificationPrefSchema>;

export type DriveSession = typeof driveSessions.$inferSelect;
export type InsertDriveSession = z.infer<typeof insertDriveSessionSchema>;

export type SpeedAlert = typeof speedAlerts.$inferSelect;
export type InsertSpeedAlert = z.infer<typeof insertSpeedAlertSchema>;

export type ErrorReport = typeof errorReports.$inferSelect;
export type InsertErrorReport = z.infer<typeof insertErrorReportSchema>;

export type AppRating = typeof appRatings.$inferSelect;
export type InsertAppRating = z.infer<typeof insertAppRatingSchema>;

export type SafetyTimer = typeof safetyTimers.$inferSelect;
export type InsertSafetyTimer = z.infer<typeof insertSafetyTimerSchema>;

export type SafeWalk = typeof safeWalks.$inferSelect;
export type InsertSafeWalk = z.infer<typeof insertSafeWalkSchema>;

export type TripPoint = typeof tripPoints.$inferSelect;
export type InsertTripPoint = z.infer<typeof insertTripPointSchema>;

export interface EscalationTimelineEntry {
  type: string;
  time: string;
  detail: string;
}

export interface ReportData {
  userName: string;
  periodStart: string;
  periodEnd: string;
  checkins: { date: string; time: string; method: string }[];
  totalCheckins: number;
  missedCheckins: number;
  complianceRate: number;
  incidents: { date: string; reason: string; resolved: boolean; duration: string | null; escalationTimeline: EscalationTimelineEntry[] }[];
  // Omitted entirely when the user has not opted in to heart-rate monitoring.
  heartRateSummary?: { avgBpm: number; minBpm: number; maxBpm: number; alerts: number };
  drivingSummary: { totalDrives: number; totalDistanceKm: number; topSpeedKmh: number; speedingEvents: number; crashEvents: number } | null;
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
  userTimezone: string;
  lastCheckinAt: Date | null;
  lastCheckinMethod: string | null;
  nextCheckinDue: Date;
  wellnessCallStatus: "placed" | "answered_human" | "voicemail_left" | "safe" | "help" | "no_response" | "failed" | null;
  wellnessCallAt: Date | null;
  reminderStage: "none" | "push" | "sms" | "calling" | null;
  hasOpenIncident: boolean;
  incidentReason: string | null;
  incidentId: string | null;
  incidentClaimedBy: string | null;
  incidentClaimedAt: Date | null;
  incidentIsDrill: boolean;
  contactId: string;
  circleRole: "primary" | "backup" | "support";
  safetyState: "active" | "quiet" | "concern" | null;
  safetyStateReason: string | null;
  safetyStateChangedAt: Date | null;
  sharingMode: "precise" | "area" | "presence" | "paused";
  lastHeartbeatAt: Date | null;
  lastHeartbeatLat: number | null;
  lastHeartbeatLng: number | null;
  lastHeartbeatAcc: number | null;
  lastLocationAt: Date | null;
  lastLocationLat: number | null;
  lastLocationLng: number | null;
  lastLocationAcc: number | null;
  lastActivity: "stationary" | "walking" | "running" | "cycling" | "driving" | null;
  lastSpeed: number | null;
  batteryLevel: number | null;
  batteryCharging: boolean | null;
  networkType: string | null;
  lastDeviceStatusAt: Date | null;
  isInLearningMode: boolean;
  activeSafeWalk: {
    destinationName: string | null;
    expectedArrivalAt: Date;
    lastSpeed: number | null;
    lastLocationAt: Date | null;
    status: string;
  } | null;
}

export interface ContactPageData {
  // 'live'     - normal watcher view, may include location during active sharing windows
  // 'allclear' - read-only resolution view; never carries location or history
  // 'resolved' - shown when a watcher opens an alert-era link AFTER the
  //              incident has been resolved. Strips location, last check-in,
  //              live share, and all actions. The fresh allclear link sent in
  //              the resolution SMS still works normally.
  mode: "live" | "allclear" | "resolved";
  user: {
    id: string;
    name: string;
    phone: string | null;
    timezone: string | null;
  };
  contact: Contact;
  lastCheckin: Checkin | null;
  incident: Incident | null;
  locationSession: LocationSession | null;
  handlingContact: Contact | null;
  safetyTimer: SafetyTimer | null;
  safeWalk: SafeWalk | null;
  crashDrive: DriveSession | null;
  tripTrail: TripPoint[];
  // Resolution timestamp for allclear views, set when mode === 'allclear'.
  resolvedAt: string | null;
}
