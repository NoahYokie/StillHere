import { randomBytes } from "crypto";
import { eq, desc, and, ne, gt, gte, lt, or, isNull, isNotNull, inArray } from "drizzle-orm";
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
  contextEvents,
  smsDeliveryLogs,
  type SmsDeliveryLog,
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
  safetyTimers,
  safeWalks,
  tripPoints,
  type SafetyTimer,
  type SafeWalk,
  type TripPoint,
  families,
  familyMembers,
  familyMessages,
  familyPlaces,
  familyPlaceSchedules,
  type Family,
  type FamilyMember,
  type FamilyMemberView,
  type FamilyOverview,
  type FamilyRole,
  type FamilyMemberStatus,
  type FamilyMessage,
  type FamilyPlace,
} from "@shared/schema";

// ===== Family consent helpers =====
// `active_legacy` is a backfill marker. While the legacyConfirmDeadline is in
// the future the row is treated as effectively-active so the inviter does not
// suddenly lose visibility on day-of-deploy. Once the deadline passes (or if
// the marker is missing for any reason) the row is treated as `pending` so no
// data leaks if the nightly downgrade cron is delayed or fails.
function effectiveFamilyStatus(row: {
  status: FamilyMemberStatus;
  legacyConfirmDeadline: Date | null;
}): FamilyMemberStatus {
  if (row.status === "active_legacy") {
    if (!row.legacyConfirmDeadline) return "pending";
    return row.legacyConfirmDeadline.getTime() > Date.now() ? "active_legacy" : "pending";
  }
  return row.status;
}

function isEffectivelyActiveFamilyMember(row: {
  status: FamilyMemberStatus;
  legacyConfirmDeadline: Date | null;
}): boolean {
  const eff = effectiveFamilyStatus(row);
  return eff === "active" || eff === "active_legacy";
}

const TRIAL_DAYS = 14;

function isSubscriptionActive(user: { isPremium?: boolean | null; premiumUntil?: Date | string | null } | null | undefined): boolean {
  if (!user) return false;
  if (user.isPremium) return true;
  if (!user.premiumUntil) return false;
  return new Date(user.premiumUntil).getTime() > Date.now();
}

function trialEndsAt(user: { createdAt?: Date | string | null } | null | undefined): Date | null {
  if (!user?.createdAt) return null;
  const createdAt = new Date(user.createdAt);
  if (Number.isNaN(createdAt.getTime())) return null;
  return new Date(createdAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

function isTrialActive(user: { createdAt?: Date | string | null } | null | undefined): boolean {
  const endsAt = trialEndsAt(user);
  return !!endsAt && endsAt.getTime() > Date.now();
}

export interface PendingFamilyInvitation {
  memberId: string;
  familyId: string;
  familyName: string;
  inviterUserId: string;
  inviterName: string;
  role: FamilyRole;
  invitedAt: Date;
  // For active_legacy in-window: the user is asked to re-confirm before this.
  // Null for fresh pending invites.
  legacyConfirmDeadline: Date | null;
  // True when this row was backfilled from before the explicit-accept rule.
  isLegacyReconfirm: boolean;
}

// Anti-harassment cooldown after a decline: the same family cannot re-invite
// the same phone within 24 hours.
export const DECLINE_REINVITE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// Backfill window: legacy rows have 21 days to re-confirm before they are
// treated as pending and lose visibility.
export const LEGACY_CONFIRM_WINDOW_DAYS = 21;
import { addHours, startOfDay, format } from "date-fns";
import { lte } from "drizzle-orm";

function startOfDayInTimezone(date: Date, tz: string): Date {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const dateStr = fmt.format(date);
    const guess = new Date(`${dateStr}T00:00:00Z`);
    const offset = getTimezoneOffsetMs(guess, tz);
    const midnight = new Date(guess.getTime() - offset);
    const checkOffset = getTimezoneOffsetMs(midnight, tz);
    if (checkOffset !== offset) {
      return new Date(guess.getTime() - checkOffset);
    }
    return midnight;
  } catch {
    return startOfDay(date);
  }
}

function getTimezoneOffsetMs(date: Date, tz: string): number {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = date.toLocaleString("en-US", { timeZone: tz });
  return new Date(tzStr).getTime() - new Date(utcStr).getTime();
}

// Compute the next check-in due moment as the next occurrence of the user's
// preferred local time-of-day in their timezone, strictly after `lastTime`.
// For sub-daily intervals (< 24h, or non-daily multiples) we fall back to
// the simple elapsed-hours model since "preferred time" only makes sense
// for daily-cadence schedules.
export function computeNextCheckinDue(opts: {
  lastTime: Date;
  intervalHours: number;
  preferredCheckinTime: string | null | undefined;
  timezone: string | null | undefined;
  lastTimeIsCheckin?: boolean;
}): Date {
  const { lastTime } = opts;
  const intervalHours = normalizeCheckinIntervalHours(opts.intervalHours);
  const isDailyLike = intervalHours >= 24 && intervalHours % 24 === 0;
  if (!isDailyLike) {
    return addHours(lastTime, intervalHours);
  }
  const tz = opts.timezone || "UTC";
  const pref = (opts.preferredCheckinTime || "09:00").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(pref);
  const targetH = Math.max(0, Math.min(23, m ? parseInt(m[1], 10) : 9));
  const targetM = Math.max(0, Math.min(59, m ? parseInt(m[2], 10) : 0));
  const stepDays = intervalHours / 24;
  const stepMs = stepDays * 86_400_000;

  let dayStart = startOfDayInTimezone(lastTime, tz);
  let candidate = new Date(dayStart.getTime() + targetH * 3_600_000 + targetM * 60_000);
  // Advance until strictly after lastTime. Re-anchor each iteration so DST
  // transitions don't cause drift.
  let safety = 0;
  while (candidate <= lastTime && safety < 400) {
    const probe = new Date(candidate.getTime() + stepMs + 3_600_000);
    dayStart = startOfDayInTimezone(probe, tz);
    candidate = new Date(dayStart.getTime() + targetH * 3_600_000 + targetM * 60_000);
    safety++;
  }
  if (opts.lastTimeIsCheckin && startOfDayInTimezone(candidate, tz).getTime() === startOfDayInTimezone(lastTime, tz).getTime()) {
    const probe = new Date(candidate.getTime() + stepMs + 3_600_000);
    const nextDayStart = startOfDayInTimezone(probe, tz);
    candidate = new Date(nextDayStart.getTime() + targetH * 3_600_000 + targetM * 60_000);
  }
  return candidate;
}

function normalizeCheckinIntervalHours(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return 24;
  const hours = Math.round(Number(value));
  // Current settings validation allows 12-168 hours. Some migrated rows may
  // still contain older sub-daily values, which would restart missed-checkin
  // alerting far more often than the product supports.
  return Math.max(12, Math.min(168, hours));
}

function obfuscateCoord(value: number, seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }
  const offset = ((hash % 2000) - 1000) / 100000;
  return Math.round((value + offset) * 100) / 100;
}

export interface IStorage {
  // Users
  getUser(id: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, updates: Partial<InsertUser>): Promise<User>;
  markLimitationsAcknowledged(userId: string): Promise<User>;
  hasActiveSafetyEvent(userId: string): Promise<boolean>;
  recordHeartbeat(userId: string, lat?: number, lng?: number, acc?: number, batt?: number, chg?: boolean, net?: string): Promise<void>;
  updateSafetyState(userId: string, newState: string, reason: string): Promise<void>;
  getStaleActiveUsers(thresholdSeconds: number): Promise<{ id: string; safetyState: string; lastHeartbeatAt: Date }[]>;
  
  // Settings
  getSettings(userId: string): Promise<Settings | undefined>;
  updateSettings(userId: string, settings: Partial<InsertSettings>): Promise<Settings>;
  incrementRemindersSent(userId: string): Promise<Settings>;
  addReminderTimelineEntry(userId: string, entry: { type: string; time: string; detail: string }): Promise<void>;
  getReminderTimeline(userId: string): Promise<{ type: string; time: string; detail: string }[]>;
  resetReminderState(userId: string): Promise<Settings>;
  
  // Contacts
  getContacts(userId: string): Promise<Contact[]>;
  getContact(id: string): Promise<Contact | undefined>;
  upsertContacts(userId: string, contactsData: { contact1: InsertContact; contact2?: InsertContact }): Promise<Contact[]>;
  saveContactsList(userId: string, contactsList: { name: string; phone: string; email?: string | null; priority: number }[]): Promise<Contact[]>;
  deleteContact(contactId: string): Promise<void>;
  pauseContact(contactId: string, pausedUntil: Date | null, pausedBy: string): Promise<Contact>;
  softDeleteContact(contactId: string, deletedBy: string): Promise<Contact>;
  restoreContact(contactId: string): Promise<Contact>;
  getSoftDeletedContacts(userId: string): Promise<Contact[]>;
  getSoftDeletedContactsByWatcher(watcherUserId: string): Promise<(Contact & { ownerName: string })[]>;
  cleanupExpiredSoftDeletes(): Promise<number>;
  cleanupExpiredLocationData(): Promise<{ pointsDeleted: number; sharesDeleted: number; usersProcessed: number }>;
  setSmsOptOutByPhone(phone: string, optedOut: boolean): Promise<{ usersUpdated: number; contactsUpdated: number }>;
  isPhoneSmsOptedOut(phone: string): Promise<boolean>;
  recordSmsDelivery(input: { messageSid: string; toLast4: string; status: string; errorCode: string | null; errorMessage: string | null }): Promise<void>;
  accelerateEscalationForFailedSms(phone: string): Promise<number>;
  getContactLimit(userId: string): Promise<number>;
  
  // Contact Tokens
  getContactByToken(token: string): Promise<{ contact: Contact; user: User; purpose: string; tokenCreatedAt: Date } | undefined>;
  generateToken(contactId: string, options?: { ttlHours?: number; purpose?: "standing" | "incident" | "allclear" }): Promise<ContactToken>;
  rotateAllStandingTokensForUser(userId: string): Promise<{ contact: Contact; token: string }[]>;
  revokeAllTokensForUser(userId: string): Promise<void>;
  regenerateTokensForUser(userId: string): Promise<{ contact: Contact; token: string }[]>;
  getOrMintIncidentTokensForUser(userId: string, incidentStartedAt: Date): Promise<{ contact: Contact; token: string }[]>;
  
  // Checkins
  getLastCheckin(userId: string): Promise<Checkin | undefined>;
  createCheckin(userId: string, method?: "button" | "auto" | "sms", location?: { lat?: number; lng?: number; timezone?: string }): Promise<Checkin>;
  
  // Incidents
  getOpenIncident(userId: string): Promise<Incident | undefined>;
  getIncidentsNeedingEscalation(): Promise<Incident[]>;
  getStaleOpenIncidents(stalenessMs: number): Promise<Incident[]>;
  createIncident(userId: string, reason: IncidentReason): Promise<Incident>;
  updateIncident(id: string, updates: Partial<Incident>): Promise<Incident>;
  
  // Location Sessions
  getActiveLocationSession(userId: string): Promise<LocationSession | undefined>;
  getActiveEmergencyLocationSession(userId: string): Promise<LocationSession | undefined>;
  createLocationSession(userId: string, type: LocationSessionType, incidentId?: string, initialLocation?: { lat: number; lng: number; accuracy?: number | null }): Promise<LocationSession>;
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
  saveMessage(senderId: string, receiverId: string, content: string, options?: { messageType?: "user" | "system_alert" | "system_safe" | "system_info"; meta?: Record<string, any> }): Promise<Message>;
  getMessages(userId1: string, userId2: string, limit?: number): Promise<Message[]>;
  markMessagesRead(senderId: string, receiverId: string): Promise<void>;
  getUnreadCount(userId: string): Promise<number>;
  getConversations(userId: string): Promise<{ partnerId: string; partnerName: string; lastMessage: string; lastMessageAt: Date; unreadCount: number; lastMessageType: "user" | "system_alert" | "system_safe" | "system_info" }[]>;

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
  getUserHeartRateConfig(userId: string): Promise<{ monitoring: boolean; alerts: boolean }>;
  setUserHeartRateConfig(userId: string, config: { monitoring?: boolean; alerts?: boolean }): Promise<{ monitoring: boolean; alerts: boolean }>;
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
  recordSatelliteDeviceSeen(id: string): Promise<void>;
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
  getDriveSession(id: string): Promise<DriveSession | undefined>;
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
  getActiveLiveSharesForWatcher(watcherUserId: string): Promise<(LiveLocationShare & { userName: string; safetyState: string; hasSafetyEvent: boolean; safetyStateReason: string | null; incidentReason: string | null; hasOpenIncident: boolean })[]>;
  getWatcherVisibleSnapshot(userId: string): Promise<{
    virtualId: string;
    lat: number;
    lng: number;
    accuracy: number | null;
    updatedAt: Date;
    expiresAt: Date | null;
    source: "emergency_session" | "user_snapshot";
  } | undefined>;

  // Report Data
  getCheckinHistory(userId: string, from: Date, to: Date): Promise<Checkin[]>;
  getIncidentHistory(userId: string, from: Date, to: Date): Promise<Incident[]>;
  getDailyStatus(watcherUserId: string, watchedUserId: string): Promise<DailyStatus>;

