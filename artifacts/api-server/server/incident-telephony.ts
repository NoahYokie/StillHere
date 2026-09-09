import { createHash } from "node:crypto";
import { and, eq, or, sql, isNull, ne } from "drizzle-orm";
import { incidents, users, settings, checkins, locationSessions, incidentEscalationSequence as sequence, incidentContactAttempts as attempts, incidentTelephonyEvents as events } from "../../../lib/stillhere-shared/src/schema";
import { resolveSnapshotValidity } from "./escalation-snapshot";

export const containmentMessage = "Your alert remains active. If you are in immediate danger, please contact your local emergency services now.";
export const exhaustedMessage = "There is no one else in your Safety Circle available to contact. If you are in immediate danger, please contact your local emergency services now.";
export const unboundMessage = "We cannot confirm an active safety incident for this call. If you still need help or are in immediate danger, please contact your local emergency services now.";

type Attempt = typeof attempts.$inferSelect;
const terminal = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);
const nonterminal = ["reserved", "initiated", "ringing", "answered", "in-progress"];

export function providerTransition(current: string, reported: string): string {
  if (terminal.has(current)) return current;
  if (terminal.has(reported)) return reported;
  return nonterminal.indexOf(reported) > nonterminal.indexOf(current) ? reported : current;
}

export function providerDuration(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export function rawTelephonyFields(body: Record<string, unknown>) {
  const field = (key: string) => typeof body[key] === "string" ? body[key] as string : null;
  return {
    callStatus: field("CallStatus"), dialCallStatus: field("DialCallStatus"),
    callDuration: field("CallDuration") ?? field("Duration"),
    dialCallDuration: field("DialCallDuration"), callSid: field("CallSid"),
    parentCallSid: field("ParentCallSid"), dialCallSid: field("DialCallSid"),
    answeredBy: field("AnsweredBy"), digits: field("Digits"),
    providerTimestamp: field("Timestamp"), sequenceNumber: field("SequenceNumber"),
  };
}

// Dependency injection keeps tests off the production pool and all providers.
export class IncidentTelephony {
  constructor(private readonly db: any, private readonly logger: Pick<Console, "log" | "error"> = console) {}

  async getIncident(id: unknown) {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    const [incident] = await this.db.select().from(incidents).where(eq(incidents.id, id));
    return incident as typeof incidents.$inferSelect | undefined;
  }

  async claimInput(incidentId: string, callSid: string, type: string, turn: string, digits: string, tx = this.db) {
    const key = createHash("sha256").update(JSON.stringify([incidentId, callSid, type, turn, digits])).digest("hex");
    const inserted = await tx.insert(events).values({ incidentId, provider: "system", eventKey: `input:${key}`, eventType: "input_claim", callSid, digits, receivedAt: new Date() }).onConflictDoNothing().returning({ id: events.id });
    return inserted.length === 1;
  }

  // Current live-user-leg association after the existing SOS ownership
  // transition. This does not assert a new outbound contact attempt.
  async continueUserCall(incidentId: string, parentCallSid: string, fromIncidentId: string) {
    return this.db.transaction(async (tx: any) => {
      const [incident] = await tx.select().from(incidents).where(eq(incidents.id, incidentId)).for("update");
      if (!incident || incident.status !== "open") throw new Error("Call continuation incident closed");
      const [attempt] = await tx.insert(attempts).values({ incidentId, channel: "wellness_voice", parentCallSid, state: "answered", outcome: "continued_user_leg", outcomeSource: "system_inferred" }).returning();
      await tx.insert(events).values({ incidentId, attemptId: attempt.id, provider: "system", eventKey: `continuation:${attempt.id}`, eventType: `continued_from_incident:${fromIncidentId}`, callSid: parentCallSid, receivedAt: new Date() });
      return attempt as Attempt;
    });
  }

  async snapshot(incident: typeof incidents.$inferSelect, tx = this.db) {
    const rows = await tx.select().from(sequence).where(eq(sequence.incidentId, incident.id)).orderBy(sequence.priorityRank);
    const validity = resolveSnapshotValidity(incident, rows);
    if (validity === "inconsistent") this.logger.error(JSON.stringify({ event: "INCIDENT_SNAPSHOT_INCONSISTENT", incidentId: incident.id, recordedCount: incident.escalationSnapshotContactCount, physicalCount: rows.length }));
    return { validity, rows };
  }

  async reserveUserCall(incidentId: string) {
    return this.db.transaction(async (tx: any) => {
      const [incident] = await tx.select().from(incidents).where(eq(incidents.id, incidentId)).for("update");
      if (!incident || incident.status !== "open" || incident.isDrill) return null;
      const prior = await tx.select().from(attempts).where(and(eq(attempts.incidentId, incidentId), eq(attempts.channel, "wellness_voice")));
      if (prior.length) return null;
      const [attempt] = await tx.insert(attempts).values({ incidentId, channel: "wellness_voice" }).returning();
      return attempt as Attempt;
    });
  }

  async bindCreatedCall(attemptId: string, sid: string) {
    return this.db.transaction(async (tx: any) => {
      const [identity] = await tx.select().from(attempts).where(eq(attempts.id, attemptId));
      if (!identity) throw new Error("Missing wellness attempt");
      // Same incident-before-attempt lock order as callback ingestion.
      await tx.select().from(incidents).where(eq(incidents.id, identity.incidentId)).for("update");
      const [attempt] = await tx.select().from(attempts).where(eq(attempts.id, attemptId)).for("update");
      if (!attempt || (attempt.parentCallSid && attempt.parentCallSid !== sid)) throw new Error("Wellness provider SID binding mismatch");
      const receivedAt = new Date();
      await tx.insert(events).values({ incidentId: attempt.incidentId, attemptId, eventKey: `created:${attemptId}:${sid}`, eventType: "call_created", callSid: sid, receivedAt }).onConflictDoNothing();
      await tx.update(attempts).set({ parentCallSid: sid, attemptedAt: attempt.attemptedAt || receivedAt, state: providerTransition(attempt.state, "initiated"), updatedAt: receivedAt }).where(eq(attempts.id, attemptId));
    });
  }

  // Call only after verifyTwilioSignature. The bound URL is part of the signed
  // request. A supplied SID must agree with every previously recorded SID.
  async receive(input: { incidentId?: string; attemptId?: string; type: string; turn?: string; body: Record<string, unknown> }) {
    if (!input.incidentId || !/^[0-9a-f-]{36}$/i.test(input.incidentId)
      || (input.attemptId && !/^[0-9a-f-]{36}$/i.test(input.attemptId))) return null;
    const raw = rawTelephonyFields(input.body);
    if (!raw.callSid) return null;
    const receivedAt = new Date();
    return this.db.transaction(async (tx: any) => {
      const [incident] = await tx.select().from(incidents).where(eq(incidents.id, input.incidentId!)).for("update");
      if (!incident || incident.isDrill) return null;
      let attempt: Attempt | undefined;
      if (input.attemptId) {
        [attempt] = await tx.select().from(attempts).where(and(eq(attempts.id, input.attemptId), eq(attempts.incidentId, incident.id))).for("update");
        if (!attempt) return null;
        const childCallback = input.type === "contact-status";
        if ((childCallback || input.type === "dial-result") && attempt.channel !== "voice") return null;
        const parentSid = childCallback ? raw.parentCallSid : raw.callSid;
        const childSid = childCallback ? raw.callSid : raw.dialCallSid;
        if (!parentSid || (attempt.parentCallSid && parentSid !== attempt.parentCallSid)
          || (childSid && attempt.childCallSid && childSid !== attempt.childCallSid)) return null;
      } else {
        // Only a signed incident-bound legacy continuation can lack an attempt.
        const snapshot = await this.snapshot(incident, tx);
        if (snapshot.validity !== "legacy") return null;
      }
      const eventKey = createHash("sha256").update(JSON.stringify({ incidentId: incident.id, attemptId: attempt?.id || null, type: input.type, turn: input.turn || null, ...raw })).digest("hex");
      this.logger.log(JSON.stringify({ event: "INCIDENT_TELEPHONY_RAW", incidentId: incident.id, attemptId: attempt?.id || null, type: input.type, ...raw }));
      const inserted = await tx.insert(events).values({ incidentId: incident.id, attemptId: attempt?.id, eventKey, eventType: input.type, ...raw, receivedAt }).onConflictDoNothing().returning({ id: events.id });
      if (!inserted.length) return { incident, attempt, duplicate: true, raw };
      if (attempt) {
        const childCallback = input.type === "contact-status";
        const reported = (input.type === "dial-result" ? raw.dialCallStatus : raw.callStatus) || "";
        const lifecycle = childCallback || input.type === "dial-result" || input.type === "status";
        const known = terminal.has(reported) || nonterminal.includes(reported);
        const duration = providerDuration(attempt.channel === "voice" && !childCallback ? raw.dialCallDuration : raw.callDuration);
        const patch: Partial<Attempt> = {
          parentCallSid: attempt.parentCallSid || (childCallback ? raw.parentCallSid : raw.callSid),
          childCallSid: attempt.childCallSid || (childCallback ? raw.callSid : raw.dialCallSid),
          updatedAt: receivedAt,
        };
        if (lifecycle) {
          patch.state = providerTransition(attempt.state, reported);
          // A contact lifecycle/action callback proves an attempt occurred,
          // including ambiguous or failed action results. Duration is not an
          // answer predicate and never resets consumption.
          patch.attemptedAt = attempt.attemptedAt || receivedAt;
          if (reported === "answered" || reported === "in-progress") patch.answeredAt = attempt.answeredAt || receivedAt;
          if (terminal.has(reported)) patch.completedAt = attempt.completedAt || receivedAt;
          if (!terminal.has(attempt.state) && (patch.state === reported || (!known && attempt.outcome === null))) {
            patch.outcome = known ? reported : "unknown";
            patch.outcomeSource = known ? "provider_authoritative" : "system_inferred";
          }
          if (duration !== null && attempt.duration === null) patch.duration = duration;
        }
        [attempt] = await tx.update(attempts).set(patch).where(eq(attempts.id, attempt.id)).returning();
      }
      return { incident, attempt, duplicate: false, raw };
    });
  }

  async nextContact(incidentId: string, parentCallSid: string, consume = false, turn?: string) {
    return this.db.transaction(async (tx: any) => {
      const [incident] = await tx.select().from(incidents).where(eq(incidents.id, incidentId)).for("update");
      if (!incident || incident.status !== "open" || incident.isDrill) return { kind: "closed" as const, message: unboundMessage };
      const snapshot = await this.snapshot(incident, tx);
      if (snapshot.validity !== "valid") return { kind: "contained" as const, message: containmentMessage };
      if (consume && turn !== undefined && !(await this.claimInput(incidentId, parentCallSid, "help-followup", turn, "1", tx))) return { kind: "contained" as const, message: containmentMessage };
      const prior: Attempt[] = await tx.select().from(attempts).where(and(eq(attempts.incidentId, incidentId), eq(attempts.channel, "voice"), eq(attempts.cycle, 1)));
      // A reserved dispatch whose provider result is not yet known is not
      // exhaustion and cannot safely be issued twice or skipped as attempted.
      if (prior.some(a => !a.attemptedAt)) return { kind: "pending" as const, message: containmentMessage };
      const next = snapshot.rows.find((row: any) => !prior.some(a => a.sequenceId === row.id));
      if (!next) return { kind: "exhausted" as const, message: exhaustedMessage };
      if (!next.destination) return { kind: "contained" as const, message: containmentMessage };
      if (!consume) return { kind: "available" as const, contact: next, message: "You are still marked as needing help. We are continuing your Safety Circle escalation." };
      const [attempt] = await tx.insert(attempts).values({ incidentId, sequenceId: next.id, parentCallSid, cycle: 1, channel: "voice" }).returning();
      return { kind: "reserved" as const, contact: next, attempt: attempt as Attempt, message: containmentMessage };
    });
  }

  async needsHelp(incidentId: string, userId: string, input?: { callSid: string; turn: string; type: string }) {
    return this.db.transaction(async (tx: any) => {
      const [current] = await tx.select().from(incidents).where(and(eq(incidents.id, incidentId), eq(incidents.userId, userId))).for("update");
      if (!current || current.status !== "open" || current.isDrill) return [];
      if (input && !(await this.claimInput(incidentId, input.callSid, input.type, input.turn, "2", tx))) return [];
      const now = new Date();
      const entry = JSON.stringify([{ type: "still_need_help", time: now.toISOString(), detail: "User confirmed help is still needed by phone" }]);
      const updated = await tx.update(incidents).set({ wellnessCallStatus: "help", nextActionAt: now, processingLockId: null, processingLockedAt: null,
        escalationTimeline: sql`(COALESCE(NULLIF(${incidents.escalationTimeline}, ''), '[]')::jsonb || ${entry}::jsonb)::text`,
      }).where(and(eq(incidents.id, incidentId), eq(incidents.userId, userId), eq(incidents.status, "open"), eq(incidents.isDrill, false))).returning();
      if (updated.length) await tx.update(users).set({ safetyState: "concern", safetyStateReason: "User still needs help by phone", safetyStateChangedAt: now }).where(eq(users.id, userId));
      return updated;
    });
  }
}

// The existing resolveCheckin procedure uses this atomic phone-only claim.
// No latest-incident lookup or side effect is permitted before it wins.
export async function claimIncidentSafetyConfirmation(db: any, incidentId: string, userId: string, expectedHelp = true) {
  return db.transaction(async (tx: any) => {
    const [incident] = await tx.select().from(incidents).where(and(eq(incidents.id, incidentId), eq(incidents.userId, userId))).for("update");
    if (!incident || incident.status !== "open" || incident.isDrill || incident.wellnessCallStatus === "safe"
      || (expectedHelp && incident.wellnessCallStatus !== "help")) return null;
    const now = new Date();
    const [resolved] = await tx.update(incidents).set({ status: "resolved", wellnessCallStatus: "safe", resolvedAt: now, resolutionReason: "Confirmed safe by phone", nextActionAt: null, processingLockId: null, processingLockedAt: null })
      .where(and(eq(incidents.id, incidentId), eq(incidents.userId, userId), eq(incidents.status, "open"), eq(incidents.isDrill, false),
        expectedHelp ? eq(incidents.wellnessCallStatus, "help") : or(isNull(incidents.wellnessCallStatus), ne(incidents.wellnessCallStatus, "safe")),
      )).returning();
    if (!resolved) return null;
    await tx.insert(checkins).values({ userId, method: "auto" });
    await tx.update(settings).set({ remindersSent: 0, lastReminderAt: null, reminderTimeline: "[]", updatedAt: now }).where(eq(settings.userId, userId));
    await tx.update(users).set({ safetyState: "active", safetyStateReason: "Confirmed safe via call", safetyStateChangedAt: now }).where(and(eq(users.id, userId), or(eq(users.safetyState, "concern"), eq(users.safetyState, "quiet"))));
    await tx.update(locationSessions).set({ active: false, updatedAt: now }).where(and(eq(locationSessions.userId, userId), eq(locationSessions.active, true)));
    return resolved as typeof incidents.$inferSelect;
  });
}
