import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgresql://test:test@localhost:5432/test";

const { buildAPNsAlertPayload, buildAPNsBadgePayload } = await import("../server/push");

const alert = buildAPNsAlertPayload({
  title: "Message from Guardian",
  body: "Are you OK?",
  url: "/chat/user-1",
  tag: "new-message",
}, 3);

assert.equal(alert.aps.alert.title, "Message from Guardian");
assert.equal(alert.aps.alert.body, "Are you OK?");
assert.equal(alert.aps.badge, 3, "APNs alert payload must include absolute badge count");
assert.equal(alert.aps.sound, "default");
assert.equal(alert.url, "/chat/user-1");
assert.equal(alert.badgeCount, 3);

const noBadge = buildAPNsAlertPayload({ title: "StillHere", body: "Update" });
assert.equal("badge" in noBadge.aps, false, "badge should be omitted only when count was not computed");

const badgeOnly = buildAPNsBadgePayload(0);
assert.equal(badgeOnly.aps.badge, 0, "badge sync can clear the app icon badge");
assert.equal(badgeOnly.aps["content-available"], 1);
assert.equal(badgeOnly.tag, "badge-sync");

const clamped = buildAPNsBadgePayload(-5);
assert.equal(clamped.aps.badge, 0, "badge count must never be negative");

console.log("push badge payload tests passed");
