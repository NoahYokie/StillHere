import { db } from "./db";
import { storage } from "./storage";
import {
  driveSessions,
  incidents,
  locationSessions,
  safeWalks,
  safetyTimers,
} from "@shared/schema";
import { and, desc, eq, gt, gte, inArray, isNull, or } from "drizzle-orm";
import { emitToUser } from "./socket";

export type TrackingPolicyReason =
  | "ok"
  | "auth"
  | "paused"
  | "location_off"
  | "emergency_only_no_incident"
  | "on_shift_only_off_shift"
  | "presence_no_active_purpose"
  | "no_active_session"
  | "expired"
  | "server_error";

export type ActivePurpose =
  | "liveShare"
  | "safeWalk"
  | "driveSafety"
  | "safetyTimer"
  | "incident"
  | "emergencySession"
  | "activeShift"
  | "ongoingConsent";

export interface TrackingPolicy {
  active: boolean;
  nativeTrackingAllowed: boolean;
  heartbeatAllowed: boolean;
  sharingMode: "precise" | "area" | "presence" | "paused";
  locationMode: "off" | "emergency_only" | "on_shift_only" | "both";
  activePurposes: ActivePurpose[];
  sessions: {
    liveShare: { active: boolean; expiresAt: string | null };
    safeWalk: { active: boolean; expiresAt: string | null };
    driveSafety: { active: boolean };
    safetyTimer: { active: boolean; expiresAt: string | null };
    incident: { active: boolean; reason: string | null };
    emergencySession: { active: boolean; expiresAt: string | null };
    shift: { active: boolean; expiresAt: string | null };
  };
  graceWindowSeconds: number;
  reason: TrackingPolicyReason;
}

const DRIVE_STALENESS_HOURS = 24;
const GRACE_WINDOW_SECONDS = 300;

function emptyPolicy(
  sharingMode: TrackingPolicy["sharingMode"],
  locationMode: TrackingPolicy["locationMode"],
  reason: TrackingPolicyReason,
  heartbeatAllowed: boolean,
): TrackingPolicy {
  return {
    active: false,
    nativeTrackingAllowed: false,
    heartbeatAllowed,
    sharingMode,
    locationMode,
    activePurposes: [],
    sessions: {
      liveShare: { active: false, expiresAt: null },
      safeWalk: { active: false, expiresAt: null },
      driveSafety: { active: false },
      safetyTimer: { active: false, expiresAt: null },
      incident: { active: false, reason: null },
      emergencySession: { active: false, expiresAt: null },
      shift: { active: false, expiresAt: null },
    },
    graceWindowSeconds: GRACE_WINDOW_SECONDS,
    reason,
  };
}

