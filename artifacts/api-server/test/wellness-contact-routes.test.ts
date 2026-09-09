import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { telephonyHarness } from "./telephony-harness";
import { exhaustedMessage, containmentMessage } from "../server/incident-telephony";

for (const [status, duration] of [["completed", "5"], ["completed", "14"], ["completed", "15"], ["completed", "20"], ["busy", "0"], ["no-answer", "0"], ["failed", "0"], ["canceled", "0"], ["completed", undefined], ["completed", "malformed"], [undefined, "5"]]) {
  test(`production Dial action: ${status}/${duration}, raw evidence and Cycle-1 consumption`, async () => {
    const h = telephonyHarness();
    const dial = await h.request("helpFollowup", { Digits: "1" });
    assert.equal(dial.doc.getElementsByTagName("Number")[0].textContent, "+15555550100");
    const result = await h.request("dialResult", { DialCallStatus: status, DialCallDuration: duration, DialCallSid: "CAcontact1" }, h.action(dial, "Dial"));
    assert.equal(result.status, 200);
    assert.doesNotMatch(result.response, /could not reach|did not answer|spoke with|got through/i);
    if (status === "completed") assert.match(result.response, /call has completed/);
    const event = h.db.rows.incident_telephony_events.find(e => e.eventType === "dial-result");
    assert.equal(event.dialCallStatus, status ?? null);
    assert.equal(event.dialCallDuration, duration ?? null);
    const attempt = h.db.rows.incident_contact_attempts.find(a => a.channel === "voice");
    assert.ok(attempt.attemptedAt);
    assert.equal(attempt.childCallSid, "CAcontact1");
    assert.equal(attempt.outcomeSource, status ? "provider_authoritative" : "system_inferred");
    const followup = await h.request("postContactFollowup", { Digits: "2" }, h.action(result));
    assert.match(followup.response, /C2/);
    assert.doesNotMatch(followup.response, /C1/);
    assert.equal(h.incident.status, "open"); assert.equal(h.incident.wellnessCallStatus, "help");
    assert.equal(h.incident.notifiedContactIds, '["existing-notification"]');
    assert.equal(h.resolutions, 0);
  });
}

test("real handlers progress C1 to C2 to C3 to exhausted, never same-cycle redial", async () => {
  const h = telephonyHarness(); let menu = await h.request("comfort");
  for (let i = 1; i <= 3; i++) {
    assert.match(menu.response, new RegExp("C" + i));
    const dial = await h.request("helpFollowup", { Digits: "1" }, h.action(menu));
    assert.equal(dial.doc.getElementsByTagName("Number")[0].textContent, "+1555555010" + (i - 1));
    const result = await h.request("dialResult", { DialCallStatus: "completed", DialCallDuration: "5", DialCallSid: "CAcontact" + i }, h.action(dial, "Dial"));
    menu = await h.request("postContactFollowup", { Digits: "2" }, h.action(result));
  }
  assert.match(menu.response, /There is no one else/); assert.ok(menu.response.includes(exhaustedMessage));
  assert.equal(menu.doc.getElementsByTagName("Gather").length, 0);
  assert.equal(h.db.rows.incident_contact_attempts.filter(a => a.channel === "voice").length, 3);
  assert.equal(h.incident.status, "open"); assert.equal(h.incident.lastEscalationStep, "wellness_call_help");
});

test("provider child callbacks are requested and late ringing cannot regress completion", async () => {
  const h = telephonyHarness(); const dial = await h.request("helpFollowup", { Digits: "1" });
  const number = dial.doc.getElementsByTagName("Number")[0];
  assert.equal(number.getAttribute("statusCallbackEvent"), "initiated ringing answered completed");
  const query = h.action(dial, "Number", "statusCallback");
  await h.request("contactStatus", { CallSid: "CAchild", ParentCallSid: "CAuser", CallStatus: "in-progress", SequenceNumber: "2" }, query);
  await h.request("dialResult", { DialCallSid: "CAchild", DialCallStatus: "completed", DialCallDuration: "5" }, h.action(dial, "Dial"));
  await h.request("contactStatus", { CallSid: "CAchild", ParentCallSid: "CAuser", CallStatus: "ringing", SequenceNumber: "1" }, query);
  const attempt = h.db.rows.incident_contact_attempts.find(a => a.channel === "voice");
  assert.equal(attempt.state, "completed"); assert.equal(attempt.outcome, "completed"); assert.ok(attempt.answeredAt);
  assert.ok(h.db.rows.incident_telephony_events.some(e => e.callStatus === "ringing"));
});

test("duplicate Dial callback persists once and cannot dial or resolve again", async () => {
  const h = telephonyHarness(); const dial = await h.request("helpFollowup", { Digits: "1" });
  const query = h.action(dial, "Dial"), body = { DialCallSid: "CAchild", DialCallStatus: "completed", DialCallDuration: "5" };
  await h.request("dialResult", body, query); await h.request("dialResult", body, query);
  assert.equal(h.db.rows.incident_telephony_events.filter(e => e.eventType === "dial-result").length, 1);
  assert.equal(h.db.rows.incident_contact_attempts.filter(a => a.channel === "voice").length, 1);
  assert.equal(h.resolutions, 0);
});

