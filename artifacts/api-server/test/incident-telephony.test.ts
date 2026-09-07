import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSnapshotValidity } from "../server/escalation-snapshot";
import { providerDuration, providerTransition, rawTelephonyFields } from "../server/incident-telephony";

const timestamp = new Date("2030-01-01T00:00:00Z");
test("authoritative empty snapshot differs from unknown legacy roster", () => {
  assert.equal(resolveSnapshotValidity({ escalationSnapshotCreatedAt: timestamp, escalationSnapshotContactCount: 0 }, []), "valid");
  assert.equal(resolveSnapshotValidity({ escalationSnapshotCreatedAt: null, escalationSnapshotContactCount: null }, []), "legacy");
});
test("snapshot metadata and physical ordered roster must agree", () => {
  const metadata = { escalationSnapshotCreatedAt: timestamp, escalationSnapshotContactCount: 3 };
  assert.equal(resolveSnapshotValidity(metadata, [1, 2, 3].map(priorityRank => ({ priorityRank }))), "valid");
  assert.equal(resolveSnapshotValidity(metadata, [{ priorityRank: 1 }]), "inconsistent");
  assert.equal(resolveSnapshotValidity(metadata, [1, 1, 3].map(priorityRank => ({ priorityRank }))), "inconsistent");
  assert.equal(resolveSnapshotValidity({ escalationSnapshotCreatedAt: timestamp, escalationSnapshotContactCount: null }, []), "inconsistent");
  assert.equal(resolveSnapshotValidity({ escalationSnapshotCreatedAt: null, escalationSnapshotContactCount: 0 }, []), "inconsistent");
});
for (const duration of ["2", "5", "14", "15", "20", "60"]) {
  test(`completed/${duration} retains completed independently of duration`, () => {
    assert.equal(providerTransition("answered", "completed"), "completed");
    assert.equal(providerDuration(duration), Number(duration));
    const raw = rawTelephonyFields({ DialCallStatus: "completed", DialCallDuration: duration });
    assert.equal(raw.dialCallStatus, "completed");
    assert.equal(raw.dialCallDuration, duration);
  });
}
for (const status of ["busy", "no-answer", "failed", "canceled", "completed"]) {
  test(`${status} remains terminal after duplicate and late ringing`, () => {
    assert.equal(providerTransition("initiated", status), status);
    assert.equal(providerTransition(status, status), status);
    assert.equal(providerTransition(status, "ringing"), status);
  });
}
test("malformed and missing durations remain unknown rather than zero", () => {
  for (const raw of [null, "", "unknown", "14seconds", "-1", "0.5", "9999999999999999999999"]) {
    assert.equal(providerDuration(raw), null);
  }
  assert.equal(providerDuration("0"), 0);
});
test("raw evidence remains unmodified and excludes unrelated payload fields", () => {
  const raw = rawTelephonyFields({ DialCallStatus: "Completed", DialCallDuration: "malformed", CallSid: "parent", DialCallSid: "child", AnsweredBy: "unknown", Digits: "2", To: "+15555550100", AuthToken: "secret" });
  assert.equal(raw.dialCallStatus, "Completed");
  assert.equal(raw.dialCallDuration, "malformed");
  assert.equal(raw.callSid, "parent");
  assert.equal(raw.dialCallSid, "child");
  assert.equal("To" in raw, false);
  assert.equal("AuthToken" in raw, false);
});