export async function getTrackingPolicyForUser(userId: string | null | undefined): Promise<TrackingPolicy> {
  if (!userId) {
    return emptyPolicy("precise", "off", "auth", false);
  }

  try {
    const user = await storage.getUser(userId);
    if (!user) {
      return emptyPolicy("precise", "off", "auth", false);
    }

    const settings = await storage.getSettings(userId);
    const sharingMode = ((user as any).sharingMode || "precise") as TrackingPolicy["sharingMode"];
    const locationMode = (settings?.locationMode || "off") as TrackingPolicy["locationMode"];

    const heartbeatAllowed = true;

    const now = new Date();

    // -------- Gather session state (parallel reads) --------
    const [
      liveShareRow,
      safeWalkRow,
      driveSessionRow,
      safetyTimerRow,
      incidentRow,
      shiftRow,
      emergencyRow,
    ] = await Promise.all([
      storage.getActiveLiveShare(userId).catch(() => undefined),
      // Safe Walk: include 'active', 'overdue', 'escalated'
      db
        .select()
        .from(safeWalks)
        .where(and(
          eq(safeWalks.userId, userId),
          inArray(safeWalks.status, ["active", "overdue", "escalated"]),
        ))
        .orderBy(desc(safeWalks.startedAt))
        .limit(1)
        .then((rows) => rows[0])
        .catch(() => undefined),
      // Drive Safety: endedAt IS NULL AND startedAt >= NOW() - 24h
      db
        .select()
        .from(driveSessions)
        .where(and(
          eq(driveSessions.userId, userId),
          isNull(driveSessions.endedAt),
        ))
        .orderBy(desc(driveSessions.startedAt))
        .limit(1)
        .then((rows) => rows[0])
        .catch(() => undefined),
      // Safety Timer: 'active' (with expiresAt > now), or 'grace_period', or 'escalated'
      db
        .select()
        .from(safetyTimers)
        .where(and(
          eq(safetyTimers.userId, userId),
          or(
            and(eq(safetyTimers.status, "active"), gt(safetyTimers.expiresAt, now)),
            eq(safetyTimers.status, "grace_period"),
            eq(safetyTimers.status, "escalated"),
          ),
        ))
        .orderBy(desc(safetyTimers.startedAt))
        .limit(1)
        .then((rows) => rows[0])
        .catch(() => undefined),
      // Incident: status='open' AND reason IN ('missed_checkin','sos') AND isDrill=false
      db
        .select()
        .from(incidents)
        .where(and(
          eq(incidents.userId, userId),
          eq(incidents.status, "open"),
          inArray(incidents.reason, ["missed_checkin", "sos"]),
          eq(incidents.isDrill, false),
        ))
        .orderBy(desc(incidents.startedAt))
        .limit(1)
        .then((rows) => rows[0])
        .catch(() => undefined),
      // Active shift: location_sessions.type='shift' AND active=true AND expiresAt > now
      db
        .select()
        .from(locationSessions)
        .where(and(
          eq(locationSessions.userId, userId),
          eq(locationSessions.type, "shift"),
          eq(locationSessions.active, true),
          gt(locationSessions.expiresAt, now),
        ))
        .orderBy(desc(locationSessions.updatedAt))
        .limit(1)
        .then((rows) => rows[0])
        .catch(() => undefined),
      // Active emergency session: type='emergency' AND active=true AND expiresAt > now
      db
        .select()
        .from(locationSessions)
        .where(and(
          eq(locationSessions.userId, userId),
          eq(locationSessions.type, "emergency"),
          eq(locationSessions.active, true),
          gt(locationSessions.expiresAt, now),
        ))
        .orderBy(desc(locationSessions.updatedAt))
        .limit(1)
        .then((rows) => rows[0])
        .catch(() => undefined),
    ]);

    // Apply 24h staleness cutoff to drive
    let driveActive = false;
    if (driveSessionRow) {
      const startedAt = driveSessionRow.startedAt as Date;
      const ageMs = now.getTime() - startedAt.getTime();
      if (ageMs <= DRIVE_STALENESS_HOURS * 60 * 60 * 1000) {
        driveActive = true;
      } else {
        console.warn(
          `[TRACKING_POLICY] ignoring stale drive session userId=${userId} reason=drive_stale_24h`,
        );
      }
    }

    // -------- Build session summary --------
    const liveShareExpires =
      liveShareRow && (liveShareRow as any).expiresAt
        ? ((liveShareRow as any).expiresAt as Date).toISOString()
        : null;
    // If liveShare expired, treat as inactive
    const liveShareActive =
      !!liveShareRow &&
      (!liveShareExpires || new Date(liveShareExpires).getTime() > now.getTime());

    const safeWalkActive = !!safeWalkRow;
    const safetyTimerActive = !!safetyTimerRow;
    const incidentActive = !!incidentRow;
    const shiftActive = !!shiftRow;
    const emergencySessionActive = !!emergencyRow;

    const sessions: TrackingPolicy["sessions"] = {
      liveShare: {
        active: liveShareActive,
        expiresAt: liveShareActive ? liveShareExpires : null,
      },
      safeWalk: {
        active: safeWalkActive,
        expiresAt:
          safeWalkRow && (safeWalkRow as any).expectedArrivalAt
            ? ((safeWalkRow as any).expectedArrivalAt as Date).toISOString()
            : null,
      },
      driveSafety: { active: driveActive },
      safetyTimer: {
        active: safetyTimerActive,
        expiresAt:
          safetyTimerRow && (safetyTimerRow as any).expiresAt
            ? ((safetyTimerRow as any).expiresAt as Date).toISOString()
            : null,
      },
      incident: {
        active: incidentActive,
        reason: incidentRow ? ((incidentRow as any).reason as string) : null,
      },
      emergencySession: {
        active: emergencySessionActive,
        expiresAt:
          emergencyRow && (emergencyRow as any).expiresAt
            ? ((emergencyRow as any).expiresAt as Date).toISOString()
            : null,
      },
      shift: {
        active: shiftActive,
        expiresAt:
          shiftRow && (shiftRow as any).expiresAt
            ? ((shiftRow as any).expiresAt as Date).toISOString()
            : null,
      },
    };

    const activePurposes: ActivePurpose[] = [];
    if (liveShareActive) activePurposes.push("liveShare");
    if (safeWalkActive) activePurposes.push("safeWalk");
    if (driveActive) activePurposes.push("driveSafety");
    if (safetyTimerActive) activePurposes.push("safetyTimer");
    if (incidentActive) activePurposes.push("incident");
    if (emergencySessionActive) activePurposes.push("emergencySession");
    if (shiftActive) activePurposes.push("activeShift");

    const hasRealSafetyPurpose =
      liveShareActive ||
      safeWalkActive ||
      driveActive ||
      safetyTimerActive ||
      incidentActive ||
      emergencySessionActive;

    // SOS-only override: a user-triggered SOS is a new intentional safety
    // action, so we attempt to include location with that SOS even if the
    // user has paused normal sharing. Other safety purposes (missed_checkin,
    // safe walk, safety timer, drive, live share, emergency session) do NOT
    // override paused; the user must explicitly resume sharing or start a
    // new allowed feature flow.
    const sosIncidentActive =
      incidentActive && incidentRow && (incidentRow as any).reason === "sos";

    // -------- Apply policy matrix --------

    // Hard stops first
    if (sharingMode === "paused") {
      if (sosIncidentActive) {
        return {
          active: true,
          nativeTrackingAllowed: true,
          heartbeatAllowed,
          sharingMode,
          locationMode,
          activePurposes: ["incident"],
          sessions,
          graceWindowSeconds: GRACE_WINDOW_SECONDS,
          reason: "ok",
        };
      }
      return {
        ...emptyPolicy(sharingMode, locationMode, "paused", heartbeatAllowed),
        sessions,
        active: hasRealSafetyPurpose,
      };
    }

    if (locationMode === "off") {
      return {
        ...emptyPolicy(sharingMode, locationMode, "location_off", heartbeatAllowed),
        sessions,
        active: hasRealSafetyPurpose,
      };
    }

    // emergency_only: only allow if a real safety purpose exists
    if (locationMode === "emergency_only" && !hasRealSafetyPurpose) {
      return {
        ...emptyPolicy(sharingMode, locationMode, "emergency_only_no_incident", heartbeatAllowed),
        sessions,
      };
    }

    // on_shift_only: allow if active shift OR another real safety purpose
    if (locationMode === "on_shift_only" && !shiftActive && !hasRealSafetyPurpose) {
      return {
        ...emptyPolicy(sharingMode, locationMode, "on_shift_only_off_shift", heartbeatAllowed),
        sessions,
      };
    }

    // presence sharingMode: ongoing consent does NOT apply.
    // Only a real active safety purpose enables GPS.
    if (sharingMode === "presence" && !hasRealSafetyPurpose) {
      return {
        ...emptyPolicy(sharingMode, locationMode, "presence_no_active_purpose", heartbeatAllowed),
        sessions,
      };
    }

    // Determine ongoingConsent (locationMode = both, sharingMode != presence).
    // sharingMode "paused" was already returned earlier so it's narrowed out here.
    const ongoingConsent =
      locationMode === "both" && sharingMode !== "presence";

    const allowed =
      hasRealSafetyPurpose ||
      ongoingConsent ||
      (locationMode === "on_shift_only" && shiftActive);

    if (!allowed) {
      return {
        ...emptyPolicy(sharingMode, locationMode, "no_active_session", heartbeatAllowed),
        sessions,
      };
    }

    if (ongoingConsent && !hasRealSafetyPurpose) {
      activePurposes.push("ongoingConsent");
    }

    return {
      active: hasRealSafetyPurpose || ongoingConsent || (locationMode === "on_shift_only" && shiftActive),
      nativeTrackingAllowed: true,
      heartbeatAllowed,
      sharingMode,
      locationMode,
      activePurposes,
      sessions,
      graceWindowSeconds: GRACE_WINDOW_SECONDS,
      reason: "ok",
    };
  } catch (err) {
    console.error(`[TRACKING_POLICY] error computing policy userId=${userId}`, (err as any)?.message || err);
    return emptyPolicy("precise", "off", "server_error", true);
  }
}

/**
 * Emit a tracking-policy:changed socket event so connected clients re-poll
 * /api/live-location/status and adjust native tracking accordingly.
 *
 * Lightweight payload: only sends nativeTrackingAllowed + reason. Client
 * fetches the full policy itself when it sees this event.
 */
export async function emitTrackingPolicyChanged(userId: string, source: string): Promise<void> {
  try {
    const policy = await getTrackingPolicyForUser(userId);
    emitToUser(userId, "tracking-policy:changed", {
      nativeTrackingAllowed: policy.nativeTrackingAllowed,
      heartbeatAllowed: policy.heartbeatAllowed,
      reason: policy.reason,
      source,
    });
  } catch (err) {
    console.warn(
      `[TRACKING_POLICY] emitTrackingPolicyChanged failed userId=${userId} source=${source} err=${(err as any)?.message || err}`,
    );
  }
}
