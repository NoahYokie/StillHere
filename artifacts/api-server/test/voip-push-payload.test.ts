import assert from "node:assert/strict";

const { buildAPNsVoipPayload } = await import("../server/voip-push");

const payload = buildAPNsVoipPayload({
  callId: "11111111-1111-1111-1111-111111111111",
  callerId: "22222222-2222-2222-2222-222222222222",
  callerName: "Guardian",
  callType: "audio",
});

assert.deepEqual(payload.aps, {}, "VoIP push payload must include aps object");
assert.equal(payload.type, "incoming_call");
assert.equal(payload.callId, "11111111-1111-1111-1111-111111111111");
assert.equal(payload.callerId, "22222222-2222-2222-2222-222222222222");
assert.equal(payload.callerName, "Guardian");
assert.equal(payload.callType, "audio");
assert.equal(payload.uuid, payload.callId, "CallKit UUID must stay stable for this call");
assert.equal(
  payload.id,
  "11111111-1111-1111-1111-111111111111|22222222-2222-2222-2222-222222222222",
  "Native callback id must carry call and caller ids",
);

console.log("voip push payload tests passed");
