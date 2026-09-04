// Phase 2 test harness: incident-scoped watcher tokens.
//
// Run with: npx tsx script/test_incident_tokens.ts
//
// Touches the real DATABASE_URL. Creates and tears down its own throwaway
// user/contact rows; does not assume a specific seed.
//
// Tests (Codex spec numbers):
//   1. Incident token has purpose="incident" and ~24h TTL.
//   2. Same incident + same contact reuses the existing incident token.
//   3. New incident + same contact gets a fresh token.
//   4. Old standing token is not reused for an incident alert.
//   5. All-clear token remains purpose="allclear" and 4h TTL.
//   6. Settings/watcher-card flow still uses purpose="standing".
//   7. Single mint per (incident, contact) means SMS and email sent for the
//      same incident render the same /emergency/<token> link.
//   8. After incident resolution, the original incident token renders
//      mode="resolved" and exposes no live/last location.

import { db } from "../server/db";
import { users, contacts, contactTokens, incidents, checkins, locationSessions } from "../shared/schema";
import { eq, and } from "drizzle-orm";
import { storage } from "../server/storage";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function expect(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; failures.push(name + (detail ? ": " + detail : "")); console.log("  FAIL  " + name + (detail ? " - " + detail : "")); }
}

function randomPhone() {
  return "+614" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
}

async function makeUser(suffix: string) {
  const phone = randomPhone();
  const [u] = await db.insert(users).values({
    name: "phase2-test-" + suffix,
    phone,
    ageConfirmed: true,
  }).returning();
  return u;
}

async function makeContact(userId: string, priority: number) {
  const [c] = await db.insert(contacts).values({
    userId,
    name: "watcher-" + priority,
    phone: randomPhone(),
    priority,
  }).returning();
  return c;
}

