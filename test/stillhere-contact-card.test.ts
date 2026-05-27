import assert from "node:assert/strict";

const {
  buildStillHereContactVCard,
  PRE_CALL_SMS_BODY,
} = await import("../server/stillhere-contact-card");

const card = buildStillHereContactVCard("+15551234567");

assert.match(card, /^BEGIN:VCARD\r\nVERSION:3\.0\r\n/);
assert.match(card, /FN:StillHere Safety\r\n/);
assert.match(card, /ORG:StillHere\r\n/);
assert.match(card, /TEL;TYPE=VOICE,CELL:\+15551234567\r\n/);
assert.match(card, /NOTE:Emergency wellness and safety check-in line\.\r\n/);
assert.match(card, /END:VCARD\r\n$/);

assert.equal(
  PRE_CALL_SMS_BODY,
  "STILLHERE: We are calling you now regarding your missed safety check-in. Please answer to confirm you are safe.",
);

console.log("stillhere contact card tests passed");