test("repeated authorization and concurrent API attempts emit at most one Dial", async () => {
  const h = telephonyHarness(); const query = { incidentId: h.id, attemptId: h.userAttemptId, turn: "same-menu" };
  const results = await Promise.all([h.request("helpFollowup", { Digits: "1" }, query), h.request("helpFollowup", { Digits: "1" }, query)]);
  assert.equal(results.reduce((n, r) => n + r.doc.getElementsByTagName("Dial").length, 0), 1);
  const pending = await h.request("comfort"); assert.ok(pending.response.includes(containmentMessage));
  assert.doesNotMatch(pending.response, /no one else/);
});

test("repeated still-help input does not reset scheduling twice", async () => {
  const h = telephonyHarness(); const query = { incidentId: h.id, attemptId: h.userAttemptId, turn: "same-help" };
  await h.request("postContactFollowup", { Digits: "2" }, query);
  const schedule = h.incident.nextActionAt;
  const second = await h.request("postContactFollowup", { Digits: "2", CallStatus: "in-progress" }, query);
  assert.equal(h.incident.nextActionAt, schedule); assert.equal(second.doc.getElementsByTagName("Dial").length, 0);
});

test("valid bound Press 1 resolves exactly once through atomic claim", async () => {
  const h = telephonyHarness(); const query = { incidentId: h.id, attemptId: h.userAttemptId, turn: "safe" };
  await h.request("postContactFollowup", { Digits: "1" }, query);
  await h.request("postContactFollowup", { Digits: "1" }, query);
  assert.equal(h.incident.status, "resolved"); assert.equal(h.resolutions, 1);
  assert.equal(h.db.rows.checkins.length, 1);
});

test("stale Press 1 cannot resolve newer incident; resolution race changes no user state", async () => {
  const h = telephonyHarness(); h.incident.status = "resolved";
  const newer = { ...h.incident, id: randomUUID(), status: "open", wellnessCallStatus: "help" };
  h.db.rows.incidents.push(newer);
  const result = await h.request("postContactFollowup", { Digits: "1" });
  assert.match(result.response, /cannot confirm/); assert.equal(newer.status, "open"); assert.equal(h.resolutions, 0);
  assert.equal(h.db.rows.users[0].safetyState, "concern"); assert.equal(h.db.rows.checkins?.length || 0, 0);
});

test("unbound, wrong SID, wrong attempt and malformed identities perform zero mutation", async () => {
  for (const mode of ["unbound", "sid", "attempt", "malformed"]) {
    const h = telephonyHarness(); const original = structuredClone(h.db.rows);
    const query = mode === "unbound" ? {} : { incidentId: mode === "malformed" ? "wrong" : h.id, attemptId: mode === "attempt" ? randomUUID() : h.userAttemptId };
    await h.request("postContactFollowup", { Digits: "1", CallSid: mode === "sid" ? "CAother" : "CAuser" }, query);
    assert.deepEqual(h.db.rows, original); assert.equal(h.resolutions, 0);
  }
});

for (const mode of ["legacy", "inconsistent", "valid"] as const) {
  test(`${mode} empty roster remains safe in production routes`, async () => {
    const h = telephonyHarness(0, mode);
    const result = await h.request("helpFollowup", { Digits: "1" });
    assert.equal(result.doc.getElementsByTagName("Dial").length, 0);
    assert.ok(result.response.includes(mode === "valid" ? exhaustedMessage : containmentMessage));
    assert.equal(h.incident.status, "open"); assert.equal(h.incident.wellnessCallStatus, "help");
    assert.equal(h.db.rows.incident_escalation_sequence.length, 0);
  });
}

test("authoritatively incident-bound legacy in-flight call concludes without synthetic attempts", async () => {
  const h = telephonyHarness(0, "legacy"); h.db.rows.incident_contact_attempts = [];
  const query = { incidentId: h.id };
  const result = await h.request("dialResult", { DialCallStatus: "completed", DialCallDuration: "5", DialCallSid: "CAlegacyChild" }, query);
  assert.match(result.response, /call has completed/);
  const help = await h.request("postContactFollowup", { Digits: "2" }, h.action(result));
  assert.ok(help.response.includes(containmentMessage));
  assert.equal(h.db.rows.incident_contact_attempts.length, 0); assert.equal(h.incident.status, "open");
});

test("event persistence failure returns retryable error before aggregate or safety mutation", async () => {
  const h = telephonyHarness(); h.db.failInsert = "incident_telephony_events";
  const original = structuredClone(h.db.rows);
  const result = await h.request("postContactFollowup", { Digits: "1" });
  assert.equal(result.status, 503); assert.deepEqual(h.db.rows, original); assert.equal(h.resolutions, 0);
});

test("live edit, reorder and deletion cannot retarget an active snapshot", async () => {
  const h = telephonyHarness();
  h.db.rows.contacts = [{ id: h.db.rows.incident_escalation_sequence[0].contactId, phone: "+15555559999", priority: 9, softDeletedAt: new Date() }];
  const dial = await h.request("helpFollowup", { Digits: "1" });
  assert.equal(dial.doc.getElementsByTagName("Number")[0].textContent, "+15555550100");
  assert.equal(h.db.rows.incident_escalation_sequence.length, 3);
});
