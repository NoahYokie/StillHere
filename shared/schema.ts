import { z } from "zod";

// User
export interface User {
  id: string;
  name: string;
  phone: string | null;
  timezone: string;
  createdAt: Date;
}

export const insertUserSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  timezone: z.string().default("Australia/Melbourne"),
});

export type InsertUser = z.infer<typeof insertUserSchema>;

// Settings
export const locationModeSchema = z.enum(["off", "emergency_only", "on_shift_only"]);
export type LocationMode = z.infer<typeof locationModeSchema>;

export interface Settings {
  userId: string;
  checkinIntervalHours: number;
  graceMinutes: number;
  locationMode: LocationMode;
  pauseUntil: Date | null;
  updatedAt: Date;
}

export const insertSettingsSchema = z.object({
  checkinIntervalHours: z.number().min(1).max(72).default(24),
  graceMinutes: z.number().min(5).max(60).default(15),
  locationMode: locationModeSchema.default("off"),
  pauseUntil: z.date().nullable().optional(),
});

export type InsertSettings = z.infer<typeof insertSettingsSchema>;

// Contact
export interface Contact {
  id: string;
  userId: string;
  name: string;
  phone: string;
  priority: 1 | 2;
  canViewLocation: boolean;
  createdAt: Date;
}

export const insertContactSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  priority: z.union([z.literal(1), z.literal(2)]),
  canViewLocation: z.boolean().default(true),
});

export type InsertContact = z.infer<typeof insertContactSchema>;

// Contact Token
export interface ContactToken {
  id: string;
  contactId: string;
  token: string;
  revoked: boolean;
  createdAt: Date;
}

// Checkin
export interface Checkin {
  id: string;
  userId: string;
  method: "button";
  createdAt: Date;
}

// Incident
export const incidentStatusSchema = z.enum(["open", "paused", "resolved"]);
export type IncidentStatus = z.infer<typeof incidentStatusSchema>;

export const incidentReasonSchema = z.enum(["missed_checkin", "sos", "test"]);
export type IncidentReason = z.infer<typeof incidentReasonSchema>;

export interface Incident {
  id: string;
  userId: string;
  status: IncidentStatus;
  reason: IncidentReason;
  startedAt: Date;
  resolvedAt: Date | null;
  handledByContactId: string | null;
  nextActionAt: Date | null;
}

// Location Session
export const locationSessionTypeSchema = z.enum(["emergency", "shift"]);
export type LocationSessionType = z.infer<typeof locationSessionTypeSchema>;

export interface LocationSession {
  id: string;
  userId: string;
  incidentId: string | null;
  type: LocationSessionType;
  active: boolean;
  expiresAt: Date;
  lastLat: number | null;
  lastLng: number | null;
  lastAccuracy: number | null;
  lastTimestamp: Date | null;
  updatedAt: Date;
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
