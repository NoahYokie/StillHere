import { and, eq, isNull, lte, or } from "drizzle-orm";
import { contacts, incidents, incidentEscalationSequence } from "../../../lib/stillhere-shared/src/schema";

export type SnapshotValidity = "legacy" | "valid" | "inconsistent";

export function resolveSnapshotValidity(
  incident: { escalationSnapshotCreatedAt: Date | string | null; escalationSnapshotContactCount: number | null },
  rows: readonly { priorityRank: number }[],
): SnapshotValidity {
  const timestamp = incident.escalationSnapshotCreatedAt;
  const count = incident.escalationSnapshotContactCount;
  if (timestamp === null && count === null && rows.length === 0) return "legacy";
  if (!timestamp || !Number.isFinite(new Date(timestamp).getTime())
    || count === null || !Number.isInteger(count) || count < 0 || rows.length !== count
    || rows.some((row, index) => row.priorityRank !== index + 1)) return "inconsistent";
  return "valid";
}

// Called only in the incident INSERT transaction, never for an ownership return.
// Destinations follow the existing contacts table's database storage convention.
// No live-contact FK: deletion must not erase or retarget the opening snapshot.
export async function readOpeningRoster(tx: any, userId: string) {
  const now = new Date();
  const roster = await tx.select().from(contacts).where(and(
    eq(contacts.userId, userId), isNull(contacts.softDeletedAt),
    or(isNull(contacts.pausedUntil), lte(contacts.pausedUntil, now)),
  )).orderBy(contacts.priority, contacts.id).for("share");
  return { roster, now };
}

export async function createOpeningSnapshot(tx: any, incident: { id: string; userId: string }, opening: Awaited<ReturnType<typeof readOpeningRoster>>) {
  const { roster, now } = opening;
  if (roster.length) {
    await tx.insert(incidentEscalationSequence).values(roster.map((contact: any, index: number) => ({
      incidentId: incident.id, contactId: contact.id, priorityRank: index + 1,
      role: contact.circleRole, displayName: contact.name, destination: contact.phone,
      snapshotAt: now,
    })));
  }
  const [completed] = await tx.update(incidents).set({
    escalationSnapshotCreatedAt: now, escalationSnapshotContactCount: roster.length,
  }).where(eq(incidents.id, incident.id)).returning();
  if (!completed) throw new Error("Opening escalation snapshot metadata was not persisted");
  return completed;
}