async function teardown(userId: string) {
  // Delete contact_tokens by joining through the user's contact rows. The
  // previous version mistakenly compared contactId to userId and leaked rows.
  const userContacts = await db.select().from(contacts).where(eq(contacts.userId, userId));
  for (const c of userContacts) {
    await db.delete(contactTokens).where(eq(contactTokens.contactId, c.id)).catch(() => {});
  }
  await db.delete(checkins).where(eq(checkins.userId, userId)).catch(() => {});
  await db.delete(locationSessions).where(eq(locationSessions.userId, userId)).catch(() => {});
  await db.delete(incidents).where(eq(incidents.userId, userId)).catch(() => {});
  await db.delete(contacts).where(eq(contacts.userId, userId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
}

async function main() {
  const user = await makeUser(String(Date.now()));
  const contact = await makeContact(user.id, 1);
  const contact2 = await makeContact(user.id, 2);

  try {
    // T1: incident token has purpose="incident" and 24h TTL.
    const incident1 = await storage.createIncident(user.id, "sos");
    const t1 = await storage.getOrMintIncidentTokensForUser(user.id, incident1.startedAt);
    const myT1 = t1.find(x => x.contact.id === contact.id);
    expect("T1 returned a token for the contact", !!myT1);
    const [row1] = await db.select().from(contactTokens).where(eq(contactTokens.token, myT1!.token));
    expect("T1 purpose=incident", row1.purpose === "incident", "got " + row1.purpose);
    const ttlMs1 = new Date(row1.expiresAt!).getTime() - new Date(row1.createdAt).getTime();
    const ttlHours1 = ttlMs1 / (60 * 60 * 1000);
    expect("T1 TTL ~24h", Math.abs(ttlHours1 - 24) < 0.01, "got " + ttlHours1 + "h");

    // T2: same incident + same contact reuses the existing incident token.
    const t2 = await storage.getOrMintIncidentTokensForUser(user.id, incident1.startedAt);
    const myT2 = t2.find(x => x.contact.id === contact.id);
    expect("T2 reuses same token within incident", myT2!.token === myT1!.token, "T1=" + myT1!.token + " T2=" + myT2!.token);

    // T3: new incident + same contact gets a fresh token.
    // Resolve incident1 and start incident2 with a clearly later startedAt.
    await storage.updateIncident(incident1.id, { status: "resolved", resolvedAt: new Date() });
    await new Promise(r => setTimeout(r, 50));
    // Force a startedAt strictly later than incident1's expiresAt-floor would
    // matter, by passing a `new Date()` after a tick.
    const incident2Start = new Date();
    const incident2 = await storage.createIncident(user.id, "sos");
    // createIncident defaults startedAt server-side; for a deterministic test
    // we pass a floor strictly greater than incident1.startedAt so the helper
    // cannot reuse. Use the just-captured incident2Start.
    const t3 = await storage.getOrMintIncidentTokensForUser(user.id, incident2Start);
    const myT3 = t3.find(x => x.contact.id === contact.id);
    expect("T3 new incident gets fresh token", myT3!.token !== myT1!.token, "got same token across incidents");
    const [row3] = await db.select().from(contactTokens).where(eq(contactTokens.token, myT3!.token));
    expect("T3 new token is purpose=incident", row3.purpose === "incident");

    // T4: old standing token is not reused for an incident alert.
    // Mint a standing token, then call the incident helper; verify the
    // returned token is NOT the standing one.
    const standing = await storage.generateToken(contact2.id, { ttlHours: 24, purpose: "standing" });
    const t4 = await storage.getOrMintIncidentTokensForUser(user.id, incident2Start);
    const myT4 = t4.find(x => x.contact.id === contact2.id);
    expect("T4 incident helper does not reuse standing token", myT4!.token !== standing.token);
    const [row4] = await db.select().from(contactTokens).where(eq(contactTokens.token, myT4!.token));
    expect("T4 minted token is purpose=incident", row4.purpose === "incident");

    // T5: all-clear token remains purpose="allclear" and 4h TTL.
    const allclear = await storage.generateToken(contact.id, { ttlHours: 4, purpose: "allclear" });
    const [rowAC] = await db.select().from(contactTokens).where(eq(contactTokens.token, allclear.token));
    expect("T5 allclear purpose preserved", rowAC.purpose === "allclear");
    const ttlAC = (new Date(rowAC.expiresAt!).getTime() - new Date(rowAC.createdAt).getTime()) / (60 * 60 * 1000);
    expect("T5 allclear TTL ~4h", Math.abs(ttlAC - 4) < 0.01, "got " + ttlAC + "h");

    // T6: settings/watcher-card flow (regenerateTokensForUser) still mints
    //     purpose="standing".
    // Use a fresh contact so prior incident tokens don't interfere.
    const contact3 = await makeContact(user.id, 3);
    const standingFlow = await storage.regenerateTokensForUser(user.id);
    const myStanding = standingFlow.find(x => x.contact.id === contact3.id);
    expect("T6 regenerate returned token for fresh contact", !!myStanding);
    const [rowS] = await db.select().from(contactTokens).where(eq(contactTokens.token, myStanding!.token));
    expect("T6 settings flow purpose=standing", rowS.purpose === "standing");

    // T7: single mint per (incident, contact) means SMS and email render the
    //     same /emergency/<token> link. The reuse property (T2) is the
    //     mechanism; here we assert it across two helper calls modeling the
    //     SMS path and the email path inside the same escalation tick.
    const smsCall = await storage.getOrMintIncidentTokensForUser(user.id, incident2Start);
    const emailCall = await storage.getOrMintIncidentTokensForUser(user.id, incident2Start);
    const smsLink = smsCall.find(x => x.contact.id === contact.id)!.token;
    const emailLink = emailCall.find(x => x.contact.id === contact.id)!.token;
    expect("T7 SMS and email links match within an incident", smsLink === emailLink);

    // T8: after resolution, the original incident token renders mode="resolved"
    //     and exposes no live/last location. Use the T3 token from incident2.
    // Resolve incident2 NOW and ensure the token was minted before that.
    const incident2Resolved = new Date();
    await storage.updateIncident(incident2.id, { status: "resolved", resolvedAt: incident2Resolved });
    const page = await storage.getContactPageData(myT3!.token);
    expect("T8 page exists", !!page);
    expect("T8 mode=resolved", page!.mode === "resolved", "got " + page?.mode);
    expect("T8 lastCheckin stripped", page!.lastCheckin === null);
    expect("T8 locationSession stripped", page!.locationSession === null);
    expect("T8 tripTrail stripped", page!.tripTrail.length === 0);
    expect("T8 incident stripped", page!.incident === null);
  } finally {
    await teardown(user.id);
  }

  console.log("\nResults: " + passed + " passed, " + failed + " failed.");
  if (failed > 0) {
    console.log("Failures:");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
