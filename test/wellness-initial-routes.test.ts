import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { initialWellnessHarness } from "./production-wellness-harness";
import { telephonyHarness } from "./telephony-harness";
import { claimIncidentSafetyConfirmation, IncidentTelephony } from "../server/incident-telephony";

test("respond menu binds the provider SID's incident/attempt before Gather", async () => {
  const h = initialWellnessHarness();
  const result = await h.initial("respond", { AnsweredBy: "human" });
  assert.deepEqual(h.errors, []); assert.equal(result.status, 200);
  const query = h.action(result); assert.equal(query.incidentId, h.id); assert.equal(query.attemptId, h.userAttemptId);
  assert.equal(h.db.rows.incident_telephony_events[0].answeredBy, "human");
  assert.equal(h.incident.wellnessCallStatus, "answered_human");
});
test("status callback cannot overwrite help or target a newer incident by To", async () => {
  const h = initialWellnessHarness(); h.incident.wellnessCallStatus = "help";
  const newer = { ...h.incident, id: randomUUID(), wellnessCallStatus: "placed" }; h.db.rows.incidents.push(newer);
  await h.initial("status", { To: "+15555559999", CallStatus: "failed", CallDuration: "0" });
  assert.equal(h.incident.wellnessCallStatus, "help"); assert.equal(newer.wellnessCallStatus, "placed");
  assert.equal(h.db.rows.incident_telephony_events[0].callStatus, "failed");
  assert.equal(h.db.rows.incident_telephony_events[0].callDuration, "0");
});
test("unbound initial respond/status/gather cannot mutate incident safety", async () => {
  const h = initialWellnessHarness();
  for (const path of ["respond", "status", "gather"] as const) {
    const before = structuredClone(h.db.rows);
    await h.initial(path, { Digits: "1", AnsweredBy: "human", CallStatus: "completed" }, {});
    assert.deepEqual(h.db.rows, before);
  }
});
test("initial Press 1 is explicit and exact-incident bound", async () => {
  const h = initialWellnessHarness();
  const result = await h.initial("gather", { Digits: "1" });
  assert.deepEqual(h.errors, []); assert.match(result.response, /confirmation has been recorded/);
  assert.equal(h.incident.status, "resolved"); assert.equal(h.db.rows.checkins.length, 1);
});
test("legitimate SOS supersession binds its continuation to the newly created incident", async () => {
  const h = initialWellnessHarness(); (h.incident as any).reason = "missed_checkin";
  const result = await h.initial("gather", { Digits: "2" });
  assert.deepEqual(h.errors, []); const query = h.action(result);
  assert.notEqual(query.incidentId, h.id); assert.notEqual(query.attemptId, h.userAttemptId);
  assert.equal(h.incident.status, "resolved");
  const current = h.db.rows.incidents.find(i => i.id === query.incidentId);
  assert.equal(current.status, "open"); assert.equal(current.wellnessCallStatus, "help"); assert.equal(current.escalationSnapshotContactCount, 3);
  const attempt = h.db.rows.incident_contact_attempts.find(a => a.id === query.attemptId);
  assert.equal(attempt.parentCallSid, "CAuser"); assert.equal(attempt.outcomeSource, "system_inferred");
  const dial = await h.request("helpFollowup", { Digits: "1" }, query);
  assert.equal(dial.doc.getElementsByTagName("Dial").length, 1);
});
test("inconsistent initial snapshot contains voice while leaving the incident open", async () => {
  const h = initialWellnessHarness(3, "inconsistent");
  const result = await h.initial("gather", { Digits: "2" });
  assert.equal(h.creates, 0); assert.match(result.response, /alert remains active/);
  assert.equal(h.incident.status, "open"); assert.ok(h.telemetry.some(t => t.includes("INCIDENT_SNAPSHOT_INCONSISTENT")));
});
test("provider acceptance binds user SID and late acceptance cannot regress the attempt", async () => {
  const h = telephonyHarness(); h.db.rows.incident_contact_attempts = [];
  const attempt = await h.ledger.reserveUserCall(h.id); assert.ok(attempt);
  await h.ledger.receive({ incidentId: h.id, attemptId: attempt.id, type: "status", body: { CallSid: "CAaccepted", CallStatus: "completed", CallDuration: "20" } });
  await h.ledger.bindCreatedCall(attempt.id, "CAaccepted");
  assert.equal(h.db.rows.incident_contact_attempts[0].state, "completed");
  assert.equal(h.db.rows.incident_contact_attempts[0].duration, 20);
  await assert.rejects(h.ledger.bindCreatedCall(attempt.id, "CAdifferent"));
});
test("restart after durable ingestion but before help write can retry without duplicate action", async () => {
  const h = telephonyHarness(); const query = { incidentId: h.id, attemptId: h.userAttemptId, turn: "retry" };
  h.db.failUpdate = "incidents";
  const first = await h.request("postContactFollowup", { Digits: "2" }, query); assert.equal(first.status, 503);
  h.db.failUpdate = undefined;
  const second = await h.request("postContactFollowup", { Digits: "2" }, query); assert.equal(second.status, 200);
  assert.equal(h.db.rows.incident_telephony_events.filter(e => e.eventType === "post-contact-followup").length, 1);
  const current = h.db.rows.incidents[0];
  assert.equal(JSON.parse(current.escalationTimeline).filter((e: any) => e.type === "still_need_help").length, 1);
});
test("new API instance sees consumed attempts and pending reservations from durable state", async () => {
  const h = telephonyHarness(); const dial = await h.request("helpFollowup", { Digits: "1" });
  const second = new IncidentTelephony(h.db, { log() {}, error() {} });
  assert.equal((await second.nextContact(h.id, "CAuser")).kind, "pending");
  await h.request("dialResult", { DialCallStatus: "failed" }, h.action(dial, "Dial"));
  const next = await second.nextContact(h.id, "CAuser"); assert.equal(next.kind, "available");
  if (next.kind === "available") assert.equal(next.contact.displayName, "C2");
});
test("the actual resolveCheckin procedure uses the bound atomic claim without a latest lookup", async () => {
  const h = telephonyHarness();
  const source = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("routes.ts", source, ts.ScriptTarget.Latest, true);
  let code = ""; tree.forEachChild(node => { if (ts.isFunctionDeclaration(node) && node.name?.text === "resolveCheckin") code = node.getText(tree); });
  assert.ok(code); let notices = 0;
  const forbidden = () => { throw new Error("Unbound state procedure invoked"); };
  const context: any = { db: h.db, claimIncidentSafetyConfirmation,
    storage: { getUser: async () => ({ id: h.userId, name: "User", safetyState: "concern", timezone: "UTC" }), refreshNextCheckinDueAt: async () => null,
      getContacts: async () => [], getContactsLinkedToUser: async () => [], getOpenIncident: forbidden, createCheckin: forbidden, updateSafetyState: forbidden, getActiveLocationSession: forbidden, updateIncident: forbidden },
    getBaseUrl: () => "https://test.invalid", formatOwnerLocalAlertTime: () => "test time", isContactActiveForAlerts: () => true,
    injectAllClearSystemMessageToWatchers: async () => { notices++; }, notifyRecovery: async () => {}, notifySubjectConfirmation: async () => {}, emitTrackingPolicyChanged: async () => {}, console: { log() {}, error() {}, warn() {} },
  };
  runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  assert.equal((await context.resolveCheckin(h.userId, "call", { boundIncidentId: h.id })).resolved, true);
  const newer = { ...h.db.rows.incidents[0], id: randomUUID(), status: "open", wellnessCallStatus: "help" }; h.db.rows.incidents.push(newer);
  assert.equal((await context.resolveCheckin(h.userId, "call", { boundIncidentId: h.id })).resolved, false);
  assert.equal(newer.status, "open"); assert.equal(notices, 1); assert.equal(h.db.rows.checkins.length, 1);
});
