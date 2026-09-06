import assert from "node:assert/strict";
import { test } from "node:test";
import { telephonyHarness } from "./telephony-harness";
import { initialWellnessHarness } from "./production-wellness-harness";
import { exhaustedMessage, containmentMessage } from "../server/incident-telephony";

// Preserve the P1 certainty scenarios against the new production boundary.
// Initial routes are still extracted from routes.ts; contact handlers and the
// ledger execute directly. Database/provider effects alone are substituted.
const forbidden = /we could not reach|alerting the next|attempting to reach|reaching out|has already been alerted|we will keep them updated|someone is on the way|got through|spoke with/i;
function truthful(result: { response: string }) { assert.doesNotMatch(result.response, forbidden); }

test("single consumed contact: truthful exhaustion and active help", async () => {
  const h = telephonyHarness(1);
  const dial = await h.request("helpFollowup", { Digits: "1" });
  const result = await h.request("dialResult", { DialCallStatus: "completed", DialCallDuration: "5" }, h.action(dial, "Dial"));
  const help = await h.request("postContactFollowup", { Digits: "2" }, h.action(result));
  truthful(help); assert.ok(help.response.includes(exhaustedMessage)); assert.equal(h.incident.status, "open");
});
test("multiple contacts: next snapshot contact without a dispatch assurance", async () => {
  const h = telephonyHarness();
  const result = await h.request("postContactFollowup", { Digits: "2" });
  truthful(result); assert.match(result.response, /Press 1 to connect to C1/);
  assert.equal(h.db.rows.incident_contact_attempts.filter(a => a.channel === "voice").length, 0);
});
test("zero contacts: exact neutral fallback and independent escalation preserved", async () => {
  const h = telephonyHarness(0), before = h.incident.notifiedContactIds;
  const result = await h.request("postContactFollowup", { Digits: "2" });
  truthful(result); assert.ok(result.response.includes(exhaustedMessage));
  assert.equal(h.incident.notifiedContactIds, before); assert.equal(h.incident.lastEscalationStep, "wellness_call_help");
});
test("opening eligibility stays frozen after live pause or removal", async () => {
  const h = telephonyHarness();
  h.db.rows.contacts = [{ softDeletedAt: new Date(), pausedUntil: new Date("2999-01-01") }];
  const result = await h.request("comfort"); truthful(result); assert.match(result.response, /C1/);
  assert.equal(h.db.rows.incident_escalation_sequence.length, 3);
});
test("comfort and guidance cannot reintroduce unsupported assurances", async () => {
  const h = telephonyHarness();
  for (let i = 0; i < 3; i++) truthful(await h.request("comfort"));
  truthful(await h.request("helpFollowup", { Digits: "0" }));
});
test("valid post-contact Press 1 preserves legitimate resolution", async () => {
  const h = telephonyHarness();
  const result = await h.request("postContactFollowup", { Digits: "1" });
  truthful(result); assert.equal(h.incident.status, "resolved"); assert.equal(h.resolutions, 1);
});
test("resolved incident rejects stale Press 2 without restarting escalation", async () => {
  const h = telephonyHarness(); h.incident.status = "resolved";
  const before = structuredClone(h.incident);
  truthful(await h.request("postContactFollowup", { Digits: "2" }));
  assert.deepEqual(h.incident, before);
});
test("resolution between ingestion and conditional help write wins", async () => {
  const h = telephonyHarness();
  h.db.beforeUpdate = table => { if (table === "incidents") { h.incident.status = "resolved"; h.db.beforeUpdate = undefined; } };
  const result = await h.request("postContactFollowup", { Digits: "2" });
  truthful(result); assert.equal(h.incident.status, "resolved"); assert.equal(h.incident.processingLockId, "worker");
});
test("missing and malformed bindings never adopt the latest incident", async () => {
  const h = telephonyHarness();
  for (const query of [{}, { incidentId: "malformed" }]) {
    truthful(await h.request("postContactFollowup", { Digits: "1" }, query));
  }
  assert.equal(h.incident.status, "open"); assert.equal(h.resolutions, 0);
});
test("continuation rechecks current incident and contains persistence failures", async () => {
  const h = telephonyHarness(); truthful(await h.request("comfort"));
  h.db.failInsert = "incident_telephony_events";
  const failure = await h.request("comfort"); truthful(failure); assert.equal(failure.status, 503);
});
test("atomic help append preserves timeline and independent state", async () => {
  const h = telephonyHarness();
  Object.assign(h.incident, { escalationTimeline: '[{"type":"existing"}]', claimedByContactId: "guardian", deliveryFailed: true });
  await h.request("postContactFollowup", { Digits: "2" });
  const row = h.incident as any;
  assert.deepEqual(JSON.parse(row.escalationTimeline).map((e: any) => e.type), ["existing", "still_need_help"]);
  assert.equal(row.claimedByContactId, "guardian"); assert.equal(row.deliveryFailed, true); assert.equal(row.processingLockId, null);
});
test("missing snapshot destination gives neutral guidance without inferred number", async () => {
  const h = telephonyHarness(); h.db.rows.incident_escalation_sequence[0].destination = "";
  const result = await h.request("helpFollowup", { Digits: "1" });
  truthful(result); assert.ok(result.response.includes(containmentMessage)); assert.doesNotMatch(result.response, /911|000|<Dial/);
});
test("initial Gather carries authoritative incident and attempt through Press 0", async () => {
  const h = initialWellnessHarness();
  const result = await h.initial("gather", { Digits: "2" }); truthful(result);
  assert.equal(result.status, 200); assert.deepEqual(h.errors, []);
  const query = h.action(result); assert.equal(query.incidentId, h.id); assert.equal(query.attemptId, h.userAttemptId);
  const guidance = await h.request("helpFollowup", { Digits: "0" }, query); truthful(guidance);
});
test("in-app notification summaries never become spoken dispatch proof", async () => {
  const h = initialWellnessHarness();
  const result = await h.initial("gather", { Digits: "2" }); truthful(result);
  assert.equal(h.notifications, 3); assert.match(result.response, /marked as needing help/);
});
test("duplicate initial help does not fan out twice", async () => {
  const h = initialWellnessHarness();
  const result = await h.initial("gather", { Digits: "2" }); truthful(result);
  truthful(await h.initial("gather", { Digits: "2" }));
  assert.equal(h.notifications, 3);
});
test("initial known-empty menu and Press 0 retain exact zero-contact fallback", async () => {
  const h = initialWellnessHarness(0);
  const result = await h.initial("gather", { Digits: "2" }); truthful(result);
  assert.ok(result.response.includes(exhaustedMessage));
  const guidance = await h.request("helpFollowup", { Digits: "0" }, h.action(result));
  assert.ok(guidance.response.includes(exhaustedMessage));
});
test("unbound or stale initial menu cannot mutate or create an incident", async () => {
  const h = initialWellnessHarness();
  truthful(await h.initial("gather", { Digits: "2" }, {}));
  h.incident.status = "resolved";
  truthful(await h.initial("gather", { Digits: "2" }));
  assert.equal(h.creates, 0); assert.equal(h.notifications, 0);
});
test("legacy initial help contains voice without suppressing independent notifications", async () => {
  const h = initialWellnessHarness(0, "legacy");
  h.db.rows.contacts = [{ id: "live", userId: h.userId, name: "Live", phone: "+15555550101", priority: 1, pausedUntil: null, softDeletedAt: null }];
  const result = await h.initial("gather", { Digits: "2" }); truthful(result);
  assert.ok(result.response.includes(containmentMessage)); assert.equal(h.creates, 0); assert.equal(h.notifications, 1);
  assert.equal(h.incident.status, "open"); assert.equal(h.incident.escalationSnapshotCreatedAt, null);
  assert.equal(h.db.rows.incident_escalation_sequence.length, 0);
});