  // Safety Timer
  createSafetyTimer(userId: string, durationMinutes: number, note?: string): Promise<SafetyTimer>;
  getActiveSafetyTimer(userId: string): Promise<SafetyTimer | undefined>;
  getSafetyTimer(id: string): Promise<SafetyTimer | undefined>;
  updateSafetyTimer(id: string, updates: Partial<SafetyTimer>): Promise<SafetyTimer>;
  getExpiredSafetyTimers(): Promise<SafetyTimer[]>;

  // Safe Walk
  createSafeWalk(userId: string, data: { destinationLat: number; destinationLng: number; destinationName?: string; destinationType: string; expectedArrivalAt: Date; note?: string; arrivalRadiusMeters?: number }): Promise<SafeWalk>;
  getActiveSafeWalk(userId: string): Promise<SafeWalk | undefined>;
  getSafeWalk(id: string): Promise<SafeWalk | undefined>;
  updateSafeWalk(id: string, updates: Partial<SafeWalk>): Promise<SafeWalk>;
  getOverdueSafeWalks(): Promise<SafeWalk[]>;

  // Trip Points
  addTripPoint(data: { tripId: string; tripType: string; userId: string; lat: number; lng: number; speed?: number; activity?: string }): Promise<TripPoint>;
  getTripPoints(tripId: string, tripType: string): Promise<TripPoint[]>;

