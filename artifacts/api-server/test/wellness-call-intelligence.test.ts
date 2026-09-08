import assert from "node:assert/strict";

const {
  classifyWellnessStatusCallback,
  classifyWellnessTwiMLAnswer,
  isMachineAnsweredBy,
  shouldAccelerateContactEscalation,
} = await import("../server/wellness-call-intelligence");

const human = classifyWellnessStatusCallback({
  callStatus: "in-progress",
  answeredBy: "human",
  durationSeconds: 3,
});
assert.equal(human.status, "answered_human", "human answer should be recorded as answered, not safe");
assert.equal(human.shouldAccelerateContacts, false, "human answer waits for keypad confirmation");

const noKeypad = classifyWellnessStatusCallback({
  callStatus: "completed",
  answeredBy: "",
  durationSeconds: 32,
});
assert.equal(noKeypad.status, "no_response", "connected call without keypad must not be treated as safe or voicemail");
assert.equal(noKeypad.shouldAccelerateContacts, true, "no keypad confirmation should continue escalation");
assert.equal(noKeypad.detail, "Wellness call connected — no safety confirmation received.");

for (const answeredBy of ["machine_start", "machine_end_beep", "machine_end_silence", "machine_end_other", "fax"]) {
  assert.equal(isMachineAnsweredBy(answeredBy), true, `${answeredBy} should be classified as machine/voicemail`);
  assert.equal(classifyWellnessTwiMLAnswer(answeredBy), "machine");
  const result = classifyWellnessStatusCallback({ callStatus: "completed", answeredBy, durationSeconds: 18 });
  assert.equal(result.status, "voicemail_left", `${answeredBy} should mark voicemail/no confirmation`);
  assert.equal(result.shouldAccelerateContacts, true, `${answeredBy} should advance contact escalation`);
}

const noAnswer = classifyWellnessStatusCallback({ callStatus: "no-answer", answeredBy: "", durationSeconds: 0 });
assert.equal(noAnswer.status, "no_response", "no-answer should be no response");
assert.equal(noAnswer.shouldAccelerateContacts, true);

for (const callStatus of ["busy", "failed", "canceled"]) {
  const result = classifyWellnessStatusCallback({ callStatus, answeredBy: "", durationSeconds: 0 });
  assert.equal(result.status, "failed", `${callStatus} should be recorded as failed/no confirmation`);
  assert.equal(result.shouldAccelerateContacts, true, `${callStatus} should continue escalation`);
}

assert.equal(classifyWellnessTwiMLAnswer("human"), "human");
assert.equal(classifyWellnessTwiMLAnswer(""), "unknown");

assert.equal(shouldAccelerateContactEscalation("safe"), false, "safe status must not accelerate contacts");
assert.equal(shouldAccelerateContactEscalation("help"), false, "help status has its own SOS fanout path");
assert.equal(shouldAccelerateContactEscalation("answered_human"), false, "answered human is not confirmation and waits for gather result");
assert.equal(shouldAccelerateContactEscalation("no_response"), true);
assert.equal(shouldAccelerateContactEscalation("voicemail_left"), true);
assert.equal(shouldAccelerateContactEscalation("failed"), true);

const orderedEvents = ["placed", "answered_human", "safe", "help", "voicemail_left", "no_response", "failed"];
assert.deepEqual(
  orderedEvents.map((status) => shouldAccelerateContactEscalation(status)),
  [false, false, false, false, true, true, true],
  "only no-confirmation outcomes should advance the contact escalation layer",
);

console.log("wellness-call-intelligence tests passed");
