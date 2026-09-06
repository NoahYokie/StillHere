import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { incidents } from "../shared/schema";
import { test } from "node:test";
import { MemoryDatabase } from "./telephony-harness";
import { creationMethods } from "./production-wellness-harness";
import { resolveSnapshotValidity, readOpeningRoster, createOpeningSnapshot } from "../server/escalation-snapshot";

function setup(count = 3) {
  const db = new MemoryDatabase(), userId = randomUUID();
  db.rows.users = [{ id: userId, safetyState: "active" }];
  db.rows.contacts = Array.from({ length: count }, (_, i) => ({ id: randomUUID(), userId, name: "C" + (i + 1), phone: "+1555555010" + i, priority: i + 1, circleRole: "primary", softDeletedAt: null, pausedUntil: null }));
  return { db, userId, storage: creationMethods(db) };
}
for (const count of [0, 3]) {
  for (const method of ["createIncident", "createIncidentWithSafetyState"]) {
    test(`${method}: new ${count}-contact incident snapshots atomically`, async () => {
      const h = setup(count);
      const incident = method === "createIncident" ? await h.storage[method](h.userId, "missed_checkin") : await h.storage[method](h.userId, "sos", "concern", "Needs help");
      assert.ok(incident.escalationSnapshotCreatedAt);
      assert.equal(incident.escalationSnapshotContactCount, count);
      const rows = h.db.rows.incident_escalation_sequence || [];
      assert.equal(rows.length, count); assert.equal(resolveSnapshotValidity(incident, rows), "valid");
    });
  }
}
for (const failure of ["sequence", "metadata"]) {
  test(`${failure} failure rolls back incident and snapshot transaction`, async () => {
    const h = setup();
    if (failure === "sequence") h.db.failInsert = "incident_escalation_sequence";
    else h.db.failUpdate = "incidents";
    await assert.rejects(h.storage.createIncidentWithSafetyState(h.userId, "sos", "concern", "Needs help"));
    assert.equal(h.db.rows.incidents?.length || 0, 0);
    assert.equal(h.db.rows.incident_escalation_sequence?.length || 0, 0);
    assert.equal(h.db.rows.users[0].safetyState, "active");
  });
}
test("live reorder/name/destination change leaves old snapshot immutable; next incident uses new roster", async () => {
  const h = setup(); const first = await h.storage.createIncident(h.userId, "missed_checkin");
  const original = structuredClone(h.db.rows.incident_escalation_sequence);
  Object.assign(h.db.rows.contacts[0], { priority: 2, name: "Renamed", phone: "+15555559999", circleRole: "support" });
  h.db.rows.contacts[1].priority = 3; h.db.rows.contacts[2].priority = 1;
  assert.deepEqual(h.db.rows.incident_escalation_sequence, original);
  h.db.rows.incidents[0].status = "resolved";
  const second = await h.storage.createIncident(h.userId, "missed_checkin");
  const rows = h.db.rows.incident_escalation_sequence.filter(r => r.incidentId === second.id);
  assert.deepEqual(rows.map(r => r.displayName), ["C3", "Renamed", "C2"]);
  assert.equal(rows[1].destination, "+15555559999");
  assert.equal(rows[1].role, "support");
  assert.deepEqual(h.db.rows.incident_escalation_sequence.filter(r => r.incidentId === first.id), original);
});
test("removal and pause affect future incidents only", async () => {
  const h = setup(); await h.storage.createIncident(h.userId, "missed_checkin");
  const original = structuredClone(h.db.rows.incident_escalation_sequence);
  h.db.rows.contacts[1].softDeletedAt = new Date(); h.db.rows.contacts[2].pausedUntil = new Date("2999-01-01");
  h.db.rows.incidents[0].status = "resolved";
  const next = await h.storage.createIncident(h.userId, "missed_checkin");
  assert.equal(next.escalationSnapshotContactCount, 1);
  assert.deepEqual(h.db.rows.incident_escalation_sequence.slice(0, 3), original);
});
for (const legacy of [true, false]) {
  test(`ownership return preserves ${legacy ? "legacy unknown" : "known-empty"} state`, async () => {
    const h = setup(0); const existing = { id: randomUUID(), userId: h.userId, status: "open", reason: "sos", isDrill: false, escalationTimeline: "[]", escalationSnapshotCreatedAt: legacy ? null : new Date(), escalationSnapshotContactCount: legacy ? null : 0 };
    h.db.rows.incidents = [existing];
    const result = await h.storage.createIncidentWithSafetyState(h.userId, "sos", "concern", "Needs help");
    assert.equal(result.id, existing.id); assert.equal(result.ownershipSuppressed, true);
    assert.equal(result.escalationSnapshotContactCount, legacy ? null : 0);
    assert.equal(h.db.rows.incident_escalation_sequence?.length || 0, 0);
  });
}
test("stale originating incident cannot create or adopt a newer incident", async () => {
  const h = setup(); await h.storage.createIncident(h.userId, "missed_checkin");
  const original = structuredClone(h.db.rows);
  await assert.rejects(h.storage.createIncidentWithSafetyState(h.userId, "sos", "concern", "Needs help", { originatingIncidentId: randomUUID() }));
  assert.deepEqual(h.db.rows, original);
});
test("migration is structural: no historical snapshot or attempt backfill", () => {
  const migration = readFileSync(new URL("../migrations/0011_incident_telephony_ledger.sql", import.meta.url), "utf8").replace(/--[^\n]*/g, "");
  assert.doesNotMatch(migration, /\bINSERT\s+INTO\b|\bUPDATE\s+incidents\b|\bSELECT\b/i);
  assert.match(migration, /ADD COLUMN escalation_snapshot_created_at timestamptz\s*,/);
  assert.match(migration, /ADD COLUMN escalation_snapshot_contact_count integer\s*,/);
});

test("direct production drill INSERT also completes its snapshot in one transaction", async () => {
  const h = setup(0);
  const source = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("routes.ts", source, ts.ScriptTarget.Latest, true);
  let expression = "";
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "drill" && node.initializer?.getText(tree).includes("createOpeningSnapshot")) expression = node.initializer.getText(tree);
    ts.forEachChild(node, visit);
  } visit(tree);
  assert.ok(expression);
  const context: any = { db: h.db, userId: h.userId, incidents, readOpeningRoster, createOpeningSnapshot };
  runInNewContext(ts.transpileModule("async function insertDrill() { return " + expression + "; }", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const drill = await context.insertDrill(); assert.equal(drill.isDrill, true); assert.equal(drill.escalationSnapshotContactCount, 0); assert.ok(drill.escalationSnapshotCreatedAt);
});
test("empty snapshot metadata failure rolls back its newly inserted incident", async () => {
  const h = setup(0); h.db.failUpdate = "incidents";
  await assert.rejects(h.storage.createIncident(h.userId, "missed_checkin"));
  assert.equal(h.db.rows.incidents?.length || 0, 0);
});
test("hard live-contact deletion preserves historical sequence identity", async () => {
  const h = setup(); const first = await h.storage.createIncident(h.userId, "missed_checkin");
  const removed = h.db.rows.contacts.splice(1, 1)[0];
  assert.ok(h.db.rows.incident_escalation_sequence.some(r => r.incidentId === first.id && r.contactId === removed.id));
  h.db.rows.incidents[0].status = "resolved";
  const next = await h.storage.createIncident(h.userId, "missed_checkin");
  assert.equal(next.escalationSnapshotContactCount, 2);
  assert.equal(h.db.rows.incident_escalation_sequence.some(r => r.incidentId === next.id && r.contactId === removed.id), false);
});