  // ===== Family consent / membership (centralized authorization) =====
  // The ONLY family helpers that callers should use for authorization or for
  // exposing family data, presence, location, chat, schedules, places, or
  // notifications. `getFamilyForUser` is retained for the invitations inbox
  // path only and returns rows in any non-removed status.
  getActiveFamilyForUser(userId: string): Promise<FamilyOverview>;
  requireActiveFamilyMembership(userId: string, familyId: string): Promise<FamilyMember | { isAdmin: true }>;
  getPendingInvitationsForUser(userId: string): Promise<PendingFamilyInvitation[]>;
  acceptFamilyInvite(memberId: string, userId: string): Promise<FamilyMember>;
  declineFamilyInvite(memberId: string, userId: string): Promise<FamilyMember>;
  // Idempotent. Marks pre-consent rows as active_legacy (with a 21d deadline)
  // and converts the old `invited` default to `pending`. Also downgrades any
  // active_legacy whose deadline has passed to `pending` so visibility stops
  // even if this is called between cron runs.
  backfillFamilyConsent(): Promise<{ legacyMarked: number; pendingMarked: number; expiredDowngraded: number }>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const learningEnd = new Date();
    learningEnd.setDate(learningEnd.getDate() + 30);
    try {
      const [user] = await db.insert(users).values({
        ...insertUser,
        learningModeUntil: learningEnd,
      }).returning();

      await db.insert(settings).values({
        userId: user.id,
        checkinIntervalHours: 24,
        graceMinutes: 15,
        locationMode: "off",
      });

      return user;
    } catch (err: any) {
      if (err?.code === "23505" && /users_phone_unique|users_phone_key/.test(err?.constraint || err?.detail || "")) {
        const conflict: any = new Error("PHONE_ALREADY_REGISTERED");
        conflict.code = "PHONE_ALREADY_REGISTERED";
        conflict.status = 409;
        throw conflict;
      }
      throw err;
    }
  }

  async updateUser(id: string, updates: Partial<InsertUser>): Promise<User> {
    try {
      const [user] = await db
        .update(users)
        .set(updates)
        .where(eq(users.id, id))
        .returning();
      return user;
    } catch (err: any) {
      if (err?.code === "23505" && /users_phone_unique|users_phone_key/.test(err?.constraint || err?.detail || "")) {
        const conflict: any = new Error("PHONE_ALREADY_REGISTERED");
        conflict.code = "PHONE_ALREADY_REGISTERED";
        conflict.status = 409;
        throw conflict;
      }
      throw err;
    }
  }

  async markLimitationsAcknowledged(userId: string): Promise<User> {
    // Idempotent: only set the timestamp the first time. Re-acknowledging
    // does not overwrite the original acknowledgement time.
    const existing = await this.getUser(userId);
    if (existing?.acknowledgedLimitationsAt) {
      return existing;
    }
    const [user] = await db
      .update(users)
      .set({ acknowledgedLimitationsAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    return user;
  }

  async hasActiveSafetyEvent(userId: string): Promise<boolean> {
    // Returns true if the user is currently inside any urgent safety flow
    // that the Limitations gate must not interrupt: open incident (incl.
    // missed-checkin concern, SOS, drill), Safety Timer in any non-terminal
    // status (active / grace_period / escalated), Safe Walk in any
    // non-terminal status (active / overdue / escalated), active Drive
    // Safety session (no endedAt; crash countdown lives within an active
    // drive session). Also true when the server-side safety-state engine
    // has the user in `concern` (missed check-in concern flow).
    try {
      const incident = await this.getOpenIncident(userId);
      if (incident) return true;
    } catch {}
    try {
      const [timer] = await db
        .select({ id: safetyTimers.id })
        .from(safetyTimers)
        .where(and(
          eq(safetyTimers.userId, userId),
          or(
            eq(safetyTimers.status, "active"),
            eq(safetyTimers.status, "grace_period"),
            eq(safetyTimers.status, "escalated"),
          ),
        ))
        .limit(1);
      if (timer) return true;
    } catch {}
    try {
      const [walk] = await db
        .select({ id: safeWalks.id })
        .from(safeWalks)
        .where(and(
          eq(safeWalks.userId, userId),
          or(
            eq(safeWalks.status, "active"),
            eq(safeWalks.status, "overdue"),
            eq(safeWalks.status, "escalated"),
          ),
        ))
        .limit(1);
      if (walk) return true;
    } catch {}
    try {
      const drive = await this.getActiveDriveSession(userId);
      if (drive) return true;
    } catch {}
    // Conservative fallback: if the server-side safety-state engine has
    // moved this user out of `active` (i.e. `concern` or any other urgent
    // posture), treat that as an active safety event. This catches missed
    // check-in concern flows even before an incident row is created.
    try {
      const u = await this.getUser(userId);
      if (u && u.safetyState && u.safetyState !== "active" && u.safetyState !== "quiet") {
        return true;
      }
    } catch {}
    return false;
  }

  async recordHeartbeat(userId: string, lat?: number, lng?: number, acc?: number, batt?: number, chg?: boolean, net?: string): Promise<void> {
    const updates: Record<string, any> = {
      lastHeartbeatAt: new Date(),
      lastHeartbeatLat: lat ?? null,
      lastHeartbeatLng: lng ?? null,
      lastHeartbeatAcc: acc ?? null,
    };
    if (batt !== undefined) updates.batteryLevel = batt;
    if (chg !== undefined) updates.batteryCharging = chg;
    if (net !== undefined) updates.networkType = net;
    if (batt !== undefined || chg !== undefined || net !== undefined) {
      updates.lastDeviceStatusAt = new Date();
    }
    await db
      .update(users)
      .set(updates)
      .where(eq(users.id, userId));
  }

  async updateSafetyState(userId: string, newState: string, reason: string): Promise<void> {
    const user = await this.getUser(userId);
    const oldState = user?.safetyState || "active";
    await db
      .update(users)
      .set({
        safetyState: newState as any,
        safetyStateReason: reason,
        safetyStateChangedAt: new Date(),
      })
      .where(eq(users.id, userId));
    console.log(`[SafetyState] user ${userId} ${oldState} -> ${newState} (${reason})`);
  }

  async getStaleActiveUsers(thresholdSeconds: number): Promise<{ id: string; safetyState: string; lastHeartbeatAt: Date }[]> {
    const cutoff = new Date(Date.now() - thresholdSeconds * 1000);
    const results = await db
      .select({ id: users.id, safetyState: users.safetyState, lastHeartbeatAt: users.lastHeartbeatAt })
      .from(users)
      .where(
        and(
          eq(users.safetyState, "active"),
          isNotNull(users.lastHeartbeatAt),
          lte(users.lastHeartbeatAt, cutoff)
        )
      );
    return results
      .filter((r) => r.lastHeartbeatAt !== null)
      .map((r) => ({ id: r.id, safetyState: r.safetyState as string, lastHeartbeatAt: r.lastHeartbeatAt as Date }));
  }

  async getSettings(userId: string): Promise<Settings | undefined> {
    const [result] = await db.select().from(settings).where(eq(settings.userId, userId));
    if (!result) return undefined;
    return {
      ...result,
      checkinIntervalHours: normalizeCheckinIntervalHours(result.checkinIntervalHours),
    };
  }

  async updateSettings(userId: string, updates: Partial<InsertSettings>): Promise<Settings> {
    if (updates.checkinIntervalHours !== undefined) {
      updates = {
        ...updates,
        checkinIntervalHours: normalizeCheckinIntervalHours(updates.checkinIntervalHours),
      };
    }
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

  async addReminderTimelineEntry(userId: string, entry: { type: string; time: string; detail: string }): Promise<void> {
    const existing = await this.getSettings(userId);
    if (!existing) return;
    const timeline = JSON.parse(existing.reminderTimeline || "[]");
    timeline.push(entry);
    await db.update(settings).set({ reminderTimeline: JSON.stringify(timeline), updatedAt: new Date() }).where(eq(settings.userId, userId));
  }

  async getReminderTimeline(userId: string): Promise<{ type: string; time: string; detail: string }[]> {
    const existing = await this.getSettings(userId);
    if (!existing) return [];
    return JSON.parse(existing.reminderTimeline || "[]");
  }

  async resetReminderState(userId: string): Promise<Settings> {
    const [result] = await db
      .update(settings)
      .set({ 
        remindersSent: 0,
        lastReminderAt: null,
        reminderTimeline: "[]",
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
    return isSubscriptionActive(user) || isTrialActive(user) ? 999 : 2;
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
            linkedUserId: existingMatch.phone === contactData.phone ? existingMatch.linkedUserId : null,
            watcherConsentStatus: existingMatch.phone === contactData.phone ? existingMatch.watcherConsentStatus : "pending",
            watcherConsentRequestedAt: existingMatch.phone === contactData.phone ? existingMatch.watcherConsentRequestedAt : new Date(),
            watcherConsentAcceptedAt: existingMatch.phone === contactData.phone ? existingMatch.watcherConsentAcceptedAt : null,
            watcherConsentDeclinedAt: existingMatch.phone === contactData.phone ? existingMatch.watcherConsentDeclinedAt : null,
            pausedUntil: existingMatch.phone === contactData.phone ? existingMatch.pausedUntil : null,
            pausedBy: existingMatch.phone === contactData.phone ? existingMatch.pausedBy : null,
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
          watcherConsentStatus: "pending",
          watcherConsentRequestedAt: new Date(),
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

  async pauseContact(contactId: string, pausedUntil: Date | null, pausedBy: string): Promise<Contact> {
    const [updated] = await db.update(contacts)
      .set({
        pausedUntil,
        pausedBy: pausedUntil ? pausedBy : null,
      })
      .where(eq(contacts.id, contactId))
      .returning();
    return updated;
  }

  async softDeleteContact(contactId: string, deletedBy: string): Promise<Contact> {
    await db.update(contactTokens)
      .set({ revoked: true })
      .where(eq(contactTokens.contactId, contactId));
    const [updated] = await db.update(contacts)
      .set({ softDeletedAt: new Date(), softDeletedBy: deletedBy, pausedUntil: null, pausedBy: null })
      .where(eq(contacts.id, contactId))
      .returning();
    return updated;
  }

  async restoreContact(contactId: string): Promise<Contact> {
    const [updated] = await db.update(contacts)
      .set({ softDeletedAt: null, softDeletedBy: null, pausedUntil: null, pausedBy: null })
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

  async setSmsOptOutByPhone(phone: string, optedOut: boolean): Promise<{ usersUpdated: number; contactsUpdated: number }> {
    // Set/clear SMS opt-out for any user OR contact row matching this phone.
    // Same number could exist on both sides (a user who is also someone else's
    // emergency contact), so we update both.
    const optedOutAt = optedOut ? new Date() : null;
    const updatedUsers = await db.update(users)
      .set({ smsOptedOut: optedOut, smsOptedOutAt: optedOutAt })
      .where(eq(users.phone, phone))
      .returning({ id: users.id });
    const updatedContacts = await db.update(contacts)
      .set({ smsOptedOut: optedOut, smsOptedOutAt: optedOutAt })
      .where(eq(contacts.phone, phone))
      .returning({ id: contacts.id });
    return { usersUpdated: updatedUsers.length, contactsUpdated: updatedContacts.length };
  }

  async recordSmsDelivery(input: { messageSid: string; toLast4: string; status: string; errorCode: string | null; errorMessage: string | null }): Promise<void> {
    // Twilio does NOT guarantee callback ordering, so we make the upsert
    // monotonic: a stale non-terminal status (queued/sending/sent) must
    // never overwrite a terminal one (delivered/failed/undelivered). We
    // implement this by only updating when the new status has a rank >=
    // the stored rank.
    // Also sanitize errorMessage: Twilio's free-text error sometimes echoes
    // the full E.164 destination, which would defeat our "last4 only" PII
    // minimization. We strip any E.164-looking sequences before storing.
    const sanitizedErrorMessage = input.errorMessage
      ? input.errorMessage.replace(/\+?\d{7,15}/g, "[redacted-phone]").slice(0, 500)
      : null;

    const rank = (s: string): number => {
      switch (s) {
        case "queued": return 1;
        case "accepted": return 1;
        case "scheduled": return 1;
        case "sending": return 2;
        case "sent": return 3;
        case "delivered": return 10;
        case "undelivered": return 10;
        case "failed": return 10;
        default: return 0;
      }
    };

    const existing = await db.select({ status: smsDeliveryLogs.status })
      .from(smsDeliveryLogs)
      .where(eq(smsDeliveryLogs.messageSid, input.messageSid))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(smsDeliveryLogs).values({
        messageSid: input.messageSid,
        toLast4: input.toLast4,
        status: input.status,
        errorCode: input.errorCode,
        errorMessage: sanitizedErrorMessage,
      });
      return;
    }

    if (rank(input.status) < rank(existing[0].status)) {
      // Out-of-order callback for an already-terminal row: ignore.
      return;
    }

    await db.update(smsDeliveryLogs)
      .set({
        status: input.status,
        errorCode: input.errorCode,
        errorMessage: sanitizedErrorMessage,
        updatedAt: new Date(),
      })
      .where(eq(smsDeliveryLogs.messageSid, input.messageSid));
  }

  async accelerateEscalationForFailedSms(phone: string): Promise<number> {
    // Find open incidents whose owner has this phone listed as a contact AND
    // whose escalation flow is actively in progress (we recently notified a
    // contact). We require lastContactNotifiedAt within the last 30 minutes
    // so a failed OTP/reminder/all-clear SMS to an unrelated contact during
    // an unrelated open incident never advances escalation. This is a
    // conservative narrowing; precise per-message attribution requires
    // mapping messageSid -> incidentId at send time and is tracked separately.
    if (!phone) return 0;
    const matchingContacts = await db.select({ userId: contacts.userId })
      .from(contacts)
      .where(eq(contacts.phone, phone));
    if (matchingContacts.length === 0) return 0;
    const userIds = Array.from(new Set(matchingContacts.map(c => c.userId)));
    const now = new Date();
    const recentThreshold = new Date(now.getTime() - 30 * 60 * 1000);
    let accelerated = 0;
    for (const userId of userIds) {
      const open = await this.getOpenIncident(userId);
      if (!open) continue;
      if (!open.lastContactNotifiedAt || open.lastContactNotifiedAt < recentThreshold) {
        continue;
      }
      await db.update(incidents)
        .set({ nextActionAt: now })
        .where(eq(incidents.id, open.id));
      accelerated++;
    }
    return accelerated;
  }

  async isPhoneSmsOptedOut(phone: string): Promise<boolean> {
    // True if the phone matches ANY opted-out row (user or contact).
    const u = await db.select({ id: users.id }).from(users)
      .where(and(eq(users.phone, phone), eq(users.smsOptedOut, true)))
      .limit(1);
    if (u.length > 0) return true;
    const c = await db.select({ id: contacts.id }).from(contacts)
      .where(and(eq(contacts.phone, phone), eq(contacts.smsOptedOut, true)))
      .limit(1);
    return c.length > 0;
  }

  async cleanupExpiredLocationData(): Promise<{
    pointsDeleted: number;
    sharesDeleted: number;
    breadcrumbsDeleted: number;
    tripPointsDeleted: number;
    contextEventsDeleted: number;
    speedAlertsDeleted: number;
    checkinCoordsNulled: number;
    driveSessionCoordsNulled: number;
    safetyTimerCoordsNulled: number;
    safeWalkCoordsNulled: number;
    usersProcessed: number;
  }> {
    // Privacy retention (Batch 5a): the single source of truth for honoring
    // the user's locationDataRetentionDays setting. For every coord-bearing
    // historical table we either delete the row or NULL out the precise
    // coordinate fields once the row is older than the user's cutoff.
    //
    // NEVER touched, regardless of age:
    //   - geofences, familyPlaces (user-saved places, not history)
    //   - safeWalks.destinationLat/Lng (part of the trip definition)
    //   - any active session: live shares with active=true, safetyTimers in
    //     'active'/'grace_period', safeWalks in 'active'/'overdue',
    //     driveSessions with endedAt IS NULL
    //   - users.lastHeartbeatLat/Lng, settings.lastLat/Lng (current state,
    //     overwritten on every write, not history)
    //
    // Per-user iteration honors each user's own retention window.
    const allUsers = await db.select({
      id: users.id,
      retentionDays: users.locationDataRetentionDays,
    }).from(users);

    let pointsDeleted = 0;
    let sharesDeleted = 0;
    let breadcrumbsDeleted = 0;
    let tripPointsDeleted = 0;
    let contextEventsDeleted = 0;
    let speedAlertsDeleted = 0;
    let checkinCoordsNulled = 0;
    let driveSessionCoordsNulled = 0;
    let safetyTimerCoordsNulled = 0;
    let safeWalkCoordsNulled = 0;

    for (const u of allUsers) {
      const days = Math.max(1, u.retentionDays || 30);
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      // 1. liveLocationPoints: delete rows older than cutoff. Active sessions
      //    are protected because only points whose recordedAt < cutoff are
      //    removed; recent points keep being written by an active session.
      const deletedPoints = await db.delete(liveLocationPoints).where(
        and(
          eq(liveLocationPoints.userId, u.id),
          lt(liveLocationPoints.recordedAt, cutoff),
        ),
      ).returning({ id: liveLocationPoints.id });
      pointsDeleted += deletedPoints.length;

      // 2. liveLocationShares: delete rows that are NO LONGER ACTIVE and
      //    whose lastUpdatedAt is older than cutoff. active=true is the
      //    safety guard.
      const deletedShares = await db.delete(liveLocationShares).where(
        and(
          eq(liveLocationShares.userId, u.id),
          eq(liveLocationShares.active, false),
          lt(liveLocationShares.lastUpdatedAt, cutoff),
        ),
      ).returning({ id: liveLocationShares.id });
      sharesDeleted += deletedShares.length;

      // 3. locationBreadcrumbs: delete rows older than cutoff for this user.
      const deletedBreadcrumbs = await db.delete(locationBreadcrumbs).where(
        and(
          eq(locationBreadcrumbs.userId, u.id),
          lt(locationBreadcrumbs.recordedAt, cutoff),
        ),
      ).returning({ id: locationBreadcrumbs.id });
      breadcrumbsDeleted += deletedBreadcrumbs.length;

      // 4. tripPoints: delete rows older than cutoff. tripPoints.tripId/tripType
      //    is a soft reference (no FK) to safetyTimers / safeWalks /
      //    driveSessions, so deleting points does not break parent rows.
      //    Active-session protection: recent points written by a still-active
      //    timer/walk/drive will be newer than cutoff and therefore preserved.
      const deletedTripPoints = await db.delete(tripPoints).where(
        and(
          eq(tripPoints.userId, u.id),
          lt(tripPoints.recordedAt, cutoff),
        ),
      ).returning({ id: tripPoints.id });
      tripPointsDeleted += deletedTripPoints.length;

      // 5. contextEvents (D3): delete rows older than cutoff. Each event is a
      //    coord-anchored dwell/trip start/end with no value once the coord
      //    must be removed.
      const deletedContextEvents = await db.delete(contextEvents).where(
        and(
          eq(contextEvents.userId, u.id),
          lt(contextEvents.createdAt, cutoff),
        ),
      ).returning({ id: contextEvents.id });
      contextEventsDeleted += deletedContextEvents.length;

      // 6. speedAlerts (D3): delete rows older than cutoff.
      const deletedSpeedAlerts = await db.delete(speedAlerts).where(
        and(
          eq(speedAlerts.userId, u.id),
          lt(speedAlerts.createdAt, cutoff),
        ),
      ).returning({ id: speedAlerts.id });
      speedAlertsDeleted += deletedSpeedAlerts.length;

      // 7. checkins (D2-A): preserve the row metadata so the safety audit
      //    trail is intact, but NULL the coord pair on rows older than cutoff.
      //    The "any-coord-present" guard catches partial-coordinate rows
      //    (lat-only or lng-only) so no precise component is ever retained
      //    past the retention window.
      const nulledCheckins = await db.update(checkins).set({
        lat: null,
        lng: null,
      }).where(
        and(
          eq(checkins.userId, u.id),
          lt(checkins.createdAt, cutoff),
          or(isNotNull(checkins.lat), isNotNull(checkins.lng)),
        ),
      ).returning({ id: checkins.id });
      checkinCoordsNulled += nulledCheckins.length;

      // 8. driveSessions (D1-A + D4-Yes): only ENDED sessions older than cutoff
      //    get their coord fields NULLed. endedAt IS NULL = still active =
      //    untouched. Row metadata (speed, distance, crashDetected) preserved
      //    for the weekly receipt-of-protection report. Any-coord-present
      //    guard covers all four lat/lng components so partial-coordinate
      //    rows are not skipped.
      const nulledDrives = await db.update(driveSessions).set({
        startLat: null,
        startLng: null,
        endLat: null,
        endLng: null,
      }).where(
        and(
          eq(driveSessions.userId, u.id),
          isNotNull(driveSessions.endedAt),
          lt(driveSessions.endedAt, cutoff),
          or(
            isNotNull(driveSessions.startLat),
            isNotNull(driveSessions.startLng),
            isNotNull(driveSessions.endLat),
            isNotNull(driveSessions.endLng),
          ),
        ),
      ).returning({ id: driveSessions.id });
      driveSessionCoordsNulled += nulledDrives.length;

      // 9. safetyTimers (D1-A + D4-Yes): only ENDED timers (status in safe /
      //    cancelled / escalated) with resolvedAt older than cutoff get
      //    lastLat/Lng NULLed. Active and grace_period timers are untouched.
      const nulledTimers = await db.update(safetyTimers).set({
        lastLat: null,
        lastLng: null,
      }).where(
        and(
          eq(safetyTimers.userId, u.id),
          inArray(safetyTimers.status, ["safe", "cancelled", "escalated"]),
          isNotNull(safetyTimers.resolvedAt),
          lt(safetyTimers.resolvedAt, cutoff),
          or(isNotNull(safetyTimers.lastLat), isNotNull(safetyTimers.lastLng)),
        ),
      ).returning({ id: safetyTimers.id });
      safetyTimerCoordsNulled += nulledTimers.length;

      // 10. safeWalks (D1-A + D4-Yes): only ENDED walks (status in arrived /
      //     cancelled / escalated) with resolvedAt older than cutoff get
      //     lastLat/Lng NULLed. destinationLat/Lng is preserved (it is the
      //     trip definition, not a history breadcrumb). Active and overdue
      //     walks are untouched.
      const nulledWalks = await db.update(safeWalks).set({
        lastLat: null,
        lastLng: null,
      }).where(
        and(
          eq(safeWalks.userId, u.id),
          inArray(safeWalks.status, ["arrived", "cancelled", "escalated"]),
          isNotNull(safeWalks.resolvedAt),
          lt(safeWalks.resolvedAt, cutoff),
          or(isNotNull(safeWalks.lastLat), isNotNull(safeWalks.lastLng)),
        ),
      ).returning({ id: safeWalks.id });
      safeWalkCoordsNulled += nulledWalks.length;
    }

    return {
      pointsDeleted,
      sharesDeleted,
      breadcrumbsDeleted,
      tripPointsDeleted,
      contextEventsDeleted,
      speedAlertsDeleted,
      checkinCoordsNulled,
      driveSessionCoordsNulled,
      safetyTimerCoordsNulled,
      safeWalkCoordsNulled,
      usersProcessed: allUsers.length,
    };
  }

  async getContactByToken(token: string): Promise<{ contact: Contact; user: User; purpose: string; tokenCreatedAt: Date } | undefined> {
    const [tokenRecord] = await db.select().from(contactTokens).where(
      and(eq(contactTokens.token, token), eq(contactTokens.revoked, false))
    );
    if (!tokenRecord) return undefined;

    // Hard ceiling: regardless of the stored expiry, no watcher token may live
    // longer than 24 hours from the moment it was minted. This caps blast radius
    // for any link sitting in an SMS inbox, screenshot, or backup.
    const HARD_CAP_MS = 24 * 60 * 60 * 1000;
    const createdAt = new Date(tokenRecord.createdAt);
    const hardExpiry = new Date(createdAt.getTime() + HARD_CAP_MS);
    const storedExpiry = tokenRecord.expiresAt ? new Date(tokenRecord.expiresAt) : hardExpiry;
    const effectiveExpiry = storedExpiry < hardExpiry ? storedExpiry : hardExpiry;
    if (effectiveExpiry < new Date()) {
      return undefined;
    }

    const contact = await this.getContact(tokenRecord.contactId);
    if (!contact) return undefined;
    if (contact.softDeletedAt) return undefined;
    if (contact.pausedUntil && new Date(contact.pausedUntil).getTime() > Date.now()) return undefined;

    const user = await this.getUser(contact.userId);
    if (!user) return undefined;

    return {
      contact,
      user,
      purpose: tokenRecord.purpose || "standing",
      tokenCreatedAt: new Date(tokenRecord.createdAt),
    };
  }

  async generateToken(
    contactId: string,
    options?: { ttlHours?: number; purpose?: "standing" | "incident" | "allclear" },
  ): Promise<ContactToken> {
    // Generate a short, URL-safe token (10 characters, mixed case alphanumeric).
    // 54^10 = ~2.6 * 10^17 keyspace, derived from crypto-grade randomBytes.
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let token = '';
    const bytes = randomBytes(10);
    for (let i = 0; i < 10; i++) {
      token += chars[bytes[i] % chars.length];
    }
    // Tokens are capped at 24 hours. Watchers can always be re-issued a fresh
    // link via the next escalation, and old links sitting in inboxes auto-disarm.
    const requestedHours = options?.ttlHours ?? 24;
    const ttlHours = Math.min(Math.max(1, requestedHours), 24);
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
    const purpose = options?.purpose || "standing";
    const [result] = await db.insert(contactTokens).values({
      contactId,
      token,
      revoked: false,
      purpose,
      expiresAt,
    }).returning();
    return result;
  }

  async rotateAllStandingTokensForUser(userId: string): Promise<{ contact: Contact; token: string }[]> {
    // User-initiated panic rotation: revoke every live token across all purposes
    // and mint fresh standing tokens. Used by Settings -> "Rotate watcher links".
    const userContacts = await this.getContacts(userId);
    const out: { contact: Contact; token: string }[] = [];
    const now = new Date();
    for (const contact of userContacts) {
      if (contact.softDeletedAt) continue;
      if (contact.pausedUntil && new Date(contact.pausedUntil).getTime() > now.getTime()) continue;
      await db.update(contactTokens)
        .set({ revoked: true })
        .where(and(eq(contactTokens.contactId, contact.id), eq(contactTokens.revoked, false)));
      const fresh = await this.generateToken(contact.id, { ttlHours: 24, purpose: "standing" });
      out.push({ contact, token: fresh.token });
    }
    return out.sort((a, b) => a.contact.priority - b.contact.priority);
  }

  async revokeAllTokensForUser(userId: string): Promise<void> {
    const userContacts = await this.getContacts(userId);
    for (const contact of userContacts) {
      await db.update(contactTokens)
        .set({ revoked: true })
        .where(and(eq(contactTokens.contactId, contact.id), eq(contactTokens.revoked, false)));
    }
  }

  async regenerateTokensForUser(userId: string): Promise<{ contact: Contact; token: string }[]> {
    // Reuse a contact's most recent standing token only if it's still within the
    // 24h hard cap; otherwise mint a fresh one. We never revoke a token that
    // might be sitting in an inbox, but the 24h cap (enforced in
    // getContactByToken) means an unused token auto-disarms within a day anyway.
    const userContacts = await this.getContacts(userId);
    const result: { contact: Contact; token: string }[] = [];
    const now = new Date();
    const minCreatedAt = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    for (const contact of userContacts) {
      if (contact.softDeletedAt) continue;
      if (contact.pausedUntil && new Date(contact.pausedUntil).getTime() > now.getTime()) continue;
      const [existing] = await db.select().from(contactTokens)
        .where(and(
          eq(contactTokens.contactId, contact.id),
          eq(contactTokens.revoked, false),
          eq(contactTokens.purpose, "standing"),
          gte(contactTokens.expiresAt, now),
          gte(contactTokens.createdAt, minCreatedAt),
        ))
        .orderBy(desc(contactTokens.createdAt))
        .limit(1);
      if (existing) {
        result.push({ contact, token: existing.token });
      } else {
        const tokenRecord = await this.generateToken(contact.id, { ttlHours: 24, purpose: "standing" });
        result.push({ contact, token: tokenRecord.token });
      }
    }
    return result.sort((a, b) => a.contact.priority - b.contact.priority);
  }

  // Phase-2 incident-time token helper. For each non-deleted contact, return
  // an existing non-revoked purpose="incident" token IF it was minted at or
  // after the current incident started AND is still inside the 24h hard cap.
  // Otherwise mint a fresh purpose="incident", 24h-TTL token. This guarantees:
  //   - Fresh-per-incident: tokens from a previous incident are never reused
  //     (the floor is incidentStartedAt, not just the 24h cap).
  //   - Reuse-within-incident: re-sends to the same contact during the same
  //     escalation reuse the same link, avoiding inbox clutter.
  // Caller is responsible for using this only at incident-time send sites;
  // settings/watcher-card flows must continue using regenerateTokensForUser.
  async getOrMintIncidentTokensForUser(
    userId: string,
    incidentStartedAt: Date,
  ): Promise<{ contact: Contact; token: string }[]> {
    const userContacts = await this.getContacts(userId);
    const out: { contact: Contact; token: string }[] = [];
    const now = new Date();
    const HARD_CAP_MS = 24 * 60 * 60 * 1000;
    const minCreatedAt = new Date(now.getTime() - HARD_CAP_MS);
    // The within-incident floor is whichever is later: incidentStartedAt or
    // the 24h cap. In practice the incident is always within 24h of now for
    // any active escalation, so incidentStartedAt wins.
    const incidentFloor = incidentStartedAt > minCreatedAt ? incidentStartedAt : minCreatedAt;
    for (const contact of userContacts) {
      if (contact.softDeletedAt) continue;
      if (contact.pausedUntil && new Date(contact.pausedUntil).getTime() > now.getTime()) continue;
      const [existing] = await db.select().from(contactTokens)
        .where(and(
          eq(contactTokens.contactId, contact.id),
          eq(contactTokens.revoked, false),
          eq(contactTokens.purpose, "incident"),
          gte(contactTokens.createdAt, incidentFloor),
          gte(contactTokens.expiresAt, now),
        ))
        .orderBy(desc(contactTokens.createdAt))
        .limit(1);
      if (existing) {
        out.push({ contact, token: existing.token });
      } else {
        const fresh = await this.generateToken(contact.id, { ttlHours: 24, purpose: "incident" });
        out.push({ contact, token: fresh.token });
      }
    }
    return out.sort((a, b) => a.contact.priority - b.contact.priority);
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

    return checkin;
  }

  async getOpenIncident(userId: string): Promise<Incident | undefined> {
    const [incident] = await db
      .select()
      .from(incidents)
      .where(and(eq(incidents.userId, userId), ne(incidents.status, "resolved")));
    return incident || undefined;
  }

  async getLatestRealOpenIncident(userId: string): Promise<Incident | undefined> {
    const [incident] = await db
      .select()
      .from(incidents)
      .where(and(
        eq(incidents.userId, userId),
        eq(incidents.status, "open"),
        eq(incidents.isDrill, false),
      ))
      .orderBy(desc(incidents.startedAt))
      .limit(1);
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

  async getStaleOpenIncidents(stalenessMs: number): Promise<Incident[]> {
    // Returns incidents that are not resolved AND have not had any escalation
    // activity for at least `stalenessMs`. Used by the cron sweeper to
    // auto-archive incidents that got stuck open (e.g. resolve path failed
    // halfway, watcher claimed but never closed, escalation completed with
    // no resolution). Without this, future SOS presses for the same user are
    // silently swallowed by the dedup logic.
    const cutoff = new Date(Date.now() - stalenessMs);
    const result = await db
      .select()
      .from(incidents)
      .where(
        and(
          ne(incidents.status, "resolved"),
          eq(incidents.isDrill, false),
          or(
            and(
              isNotNull(incidents.lastContactNotifiedAt),
              lt(incidents.lastContactNotifiedAt, cutoff),
            ),
            and(
              isNull(incidents.lastContactNotifiedAt),
              lt(incidents.startedAt, cutoff),
            ),
          ),
        ),
      );
    return result;
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

  async getActiveEmergencyLocationSession(userId: string): Promise<LocationSession | undefined> {
    // Emergency sessions can coexist with other session types (e.g. shift).
    // The generic getActiveLocationSession() returns the first match without
    // filtering by type, so use a type-specific query and prefer the most
    // recently updated row. Expired-but-still-active rows are filtered out
    // so we never surface a stale pin from a dormant incident.
    const now = new Date();
    const [session] = await db
      .select()
      .from(locationSessions)
      .where(and(
        eq(locationSessions.userId, userId),
        eq(locationSessions.active, true),
        eq(locationSessions.type, "emergency"),
      ))
      .orderBy(desc(locationSessions.updatedAt))
      .limit(1);
    if (!session) return undefined;
    if (session.expiresAt && session.expiresAt < now) return undefined;
    return session;
  }

  async createLocationSession(
    userId: string,
    type: LocationSessionType,
    incidentId?: string,
    initialLocation?: { lat: number; lng: number; accuracy?: number | null }
  ): Promise<LocationSession> {
    const now = new Date();
    const [session] = await db.insert(locationSessions).values({
      userId,
      incidentId: incidentId || null,
      type,
      active: true,
      expiresAt: addHours(now, 1),
      lastLat: initialLocation?.lat ?? null,
      lastLng: initialLocation?.lng ?? null,
      lastAccuracy: initialLocation?.accuracy ?? null,
      lastTimestamp: initialLocation ? now : null,
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

    // Calculate next checkin due, anchored to the user's preferred local
    // time-of-day for daily-cadence schedules.
    const nextCheckinDue = computeNextCheckinDue({
      lastTime: lastCheckin?.createdAt || user.createdAt,
      intervalHours: userSettings.checkinIntervalHours,
      preferredCheckinTime: userSettings.preferredCheckinTime,
      timezone: user.timezone,
      lastTimeIsCheckin: !!lastCheckin,
    });

    const contactLimit = await this.getContactLimit(userId);

    const trialEnd = trialEndsAt(user);
    const trialActive = isTrialActive(user);
    const subscriptionActive = isSubscriptionActive(user);

    return {
      user,
      settings: userSettings,
      contacts: userContacts,
      lastCheckin: lastCheckin || null,
      nextCheckinDue,
      openIncident: openIncident || null,
      activeLocationSession: activeLocationSession || null,
      contactLimit,
      isPremium: subscriptionActive || trialActive,
      isTrialActive: trialActive,
      trialEndsAt: trialEnd,
    };
  }

  async getContactPageData(token: string): Promise<ContactPageData | undefined> {
    const result = await this.getContactByToken(token);
    if (!result) return undefined;

    const { contact, user, purpose, tokenCreatedAt } = result;

    // All-clear links are read-only resolution receipts. They never carry
    // location, history, or actions, even if the user later starts a new
    // sharing session. Returning a minimal payload guarantees that.
    if (purpose === "allclear") {
      const [recentResolved] = await db.select().from(incidents)
        .where(and(eq(incidents.userId, user.id), eq(incidents.status, "resolved")))
        .orderBy(desc(incidents.resolvedAt))
        .limit(1);
      return {
        mode: "allclear",
        // Minimal projection: no stable identifiers, no phone/email, no role.
        // The allclear page only needs the subject's first name to display the
        // confirmation; everything else is omitted so a forwarded link cannot
        // be used to fingerprint the user or watcher.
        user: { id: "", name: user.name, phone: null, timezone: user.timezone || null },
        contact: { id: "", name: contact.name, phone: "", email: null, userId: "", priority: 0 } as unknown as Contact,
        lastCheckin: null,
        incident: null,
        locationSession: null,
        handlingContact: null,
        safetyTimer: null,
        safeWalk: null,
        crashDrive: null,
        tripTrail: [],
        resolvedAt: recentResolved?.resolvedAt ? new Date(recentResolved.resolvedAt).toISOString() : null,
      };
    }

    const lastCheckin = await this.getLastCheckin(user.id);
    const incident = await this.getOpenIncident(user.id);
    const locationSession = await this.getActiveLocationSession(user.id);

    // Phase-1 privacy guard: if a watcher opens a non-allclear link AFTER the
    // incident it was issued for has been resolved, strip every live signal
    // and show a resolved-state page. The rule is "the token predates the
    // resolution AND the resolution happened within the last 24h", which
    // matches the alert-era token use case while leaving freshly issued
    // standing watcher-card tokens (minted after the resolution) untouched.
    // Real-incident SMS tokens minted before the resolve will fall through
    // here; the fresh purpose='allclear' link sent in the resolution SMS is
    // unaffected because the allclear branch above returns earlier.
    if (!incident) {
      const HARD_CAP_MS = 24 * 60 * 60 * 1000;
      const recentCutoff = new Date(Date.now() - HARD_CAP_MS);
      const [recentResolved] = await db.select().from(incidents)
        .where(and(
          eq(incidents.userId, user.id),
          eq(incidents.status, "resolved"),
          gte(incidents.resolvedAt, recentCutoff),
        ))
        .orderBy(desc(incidents.resolvedAt))
        .limit(1);
      if (recentResolved?.resolvedAt && tokenCreatedAt < new Date(recentResolved.resolvedAt)) {
        return {
          mode: "resolved",
          // Minimal projection: name only, plus the resolution time.
          user: { id: "", name: user.name, phone: null, timezone: user.timezone || null },
          contact: { id: "", name: contact.name, phone: "", email: null, userId: "", priority: 0 } as unknown as Contact,
          lastCheckin: null,
          incident: null,
          locationSession: null,
          handlingContact: null,
          safetyTimer: null,
          safeWalk: null,
          crashDrive: null,
          tripTrail: [],
          resolvedAt: new Date(recentResolved.resolvedAt).toISOString(),
        };
      }
    }

    let handlingContact: Contact | null = null;
    if (incident?.handledByContactId) {
      handlingContact = (await this.getContact(incident.handledByContactId)) || null;
    }

    let safetyTimer = await this.getActiveSafetyTimer(user.id);
    let safeWalk = await this.getActiveSafeWalk(user.id);
    const recencyCutoff = new Date(Date.now() - 60 * 60 * 1000);
    if (!safetyTimer) {
      const [escalated] = await db.select().from(safetyTimers)
        .where(and(
          eq(safetyTimers.userId, user.id),
          eq(safetyTimers.status, "escalated"),
          or(
            gte(safetyTimers.resolvedAt, recencyCutoff),
            and(isNull(safetyTimers.resolvedAt), gte(safetyTimers.startedAt, recencyCutoff)),
          ),
        ))
        .orderBy(desc(safetyTimers.startedAt)).limit(1);
      if (escalated) safetyTimer = escalated;
    }
    if (!safeWalk) {
      const [escalated] = await db.select().from(safeWalks)
        .where(and(
          eq(safeWalks.userId, user.id),
          eq(safeWalks.status, "escalated"),
          or(
            gte(safeWalks.resolvedAt, recencyCutoff),
            and(isNull(safeWalks.resolvedAt), gte(safeWalks.startedAt, recencyCutoff)),
          ),
        ))
        .orderBy(desc(safeWalks.startedAt)).limit(1);
      if (escalated) safeWalk = escalated;
    }
    let tripTrail: TripPoint[] = [];
    if (safetyTimer) {
      tripTrail = await this.getTripPoints(safetyTimer.id, "timer");
    } else if (safeWalk) {
      tripTrail = await this.getTripPoints(safeWalk.id, "walk");
    }

    let crashDrive: DriveSession | null = null;
    if (!safetyTimer && !safeWalk) {
      const [crashSession] = await db.select().from(driveSessions)
        .where(and(eq(driveSessions.userId, user.id), eq(driveSessions.crashDetected, true)))
        .orderBy(desc(driveSessions.startedAt)).limit(1);
      if (crashSession) {
        const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
        if (new Date(crashSession.startedAt) > hourAgo) {
          crashDrive = crashSession;
          tripTrail = await this.getTripPoints(crashSession.id, "drive");
        }
      }
    }

    const contactCanViewLocation = contact.canViewLocation !== false;
    const hasSafetyLocationReason = !!incident || !!locationSession || !!safetyTimer || !!safeWalk || !!crashDrive;
    const canExposeLocation = contactCanViewLocation && hasSafetyLocationReason;

    const visibleLastCheckin = lastCheckin
      ? {
          ...lastCheckin,
          lat: canExposeLocation ? lastCheckin.lat : null,
          lng: canExposeLocation ? lastCheckin.lng : null,
        }
      : null;
    const visibleSafetyTimer = safetyTimer && !canExposeLocation
      ? { ...safetyTimer, lastLat: null, lastLng: null, lastSpeed: null, lastActivity: null, lastLocationAt: null }
      : safetyTimer;
    const visibleSafeWalk = safeWalk && !canExposeLocation
      ? {
          ...safeWalk,
          destinationLat: null,
          destinationLng: null,
          lastLat: null,
          lastLng: null,
          lastSpeed: null,
          lastActivity: null,
          lastLocationAt: null,
        } as any
      : safeWalk;
    const visibleCrashDrive = crashDrive && !canExposeLocation
      ? { ...crashDrive, startLat: null, startLng: null, endLat: null, endLng: null }
      : crashDrive;

    return {
      mode: "live",
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        timezone: user.timezone || null,
      },
      contact,
      lastCheckin: visibleLastCheckin,
      incident: incident || null,
      locationSession: canExposeLocation ? locationSession || null : null,
      handlingContact,
      safetyTimer: visibleSafetyTimer || null,
      safeWalk: visibleSafeWalk || null,
      crashDrive: visibleCrashDrive || null,
      tripTrail: canExposeLocation ? tripTrail : [],
      resolvedAt: null,
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

      // Check timing — honor the user's preferred local time-of-day so a
      // missed 7pm check-in doesn't fire its reminder at the wrong hour.
      const lastCheckin = await this.getLastCheckin(user.id);
      const lastTime = lastCheckin?.createdAt || user.createdAt;
      const dueTime = computeNextCheckinDue({
        lastTime,
        intervalHours: userSettings.checkinIntervalHours,
        preferredCheckinTime: userSettings.preferredCheckinTime,
        timezone: user.timezone,
        lastTimeIsCheckin: !!lastCheckin,
      });
      const graceTime = new Date(dueTime.getTime() + userSettings.graceMinutes * 60 * 1000);

      if (now > dueTime) {
        // If this due window already produced a missed-checkin incident, do
        // not create another one just because the stale-incident sweeper later
        // archived the open incident. A new missed-checkin flow starts only
        // after the user checks in and creates a new due window.
        const [sameDueIncident] = await db
          .select({ id: incidents.id })
          .from(incidents)
          .where(and(
            eq(incidents.userId, user.id),
            eq(incidents.reason, "missed_checkin"),
            eq(incidents.isDrill, false),
            gte(incidents.startedAt, dueTime),
          ))
          .limit(1);
        if (sameDueIncident) continue;

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
    const now = new Date();
    const minCreatedAt = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    for (const contact of userContacts) {
      if (contact.softDeletedAt) continue;
      if (contact.pausedUntil && new Date(contact.pausedUntil).getTime() > now.getTime()) continue;
      // Only return live, standing tokens still within the 24h hard cap.
      const [tokenRecord] = await db
        .select()
        .from(contactTokens)
        .where(and(
          eq(contactTokens.contactId, contact.id),
          eq(contactTokens.revoked, false),
          eq(contactTokens.purpose, "standing"),
          gte(contactTokens.expiresAt, now),
          gte(contactTokens.createdAt, minCreatedAt),
        ))
        .orderBy(desc(contactTokens.createdAt))
        .limit(1);
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

  async saveMessage(
    senderId: string,
    receiverId: string,
    content: string,
    options?: { messageType?: "user" | "system_alert" | "system_safe" | "system_info"; meta?: Record<string, any> },
  ): Promise<Message> {
    const [msg] = await db.insert(messages).values({
      senderId,
      receiverId,
      content,
      read: false,
      encrypted: false,
      iv: null,
      messageType: options?.messageType ?? "user",
      meta: options?.meta ? JSON.stringify(options.meta) : null,
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

  async getConversations(userId: string): Promise<{ partnerId: string; partnerName: string; lastMessage: string; lastMessageAt: Date; unreadCount: number; lastMessageType: "user" | "system_alert" | "system_safe" | "system_info" }[]> {
    const allMessages = await db.select().from(messages).where(
      or(eq(messages.senderId, userId), eq(messages.receiverId, userId))
    ).orderBy(desc(messages.createdAt));

    const partnerMap = new Map<string, { lastMessage: string; lastMessageAt: Date; unreadCount: number; lastMessageType: "user" | "system_alert" | "system_safe" | "system_info" }>();

    for (const msg of allMessages) {
      const partnerId = msg.senderId === userId ? msg.receiverId : msg.senderId;
      if (!partnerMap.has(partnerId)) {
        const preview = msg.encrypted ? "This message is no longer available" : msg.content;
        partnerMap.set(partnerId, {
          lastMessage: preview,
          lastMessageAt: msg.createdAt,
          unreadCount: 0,
          lastMessageType: (msg.messageType ?? "user") as "user" | "system_alert" | "system_safe" | "system_info",
        });
      }
      if (msg.receiverId === userId && !msg.read) {
        const entry = partnerMap.get(partnerId)!;
        entry.unreadCount++;
      }
    }

    const conversations: { partnerId: string; partnerName: string; lastMessage: string; lastMessageAt: Date; unreadCount: number; lastMessageType: "user" | "system_alert" | "system_safe" | "system_info" }[] = [];
    for (const [partnerId, data] of Array.from(partnerMap)) {
      const partner = await this.getUser(partnerId);
      conversations.push({
        partnerId,
        partnerName: partner?.name || "Unknown",
        lastMessage: data.lastMessage,
        lastMessageAt: data.lastMessageAt,
        unreadCount: data.unreadCount,
        lastMessageType: data.lastMessageType,
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
      .set({
        linkedUserId,
        watcherConsentStatus: linkedUserId ? "accepted" : "pending",
        watcherConsentAcceptedAt: linkedUserId ? new Date() : null,
        watcherConsentDeclinedAt: null,
      })
      .where(eq(contacts.id, contactId))
      .returning();
    return contact;
  }

  async getWatchedUsers(watcherUserId: string): Promise<WatchedUser[]> {
    const watcherUser = await this.getUser(watcherUserId);
    if (!watcherUser?.phone) return [];

    const linkedContacts = await db.select().from(contacts).where(
      and(
        eq(contacts.linkedUserId, watcherUserId),
        eq(contacts.watcherConsentStatus, "accepted"),
        isNull(contacts.softDeletedAt),
      )
    );

    const result: WatchedUser[] = [];

    for (const contact of linkedContacts) {
      const user = await this.getUser(contact.userId);
      if (!user) continue;

      const userSettings = await this.getSettings(user.id);
      const lastCheckin = await this.getLastCheckin(user.id);
      const openIncident = await this.getOpenIncident(user.id);

      const nextCheckinDue = computeNextCheckinDue({
        lastTime: lastCheckin?.createdAt || user.createdAt,
        intervalHours: userSettings?.checkinIntervalHours || 24,
        preferredCheckinTime: userSettings?.preferredCheckinTime,
        timezone: user.timezone,
        lastTimeIsCheckin: !!lastCheckin,
      });

      let lastLocationAt: Date | null = null;
      let lastLocationLat: number | null = null;
      let lastLocationLng: number | null = null;
      let lastLocationAcc: number | null = null;
      let lastActivity: "stationary" | "walking" | "running" | "cycling" | "driving" | null = null;
      let lastSpeed: number | null = null;
      const activeSession = await db.select().from(locationSessions).where(
        and(eq(locationSessions.userId, user.id), eq(locationSessions.active, true))
      ).limit(1);
      if (activeSession.length > 0) {
        lastLocationAt = activeSession[0].updatedAt;
        lastLocationLat = activeSession[0].lastLat;
        lastLocationLng = activeSession[0].lastLng;
        lastLocationAcc = activeSession[0].lastAccuracy ?? null;
      }
      const liveShare = await db.select().from(liveLocationShares).where(
        and(eq(liveLocationShares.userId, user.id), eq(liveLocationShares.active, true))
      ).limit(1);
      if (liveShare.length > 0) {
        lastActivity = (liveShare[0].lastActivity as any) || null;
        lastSpeed = liveShare[0].lastSpeed ?? null;
        if (liveShare[0].lastLat != null && liveShare[0].lastLng != null) {
          if (!lastLocationLat || (liveShare[0].lastUpdatedAt && lastLocationAt && liveShare[0].lastUpdatedAt > lastLocationAt)) {
            lastLocationAt = liveShare[0].lastUpdatedAt;
            lastLocationLat = liveShare[0].lastLat;
            lastLocationLng = liveShare[0].lastLng;
            lastLocationAcc = liveShare[0].lastAccuracy ?? null;
          }
        }
      }

      const activeWalk = await this.getActiveSafeWalk(user.id);

      const mode = (user.sharingMode as "precise" | "area" | "presence" | "paused") || "precise";
      const isConcern = user.safetyState === "concern";
      const hideLocation = contact.canViewLocation === false || ((mode === "presence" || mode === "paused") && !isConcern);
      const obfuscateLocation = mode === "area" && !isConcern;
      const isLearning = user.learningModeUntil ? new Date() < user.learningModeUntil : false;

      let claimedByName: string | null = null;
      if (openIncident?.claimedByContactId) {
        const claimContact = await this.getContact(openIncident.claimedByContactId);
        if (claimContact?.linkedUserId) {
          const claimUser = await this.getUser(claimContact.linkedUserId);
          claimedByName = claimUser?.name || claimContact.name;
        } else if (claimContact) {
          claimedByName = claimContact.name;
        }
      }

      // Prefer the open real (non-drill) incident's wellness call info. Fall
      // back to the most recent incident with a wellnessCallStatus set within
      // the last 6 hours so a "Confirmed safe by call" badge stays visible
      // for a meaningful window after resolution.
      let wellnessCallStatus: "placed" | "safe" | "help" | "no_response" | null = null;
      let wellnessCallAt: Date | null = null;
      if (openIncident && !openIncident.isDrill && openIncident.wellnessCallStatus) {
        wellnessCallStatus = openIncident.wellnessCallStatus as any;
        wellnessCallAt = openIncident.callSentAt || null;
      } else {
        const recentWindowMs = 6 * 60 * 60 * 1000;
        const recentSince = new Date(Date.now() - recentWindowMs);
        const [recentIncident] = await db.select().from(incidents)
          .where(and(
            eq(incidents.userId, user.id),
            eq(incidents.isDrill, false),
            gte(incidents.startedAt, recentSince),
          ))
          .orderBy(desc(incidents.startedAt))
          .limit(1);
        if (recentIncident?.wellnessCallStatus) {
          wellnessCallStatus = recentIncident.wellnessCallStatus as any;
          wellnessCallAt = recentIncident.callSentAt || null;
        }
      }
      let reminderStage: "none" | "push" | "sms" | "calling" | null = null;
      if (openIncident) {
        const step = openIncident.lastEscalationStep;
        reminderStage = step === "call" ? "calling"
          : step === "sms" ? "sms"
          : step === "push" ? "push"
          : "none";
      }

      result.push({
        userId: user.id,
        userName: user.name,
        userTimezone: user.timezone || "Australia/Melbourne",
        lastCheckinAt: lastCheckin?.createdAt || null,
        lastCheckinMethod: lastCheckin?.method || null,
        nextCheckinDue,
        wellnessCallStatus,
        wellnessCallAt,
        reminderStage,
        hasOpenIncident: !!openIncident,
        incidentReason: openIncident?.reason || null,
        incidentId: openIncident?.id || null,
        incidentClaimedBy: claimedByName,
        incidentClaimedAt: openIncident?.claimedAt || null,
        incidentIsDrill: openIncident?.isDrill || false,
        contactId: contact.id,
        circleRole: (contact.circleRole as "primary" | "backup" | "support") || "primary",
        safetyState: user.safetyState as "active" | "quiet" | "concern" | null,
        safetyStateReason: user.safetyStateReason || null,
        safetyStateChangedAt: user.safetyStateChangedAt || null,
        sharingMode: mode,
        lastHeartbeatAt: user.lastHeartbeatAt || null,
        lastHeartbeatLat: hideLocation ? null : obfuscateLocation && user.lastHeartbeatLat ? obfuscateCoord(Number(user.lastHeartbeatLat), user.id + "lat") : (user.lastHeartbeatLat || null),
        lastHeartbeatLng: hideLocation ? null : obfuscateLocation && user.lastHeartbeatLng ? obfuscateCoord(Number(user.lastHeartbeatLng), user.id + "lng") : (user.lastHeartbeatLng || null),
        lastHeartbeatAcc: hideLocation ? null : obfuscateLocation ? null : (user.lastHeartbeatAcc || null),
        lastLocationAt: hideLocation ? null : lastLocationAt,
        lastLocationLat: hideLocation ? null : obfuscateLocation && lastLocationLat ? obfuscateCoord(Number(lastLocationLat), user.id + "lat") : lastLocationLat,
        lastLocationLng: hideLocation ? null : obfuscateLocation && lastLocationLng ? obfuscateCoord(Number(lastLocationLng), user.id + "lng") : lastLocationLng,
        lastLocationAcc: hideLocation ? null : obfuscateLocation ? null : lastLocationAcc,
        lastActivity: hideLocation ? null : lastActivity,
        lastSpeed: hideLocation ? null : lastSpeed,
        batteryLevel: user.batteryLevel ?? null,
        batteryCharging: user.batteryCharging ?? null,
        networkType: user.networkType ?? null,
        lastDeviceStatusAt: user.lastDeviceStatusAt ?? null,
        isInLearningMode: isLearning,
        activeSafeWalk: activeWalk ? {
          destinationName: activeWalk.destinationName,
          expectedArrivalAt: activeWalk.expectedArrivalAt,
          lastSpeed: activeWalk.lastSpeed,
          lastLocationAt: activeWalk.lastLocationAt,
          status: activeWalk.status,
        } : null,
      });
    }

    return result;
  }

  async getContactsLinkedToUser(linkedUserId: string): Promise<Contact[]> {
    return db.select().from(contacts).where(
      and(
        eq(contacts.linkedUserId, linkedUserId),
        eq(contacts.watcherConsentStatus, "accepted"),
        isNull(contacts.softDeletedAt),
      )
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

  async getUserHeartRateConfig(userId: string): Promise<{ monitoring: boolean; alerts: boolean }> {
    const [row] = await db
      .select({
        monitoring: users.heartRateMonitoringEnabled,
        alerts: users.heartRateAlertsEnabled,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return { monitoring: false, alerts: false };
    return { monitoring: !!row.monitoring, alerts: !!row.alerts };
  }

  async setUserHeartRateConfig(
    userId: string,
    config: { monitoring?: boolean; alerts?: boolean },
  ): Promise<{ monitoring: boolean; alerts: boolean }> {
    const updates: Record<string, any> = {};
    if (config.monitoring !== undefined) updates.heartRateMonitoringEnabled = config.monitoring;
    if (config.alerts !== undefined) updates.heartRateAlertsEnabled = config.alerts;
    // Invariant: alerts cannot be on if monitoring is being turned off in this
    // same call. We force alerts=false alongside monitoring=false so a stale
    // alerts=true value can never resurrect after the user reopens monitoring.
    if (config.monitoring === false) updates.heartRateAlertsEnabled = false;
    if (Object.keys(updates).length > 0) {
      await db.update(users).set(updates).where(eq(users.id, userId));
    }
    return this.getUserHeartRateConfig(userId);
  }

  async saveHeartRateReadings(userId: string, readings: { bpm: number; recordedAt: Date; source?: string }[]): Promise<HeartRateReading[]> {
    if (readings.length === 0) return [];
    // Defense in depth: even if a route forgets to gate, never persist HR
    // samples for a user who has not opted in to monitoring.
    const cfg = await this.getUserHeartRateConfig(userId);
    if (!cfg.monitoring) return [];
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

  async recordSatelliteDeviceSeen(id: string): Promise<void> {
    await db.update(satelliteDevices)
      .set({ lastSeenAt: new Date() })
      .where(eq(satelliteDevices.id, id));
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

    const userTz = user.timezone || "UTC";
    const today = startOfDayInTimezone(new Date(), userTz);
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
        time: c.createdAt.toISOString(),
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

  async getDriveSession(id: string): Promise<DriveSession | undefined> {
    const [session] = await db.select().from(driveSessions).where(eq(driveSessions.id, id));
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
      .limit(500);
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

  async getActiveLiveSharesForWatcher(watcherUserId: string): Promise<(LiveLocationShare & { userName: string; safetyState: string; hasSafetyEvent: boolean; safetyStateReason: string | null; incidentReason: string | null; hasOpenIncident: boolean })[]> {
    const watcherContacts = await db.select().from(contacts)
      .where(and(
        eq(contacts.linkedUserId, watcherUserId),
        eq(contacts.watcherConsentStatus, "accepted"),
        isNull(contacts.softDeletedAt)
      ));

    const results: (LiveLocationShare & { userName: string; safetyState: string; hasSafetyEvent: boolean; safetyStateReason: string | null; incidentReason: string | null; hasOpenIncident: boolean })[] = [];
    for (const contact of watcherContacts) {
      if (contact.canViewLocation === false) continue;

      const [share] = await db.select().from(liveLocationShares)
        .where(and(eq(liveLocationShares.userId, contact.userId), eq(liveLocationShares.active, true)))
        .limit(1);
      if (share) {
        const user = await this.getUser(contact.userId);
        if (user) {
          const openIncident = await this.getOpenIncident(contact.userId);
          results.push({
            ...share,
            userName: user.name,
            safetyState: user.safetyState,
            hasSafetyEvent: !!openIncident,
            safetyStateReason: user.safetyStateReason ?? null,
            incidentReason: openIncident?.reason ?? null,
            hasOpenIncident: !!openIncident,
          });
        }
        continue;
      }

      // No explicit live share. Try the cascading fallback: emergency
      // location_session (e.g. SOS) first, then a recent users.lastLat
      // snapshot when there is an open incident. This guarantees a watcher
      // can always see something during an active concern, regardless of
      // which tracking subsystem captured the location.
      const snapshot = await this.getWatcherVisibleSnapshot(contact.userId);
      if (snapshot) {
        const user = await this.getUser(contact.userId);
        if (user) {
          const openIncident = await this.getOpenIncident(contact.userId);
          const virtualShare: LiveLocationShare = {
            id: snapshot.virtualId,
            userId: contact.userId,
            active: true,
            expiresAt: snapshot.expiresAt,
            lastLat: snapshot.lat,
            lastLng: snapshot.lng,
            lastAccuracy: snapshot.accuracy,
            lastSpeed: null,
            lastHeading: null,
            lastActivity: null,
            lastUpdatedAt: snapshot.updatedAt,
            createdAt: snapshot.updatedAt,
          } as LiveLocationShare;
          results.push({
            ...virtualShare,
            userName: user.name,
            safetyState: user.safetyState,
            hasSafetyEvent: !!openIncident,
            safetyStateReason: user.safetyStateReason ?? null,
            incidentReason: openIncident?.reason ?? null,
            hasOpenIncident: !!openIncident,
          });
        }
      }
    }
    return results;
  }

  // Cascading fallback used by both /api/live-location/watching and
  // /api/live-location/trail/:userId when no explicit live_location_share
  // row exists. Returns the most authoritative recent location the watcher
  // is allowed to see, or undefined when nothing is available.
  // Order:
  //   1) Active emergency location_session (e.g. SOS) with fresh lat/lng.
  //   2) users.lastLat snapshot, gated by recency (<= 60 min) and the
  //      subject's sharing mode (precise|area only). Requires an open
  //      incident so we never expose location outside an active concern.
  async getWatcherVisibleSnapshot(userId: string): Promise<{
    virtualId: string;
    lat: number;
    lng: number;
    accuracy: number | null;
    updatedAt: Date;
    expiresAt: Date | null;
    source: "emergency_session" | "user_snapshot";
  } | undefined> {
    const emergencySession = await this.getActiveEmergencyLocationSession(userId);
    if (emergencySession && emergencySession.lastLat != null && emergencySession.lastLng != null) {
      return {
        virtualId: `emergency:${emergencySession.id}`,
        lat: emergencySession.lastLat,
        lng: emergencySession.lastLng,
        accuracy: emergencySession.lastAccuracy ?? null,
        updatedAt: emergencySession.lastTimestamp ?? emergencySession.updatedAt ?? new Date(),
        expiresAt: emergencySession.expiresAt ?? null,
        source: "emergency_session",
      };
    }

    const openIncident = await this.getOpenIncident(userId);
    if (!openIncident) return undefined;

    const user = await this.getUser(userId);
    if (!user || user.lastLat == null || user.lastLng == null || !user.lastLocationAt) return undefined;

    // Respect explicit privacy posture: presence/paused users do not
    // surface coordinates even during a concern.
    if (user.sharingMode !== "precise" && user.sharingMode !== "area") return undefined;

    const ageMs = Date.now() - new Date(user.lastLocationAt).getTime();
    const SNAPSHOT_MAX_AGE_MS = 60 * 60_000; // 60 minutes
    if (ageMs > SNAPSHOT_MAX_AGE_MS) return undefined;

    return {
      virtualId: `snapshot:${userId}`,
      lat: user.lastLat,
      lng: user.lastLng,
      accuracy: null,
      updatedAt: new Date(user.lastLocationAt),
      expiresAt: null,
      source: "user_snapshot",
    };
  }
  // Safety Timer
  async createSafetyTimer(userId: string, durationMinutes: number, note?: string): Promise<SafetyTimer> {
    const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);
    const [timer] = await db.insert(safetyTimers).values({
      userId,
      durationMinutes,
      note: note || null,
      expiresAt,
      status: "active",
    }).returning();
    return timer;
  }

  async getActiveSafetyTimer(userId: string): Promise<SafetyTimer | undefined> {
    const [timer] = await db.select().from(safetyTimers)
      .where(and(
        eq(safetyTimers.userId, userId),
        or(eq(safetyTimers.status, "active"), eq(safetyTimers.status, "grace_period"))
      ))
      .orderBy(desc(safetyTimers.startedAt))
      .limit(1);
    return timer || undefined;
  }

  async getSafetyTimer(id: string): Promise<SafetyTimer | undefined> {
    const [timer] = await db.select().from(safetyTimers).where(eq(safetyTimers.id, id));
    return timer || undefined;
  }

  async updateSafetyTimer(id: string, updates: Partial<SafetyTimer>): Promise<SafetyTimer> {
    const [timer] = await db.update(safetyTimers)
      .set(updates)
      .where(eq(safetyTimers.id, id))
      .returning();
    return timer;
  }

  async getExpiredSafetyTimers(): Promise<SafetyTimer[]> {
    const now = new Date();
    return db.select().from(safetyTimers)
      .where(and(
        eq(safetyTimers.status, "active"),
        lt(safetyTimers.expiresAt, now)
      ));
  }

  // Safe Walk
  async createSafeWalk(userId: string, data: { destinationLat: number; destinationLng: number; destinationName?: string; destinationType: string; expectedArrivalAt: Date; note?: string; arrivalRadiusMeters?: number }): Promise<SafeWalk> {
    const [walk] = await db.insert(safeWalks).values({
      userId,
      destinationLat: data.destinationLat,
      destinationLng: data.destinationLng,
      destinationName: data.destinationName || null,
      destinationType: data.destinationType,
      expectedArrivalAt: data.expectedArrivalAt,
      note: data.note || null,
      arrivalRadiusMeters: data.arrivalRadiusMeters || 200,
      status: "active",
    }).returning();
    return walk;
  }

  async getActiveSafeWalk(userId: string): Promise<SafeWalk | undefined> {
    const [walk] = await db.select().from(safeWalks)
      .where(and(
        eq(safeWalks.userId, userId),
        or(eq(safeWalks.status, "active"), eq(safeWalks.status, "overdue"))
      ))
      .orderBy(desc(safeWalks.startedAt))
      .limit(1);
    return walk || undefined;
  }

  async getSafeWalk(id: string): Promise<SafeWalk | undefined> {
    const [walk] = await db.select().from(safeWalks).where(eq(safeWalks.id, id));
    return walk || undefined;
  }

  async updateSafeWalk(id: string, updates: Partial<SafeWalk>): Promise<SafeWalk> {
    const [walk] = await db.update(safeWalks)
      .set(updates)
      .where(eq(safeWalks.id, id))
      .returning();
    return walk;
  }

  async getOverdueSafeWalks(): Promise<SafeWalk[]> {
    const now = new Date();
    const graceDeadline = new Date(now.getTime() - 10 * 60 * 1000);
    return db.select().from(safeWalks)
      .where(and(
        or(eq(safeWalks.status, "active"), eq(safeWalks.status, "overdue")),
        lt(safeWalks.expectedArrivalAt, graceDeadline)
      ));
  }

  // Trip Points
  async addTripPoint(data: { tripId: string; tripType: string; userId: string; lat: number; lng: number; speed?: number; activity?: string }): Promise<TripPoint> {
    const [point] = await db.insert(tripPoints).values({
      tripId: data.tripId,
      tripType: data.tripType,
      userId: data.userId,
      lat: data.lat,
      lng: data.lng,
      speed: data.speed ?? null,
      activity: data.activity ?? null,
    }).returning();
    return point;
  }

  async getTripPoints(tripId: string, tripType: string): Promise<TripPoint[]> {
    return db.select().from(tripPoints)
      .where(and(
        eq(tripPoints.tripId, tripId),
        eq(tripPoints.tripType, tripType)
      ))
      .orderBy(tripPoints.recordedAt);
  }

  // ===== Family Mode =====
  // INTERNAL helper. Returns the family the user belongs to (as admin or
  // active/active_legacy/pending member) plus a hydrated member list. This is
  // used by the Family page (which needs to show pending invitees to admins)
  // and by `getActiveFamilyForUser` which wraps it with a strict filter.
  // DO NOT use this directly for authorization or for exposing family data on
  // any data route. Use `getActiveFamilyForUser` or
  // `requireActiveFamilyMembership` instead.
  //
  // This helper auto-LINKS pending invites that match the caller's phone
  // (sets userId on the row) but does NOT promote them to "active" — that
  // requires an explicit accept via `acceptFamilyInvite`.
  async getFamilyForUser(userId: string): Promise<FamilyOverview> {
    const me = await this.getUser(userId);
    if (!me) return { family: null, isAdmin: false, members: [] };

    // Auto-link any pending invites that match my phone (so users see their
    // pending invites in the inbox after they sign up). Status stays
    // "pending" until they explicitly accept.
    if (me.phone) {
      const linked = await db.update(familyMembers)
        .set({ userId: me.id, updatedAt: new Date() })
        .where(and(
          eq(familyMembers.invitePhone, me.phone),
          isNull(familyMembers.userId),
          // Only link rows that are still awaiting consent. Never resurrect
          // declined or removed rows.
          inArray(familyMembers.status, ["pending", "invited"]),
        ))
        .returning({ id: familyMembers.id });
      if (linked.length > 0) {
        console.log(`[INVITE] Linked existing user to ${linked.length} pending invite${linked.length === 1 ? "" : "s"} (user:${me.id.slice(0, 8)})`);
      }
    }

    // Find a family I admin OR a family where I have an effectively-active
    // membership row. Pending-only membership does NOT confer family access;
    // it goes through the invitations inbox path instead.
    const [adminedFam] = await db.select().from(families)
      .where(eq(families.adminUserId, userId)).limit(1);

    let family: Family | null = adminedFam ?? null;
    if (!family) {
      const memberRows = await db.select().from(familyMembers)
        .where(and(
          eq(familyMembers.userId, userId),
          ne(familyMembers.status, "removed"),
          ne(familyMembers.status, "declined"),
        ));
      // Pick the first effectively-active membership, if any.
      const activeMember = memberRows.find((r) => isEffectivelyActiveFamilyMember(r));
      if (activeMember) {
        const [fam] = await db.select().from(families)
          .where(eq(families.id, activeMember.familyId)).limit(1);
        family = fam ?? null;
      }
    }

    if (!family) return { family: null, isAdmin: false, members: [] };

    const isAdmin = family.adminUserId === userId;
    // Admins see everyone (including pending) so they can manage invitations
    // from the Family page. Non-admin members see only effectively-active
    // members so pending invitees never appear in their member list.
    const allRows = await db.select().from(familyMembers)
      .where(and(
        eq(familyMembers.familyId, family.id),
        ne(familyMembers.status, "removed"),
        ne(familyMembers.status, "declined"),
      ));
    const rows = isAdmin
      ? allRows
      : allRows.filter((r) => isEffectivelyActiveFamilyMember(r));

    // Apply the same sharing-mode redaction as for regular members so the
    // admin's own location respects their `paused`/`presence`/`area` choice.
    const redactLocation = (
      mode: string | null | undefined,
      seedId: string,
      lat: number | null,
      lng: number | null,
    ): { lat: number | null; lng: number | null } => {
      if (mode === "paused" || mode === "presence") return { lat: null, lng: null };
      if (mode === "area" && lat != null && lng != null) {
        const seed = (seedId || "").charCodeAt(0) || 1;
        const offsetLat = (((seed * 37) % 100) / 10000) - 0.005;
        const offsetLng = (((seed * 53) % 100) / 10000) - 0.005;
        return { lat: lat + offsetLat, lng: lng + offsetLng };
      }
      return { lat, lng };
    };

    // Always include the admin as an implicit "active" member view
    const memberViews: FamilyMemberView[] = [];
    const adminUser = await this.getUser(family.adminUserId);
    if (adminUser) {
      const adminMode = (adminUser as any).sharingMode || "precise";
      const adminLoc = redactLocation(
        adminMode,
        adminUser.id,
        (adminUser as any).lastHeartbeatLat ?? null,
        (adminUser as any).lastHeartbeatLng ?? null,
      );
      memberViews.push({
        id: `admin:${adminUser.id}`,
        userId: adminUser.id,
        name: adminUser.name || "Admin",
        nickname: null,
        phone: adminUser.phone || null,
        role: "admin",
        status: "active",
        sharingMode: adminMode,
        parentalConsentRequired: false,
        parentalConsentGranted: true,
        isAdmin: true,
        safetyState: ((adminUser as any).safetyState as any) || null,
        lastSeenAt: (adminUser as any).lastHeartbeatAt || null,
        lastLat: adminLoc.lat,
        lastLng: adminLoc.lng,
        lastAccuracy: adminMode === "precise" ? ((adminUser as any).lastHeartbeatAcc ?? null) : null,
        lastActivity: (adminUser as any).lastActivity ?? null,
        hasActiveIncident: false,
        timezone: (adminUser as any).timezone || null,
      });
    }

    for (const row of rows) {
      let name = row.inviteName || "Pending invite";
      let phone = row.invitePhone || null;
      let safetyState: any = null;
      let lastSeenAt: Date | null = null;
      let lastLat: number | null = null;
      let lastLng: number | null = null;
      let lastAccuracy: number | null = null;
      let lastActivity: any = null;
      let timezone: string | null = null;
      let resolvedSharingMode: any = row.sharingMode;

      // CRITICAL CONSENT GATE: only effectively-active members hydrate any
      // location, presence, or safety data. Pending and active_legacy-expired
      // rows show only their invite name/phone so the inviter can manage the
      // invitation, never their location or safety state.
      const exposeMemberData = isEffectivelyActiveFamilyMember(row);

      if (row.userId && exposeMemberData) {
        const u = await this.getUser(row.userId);
        if (u) {
          name = u.name || name;
          phone = u.phone || phone;
          safetyState = (u as any).safetyState || null;
          lastSeenAt = (u as any).lastHeartbeatAt || null;
          lastLat = (u as any).lastHeartbeatLat ?? null;
          lastLng = (u as any).lastHeartbeatLng ?? null;
          lastAccuracy = (u as any).lastHeartbeatAcc ?? null;
          lastActivity = (u as any).lastActivity ?? null;
          timezone = (u as any).timezone || null;
          resolvedSharingMode = row.sharingMode;

          // Honor the family-scoped sharing mode for this member's location.
          const memberLoc = redactLocation(resolvedSharingMode, row.userId || "", lastLat, lastLng);
          lastLat = memberLoc.lat;
          lastLng = memberLoc.lng;
          if (resolvedSharingMode !== "precise") lastAccuracy = null;
        }
      } else if (row.userId) {
        // Pending invitee already has an account — show their display name so
        // the inviter sees "Pending: Sarah Smith" instead of the raw invite
        // name they typed. No location, no safety state, no presence.
        const u = await this.getUser(row.userId);
        if (u) {
          name = u.name || name;
          phone = u.phone || phone;
        }
      }

      memberViews.push({
        id: row.id,
        userId: row.userId,
        name,
        nickname: row.nickname || null,
        phone,
        // Surface the EFFECTIVE status to the UI so the client can render
        // "Pending" for both fresh pending and expired active_legacy rows.
        status: effectiveFamilyStatus(row) as FamilyMemberStatus,
        role: row.role as FamilyRole,
        sharingMode: resolvedSharingMode,
        parentalConsentRequired: row.parentalConsentRequired,
        parentalConsentGranted: row.parentalConsentGranted,
        isAdmin: false,
        safetyState,
        lastSeenAt,
        lastLat,
        lastLng,
        lastAccuracy,
        lastActivity,
        hasActiveIncident: false,
        timezone,
      });
    }

    return { family, isAdmin, members: memberViews };
  }

  // STRICT helper. Use this on every data route that exposes family info,
  // location, presence, safety state, chat, places, schedules, panic, pulse,
  // map payloads, watcher reports, geofence sharing, or notifications.
  // Returns members in `active` or in-window `active_legacy` state only.
  // Pending invitations never appear here.
  async getActiveFamilyForUser(userId: string): Promise<FamilyOverview> {
    const overview = await this.getFamilyForUser(userId);
    return {
      ...overview,
      members: overview.members.filter(
        (m) => m.status === "active" || m.status === "active_legacy" || m.isAdmin,
      ),
    };
  }

  // Throws on no-access. Returns the effectively-active member row, or
  // `{ isAdmin: true }` when the caller is the family admin (admin doesn't
  // have a family_members row of their own).
  async requireActiveFamilyMembership(
    userId: string,
    familyId: string,
  ): Promise<FamilyMember | { isAdmin: true }> {
    const [fam] = await db.select().from(families).where(eq(families.id, familyId)).limit(1);
    if (!fam) {
      const e: any = new Error("family_not_found");
      e.status = 404;
      throw e;
    }
    if (fam.adminUserId === userId) return { isAdmin: true };

    const [row] = await db.select().from(familyMembers)
      .where(and(
        eq(familyMembers.familyId, familyId),
        eq(familyMembers.userId, userId),
      ))
      .limit(1);
    if (!row || !isEffectivelyActiveFamilyMember(row)) {
      const e: any = new Error("not_in_family");
      e.status = 403;
      throw e;
    }
    return row;
  }

  // Inbox helper. Returns minimal data — no family chat, no places, no map.
  // Just enough for the invitee to recognize who invited them and decide.
  // Auto-links pending invites that match the caller's phone (so newly
  // signed-up users see their inbox immediately).
  async getPendingInvitationsForUser(userId: string): Promise<PendingFamilyInvitation[]> {
    const me = await this.getUser(userId);
    if (!me) return [];

    if (me.phone) {
      await db.update(familyMembers)
        .set({ userId: me.id, updatedAt: new Date() })
        .where(and(
          eq(familyMembers.invitePhone, me.phone),
          isNull(familyMembers.userId),
          inArray(familyMembers.status, ["pending", "invited"]),
        ));
    }

    // STRICTLY pending invitations only. Per the locked Round 3 contract,
    // /api/family/invitations is the inbox of invites awaiting the invitee's
    // explicit accept. In-window active_legacy rows already have visibility
    // and are surfaced through a separate re-confirm flow on the family
    // overview, not through this endpoint, so the API contract stays
    // unambiguous (pending = needs accept).
    const rows = await db.select().from(familyMembers)
      .where(and(
        eq(familyMembers.userId, userId),
        inArray(familyMembers.status, ["pending", "invited"]),
      ));

    const out: PendingFamilyInvitation[] = [];
    for (const row of rows) {
      const eff = effectiveFamilyStatus(row);
      if (eff !== "pending") continue;
      const [fam] = await db.select().from(families).where(eq(families.id, row.familyId)).limit(1);
      if (!fam) continue;
      const inviter = row.invitedBy ? await this.getUser(row.invitedBy) : null;
      const adminUser = await this.getUser(fam.adminUserId);
      out.push({
        memberId: row.id,
        familyId: fam.id,
        familyName: fam.name,
        inviterUserId: row.invitedBy || fam.adminUserId,
        inviterName: inviter?.name || adminUser?.name || "A StillHere user",
        role: row.role as FamilyRole,
        invitedAt: row.invitedAt || row.createdAt,
        legacyConfirmDeadline: row.legacyConfirmDeadline,
        isLegacyReconfirm: row.status === "active_legacy",
      });
    }
    return out;
  }

  // Single state-machine transition for the consent gate. The accept/decline
  // routes are the ONLY callers that can move a row into `active` / `declined`
  // through the consent flow. Admin PATCH /api/family/member/:id is no longer
  // allowed to set status directly to `active`, `pending`, or `declined`.
  async acceptFamilyInvite(memberId: string, userId: string): Promise<FamilyMember> {
    const me = await this.getUser(userId);
    if (!me) {
      const e: any = new Error("not_authenticated"); e.status = 401; throw e;
    }
    const [row] = await db.select().from(familyMembers).where(eq(familyMembers.id, memberId)).limit(1);
    if (!row) {
      const e: any = new Error("invite_not_found"); e.status = 404; throw e;
    }
    // Auth: the row must already be linked to me, OR its invite phone must
    // match my verified phone (we link it on accept in that case).
    const myRow = row.userId === userId;
    const myPhone = !!(me.phone && row.invitePhone && row.invitePhone === me.phone);
    if (!myRow && !myPhone) {
      const e: any = new Error("forbidden"); e.status = 403; throw e;
    }
    // Only pending or active_legacy can be accepted.
    if (row.status !== "pending" && row.status !== "invited" && row.status !== "active_legacy") {
      const e: any = new Error(`cannot_accept_status:${row.status}`); e.status = 409; throw e;
    }
    const [updated] = await db.update(familyMembers)
      .set({
        status: "active",
        userId: userId,
        acceptedAt: new Date(),
        legacyConfirmDeadline: null,
        updatedAt: new Date(),
      })
      .where(eq(familyMembers.id, memberId))
      .returning();
    return updated;
  }

  async declineFamilyInvite(memberId: string, userId: string): Promise<FamilyMember> {
    const me = await this.getUser(userId);
    if (!me) {
      const e: any = new Error("not_authenticated"); e.status = 401; throw e;
    }
    const [row] = await db.select().from(familyMembers).where(eq(familyMembers.id, memberId)).limit(1);
    if (!row) {
      const e: any = new Error("invite_not_found"); e.status = 404; throw e;
    }
    const myRow = row.userId === userId;
    const myPhone = !!(me.phone && row.invitePhone && row.invitePhone === me.phone);
    if (!myRow && !myPhone) {
      const e: any = new Error("forbidden"); e.status = 403; throw e;
    }
    if (row.status !== "pending" && row.status !== "invited" && row.status !== "active_legacy") {
      const e: any = new Error(`cannot_decline_status:${row.status}`); e.status = 409; throw e;
    }
    const [updated] = await db.update(familyMembers)
      .set({
        status: "declined",
        userId: row.userId || userId,
        declinedAt: new Date(),
        legacyConfirmDeadline: null,
        updatedAt: new Date(),
      })
      .where(eq(familyMembers.id, memberId))
      .returning();
    return updated;
  }

  // One-shot, idempotent backfill run on server boot. Also doubles as the
  // expiry sweeper for active_legacy rows whose deadline has passed.
  async backfillFamilyConsent(): Promise<{ legacyMarked: number; pendingMarked: number; expiredDowngraded: number }> {
    const deadline = new Date(Date.now() + LEGACY_CONFIRM_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const now = new Date();

    // 1) Pre-consent rows that were auto-active become active_legacy with a
    //    21-day deadline. Pre-consent is identified by `acceptedAt IS NULL`,
    //    which is the canonical marker (post-consent accept paths always set
    //    acceptedAt). Idempotent and safe across reboots: post-consent
    //    members keep `status="active"` because they have acceptedAt set.
    const legacyMarked = await db.update(familyMembers)
      .set({ status: "active_legacy", legacyConfirmDeadline: deadline, updatedAt: now })
      .where(and(
        eq(familyMembers.status, "active"),
        isNull(familyMembers.acceptedAt),
      ))
      .returning({ id: familyMembers.id });

    // 2) Old "invited" rows (no account yet) become "pending" so the new
    //    accept/decline UI handles them uniformly.
    const pendingMarked = await db.update(familyMembers)
      .set({ status: "pending", invitedAt: now, updatedAt: now })
      .where(eq(familyMembers.status, "invited"))
      .returning({ id: familyMembers.id });

    // 3) Expiry sweep: any active_legacy whose deadline has passed is
    //    downgraded to pending so visibility stops. The helper layer also
    //    treats expired active_legacy as pending in real-time, so this is
    //    cleanup, not a security boundary.
    const expiredDowngraded = await db.update(familyMembers)
      .set({ status: "pending", legacyConfirmDeadline: null, updatedAt: now })
      .where(and(
        eq(familyMembers.status, "active_legacy"),
        lte(familyMembers.legacyConfirmDeadline, now),
      ))
      .returning({ id: familyMembers.id });

    return {
      legacyMarked: legacyMarked.length,
      pendingMarked: pendingMarked.length,
      expiredDowngraded: expiredDowngraded.length,
    };
  }

  async createFamily(adminUserId: string, name: string): Promise<Family> {
    const [fam] = await db.insert(families).values({
      adminUserId,
      name: name.trim() || "My Family",
    }).returning();
    return fam;
  }

  async inviteFamilyMember(params: {
    familyId: string;
    invitedBy: string;
    name: string;
    phone: string;
    role: FamilyRole;
    parentalConsentRequired: boolean;
  }): Promise<FamilyMember> {
    // Defense-in-depth (Batch 3): refuse to insert teen/child rows even if a
    // future caller forgets the API-layer guard. StillHere v1 is 13+; under-13
    // accounts are not supported and there is no parental-consent flow.
    if (params.role === "teen" || params.role === "child") {
      throw new Error("role_not_supported: teen/child roles are not allowed in v1");
    }
    // Dedupe: if this phone (or its linked user) is already a non-removed
    // and non-declined member of this family, return the existing row instead
    // of inserting a duplicate. Prevents repeat-click SMS spam and duplicate
    // cards. Declined rows are checked separately for the 24h cooldown.
    const existing = await this.getUserByPhone(params.phone);
    const allRows = await db.select().from(familyMembers).where(
      and(
        eq(familyMembers.familyId, params.familyId),
        ne(familyMembers.status, "removed"),
      ),
    );

    // Anti-harassment cooldown: if the same phone declined an invite from
    // this family within the last 24h, refuse the new invite.
    const declinedRecently = allRows.find(
      (m) =>
        m.status === "declined" &&
        (m.invitePhone === params.phone || (existing && m.userId === existing.id)) &&
        m.declinedAt &&
        Date.now() - m.declinedAt.getTime() < DECLINE_REINVITE_COOLDOWN_MS,
    );
    if (declinedRecently) {
      const e: any = new Error("decline_cooldown");
      e.status = 429;
      e.retryAfterMs =
        DECLINE_REINVITE_COOLDOWN_MS - (Date.now() - declinedRecently.declinedAt!.getTime());
      throw e;
    }

    // Dedupe (only against non-declined rows).
    const existingDup = allRows.find(
      (m) =>
        m.status !== "declined" &&
        (m.invitePhone === params.phone || (existing && m.userId === existing.id)),
    );
    if (existingDup) return existingDup;

    // Consent fix: ALWAYS create as `pending`, even when the invitee already
    // has a StillHere account. The invitee must explicitly accept via the
    // invitations inbox before any of their family/safety/location data is
    // exposed to the inviter.
    const [row] = await db.insert(familyMembers).values({
      familyId: params.familyId,
      userId: existing?.id || null,
      invitePhone: params.phone,
      inviteName: params.name,
      role: params.role,
      status: "pending",
      sharingMode: "precise",
      parentalConsentRequired: params.parentalConsentRequired,
      parentalConsentGranted: !params.parentalConsentRequired,
      invitedBy: params.invitedBy,
      invitedAt: new Date(),
    }).returning();
    return row;
  }

  async getFamilyMember(memberId: string): Promise<FamilyMember | undefined> {
    const [row] = await db.select().from(familyMembers).where(eq(familyMembers.id, memberId));
    return row;
  }

  async updateFamilyMember(memberId: string, updates: Partial<{
    role: FamilyRole;
    status: FamilyMemberStatus;
    sharingMode: "precise" | "area" | "presence" | "paused";
    parentalConsentGranted: boolean;
    parentalConsentRequired: boolean;
    nickname: string | null;
  }>): Promise<FamilyMember> {
    // Defense-in-depth (Batch 3): refuse to set teen/child role on any
    // existing row. Existing rows with these roles can still be READ; they
    // just can't be re-saved as teen/child or freshly assigned that role.
    if (updates.role === "teen" || updates.role === "child") {
      throw new Error("role_not_supported: teen/child roles are not allowed in v1");
    }
    // Consent fix: status transitions through the consent state machine
    // (`pending` ↔ `active` ↔ `declined` ↔ `active_legacy`) MUST go through
    // `acceptFamilyInvite`, `declineFamilyInvite`, `removeFamilyMember`, or
    // the backfill helper. Admin PATCH may only `paused` an active member or
    // unpause back to `active`. Direct writes to consent states are blocked
    // here as defense-in-depth even if a route forgets the guard.
    if (updates.status !== undefined) {
      const allowed = new Set(["active", "paused"]);
      if (!allowed.has(updates.status)) {
        throw new Error(`status_transition_not_allowed:${updates.status}`);
      }
    }
    const [row] = await db.update(familyMembers)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(familyMembers.id, memberId))
      .returning();
    if (!row) throw new Error("Family member not found");
    return row;
  }

  async removeFamilyMember(memberId: string): Promise<void> {
    await db.update(familyMembers)
      .set({ status: "removed", updatedAt: new Date() })
      .where(eq(familyMembers.id, memberId));
  }

  // Hard-delete a whole family (admin only - enforced at the route layer).
  // Cascades remove members and messages via FK ON DELETE CASCADE.
  async deleteFamily(familyId: string): Promise<void> {
    await db.delete(families).where(eq(families.id, familyId));
  }

  // ---- Family Chat ----
  async saveFamilyMessage(params: {
    familyId: string;
    senderId: string | null;
    body: string;
    kind?: "user" | "pulse" | "panic" | "system";
    meta?: Record<string, any>;
  }): Promise<FamilyMessage> {
    const [row] = await db.insert(familyMessages).values({
      familyId: params.familyId,
      senderId: params.senderId ?? null,
      body: params.body,
      kind: params.kind || "user",
      meta: params.meta ? JSON.stringify(params.meta) : null,
    }).returning();
    return row;
  }

  async getFamilyMessages(familyId: string, limit: number = 100): Promise<FamilyMessage[]> {
    const rows = await db.select().from(familyMessages)
      .where(eq(familyMessages.familyId, familyId))
      .orderBy(desc(familyMessages.createdAt))
      .limit(limit);
    return rows.reverse(); // oldest first for chat display
  }

  // Active member user-ids for a family - used to fan out socket events,
  // push notifications, and chat broadcasts. Includes effectively-active
  // members (active + in-window active_legacy). Pending and expired-legacy
  // members never receive family broadcasts.
  async getActiveFamilyUserIds(familyId: string): Promise<string[]> {
    const rows = await db.select().from(familyMembers)
      .where(and(
        eq(familyMembers.familyId, familyId),
        inArray(familyMembers.status, ["active", "active_legacy"]),
      ));
    return rows
      .filter((r) => isEffectivelyActiveFamilyMember(r))
      .map((r) => r.userId)
      .filter((u): u is string => !!u);
  }

  // ---- Family Places (Home / School / Work) ----
  async getFamilyPlaces(familyId: string): Promise<FamilyPlace[]> {
    return db.select().from(familyPlaces)
      .where(eq(familyPlaces.familyId, familyId))
      .orderBy(familyPlaces.createdAt);
  }

  async createFamilyPlace(params: {
    familyId: string;
    name: string;
    icon: string;
    lat: number;
    lng: number;
    radiusMeters: number;
    createdByUserId: string;
  }): Promise<FamilyPlace> {
    const [row] = await db.insert(familyPlaces).values(params).returning();
    return row;
  }

  async deleteFamilyPlace(placeId: string, familyId: string): Promise<void> {
    await db.delete(familyPlaces)
      .where(and(eq(familyPlaces.id, placeId), eq(familyPlaces.familyId, familyId)));
  }

  // ---- Family Place Schedules (per-member expectations like "Sarah at School Mon-Fri 8:30-15:30") ----
  async getFamilyPlaceSchedules(familyId: string) {
    return db.select().from(familyPlaceSchedules)
      .where(eq(familyPlaceSchedules.familyId, familyId))
      .orderBy(familyPlaceSchedules.createdAt);
  }

  async createFamilyPlaceSchedule(params: {
    familyId: string;
    placeId: string;
    memberId: string;
    daysOfWeek: string;
    expectedStartMinutes: number;
    expectedEndMinutes: number;
    graceMinutes: number;
    createdByUserId: string;
  }) {
    const [row] = await db.insert(familyPlaceSchedules).values(params).returning();
    return row;
  }

  async deleteFamilyPlaceSchedule(scheduleId: string, familyId: string): Promise<void> {
    await db.delete(familyPlaceSchedules)
      .where(and(eq(familyPlaceSchedules.id, scheduleId), eq(familyPlaceSchedules.familyId, familyId)));
  }

  async markScheduleAlerted(scheduleId: string, dateStr: string): Promise<void> {
    await db.update(familyPlaceSchedules)
      .set({ lastAlertedDate: dateStr })
      .where(eq(familyPlaceSchedules.id, scheduleId));
  }

  // Returns every active schedule across every family (used by the cron evaluator)
  async getAllActiveFamilyPlaceSchedules() {
    return db.select().from(familyPlaceSchedules)
      .where(eq(familyPlaceSchedules.active, true));
  }
}

export const storage = new DatabaseStorage();
