import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { and, eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { DOMParser } from "@xmldom/xmldom";
import { incidents } from "../../../lib/stillhere-shared/src/schema";

// Compile the actual production helpers and route registrations, without
// importing routes.ts (which loads database/provider modules). No handler or
// decision logic is copied. Only persistence and external effects are mocked.
const source = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("routes.ts", source, ts.ScriptTarget.Latest, true);
const helpers = new Set([
  "isContactActiveForAlerts", "wellnessEscalationMessage",
  "getWellnessEscalationState", "wellnessComfortUrl", "wellnessHelpAcknowledgement",
]);
const paths = new Set([
  "/api/wellness-call/gather",
  "/api/wellness-call/help-followup", "/api/wellness-call/dial-result",
  "/api/wellness-call/post-contact-followup", "/api/wellness-call/comfort",
]);
const parts: string[] = [];
let helperCount = 0;
let routeCount = 0;
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name && helpers.has(node.name.text)) {
    parts.push(node.getText(tree));
    helperCount++;
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "calm") {
    parts.push(`const ${node.getText(tree)};`);
    helperCount++;
  }
  if (ts.isCallExpression(node) && node.expression.getText(tree) === "app.post"
    && ts.isStringLiteral(node.arguments[0]) && paths.has(node.arguments[0].text)) {
    parts.push(`${node.getText(tree)};`);
    routeCount++;
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.equal(helperCount, 6);
assert.equal(routeCount, 5);
const compiled = ts.transpileModule(parts.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const dialect = new PgDialect();
const fallback = "There is no one else in your Safety Circle available to contact. If you are in immediate danger, please contact your local emergency services now.";
const activeMessage = "You are still marked as needing help. We are continuing your Safety Circle escalation.";
const forbidden = /reaching out|we will keep them updated|we keep trying|alerting the next|attempting to reach|still trying to reach|have reached out|has been contacted|on the way|safety circle has already been alerted/i;
const contact = (id: string, priority = 1, extra = {}) => ({
  id, priority, name: id, phone: "+15555550101", userId: "user-1",
  softDeletedAt: null, pausedUntil: null, ...extra,
});
const openIncident = (extra = {}) => ({
  id: "incident-1", userId: "user-1", status: "open", isDrill: false,
  wellnessCallStatus: "help", escalationTimeline: "[]", notifiedContactIds: '["contact-1"]',
  lastEscalationStep: "wellness_call_help", escalationLevel: 1,
  nextActionAt: new Date("2030-01-01"), processingLockId: "worker", processingLockedAt: new Date(),
  handledByContactId: null, claimedByContactId: "guardian-1", reason: "sos",
  deliveryFailed: true, degradedDelivery: true, ...extra,
});
type Row = ReturnType<typeof openIncident>;
function harness(options: { row?: Row | null; contacts?: ReturnType<typeof contact>[]; user?: boolean; gather?: boolean; delivered?: string[] } = {}) {
  let row = options.row === undefined ? openIncident() : options.row;
  let circle = options.contacts ?? [contact("contact-1")];
  let beforeWrite: (() => void) | undefined;
  let beforeRead: ((count: number) => void) | undefined;
  let reads = 0;
  let mockNotifications = 0;
  let failRead = false;
  let writes = 0;
  let resolves = 0;
  let outbound = 0;
  const errors: unknown[] = [];
  const routes = new Map<string, Function>();
  const clone = <T>(value: T): T => structuredClone(value);
  const noOutbound = () => { outbound++; throw new Error("Outbound forbidden in hermetic test"); };
  const storage = {
    async getUserByPhone() { return options.user === false ? null : { id: "user-1", name: "User", ...(options.gather ? { phone: "+15555550102" } : {}) }; },
    async getLatestRealOpenIncident() {
      beforeRead?.(++reads);
      if (failRead) throw new Error("Simulated database failure");
      return row?.status === "open" && !row.isDrill ? clone(row) : undefined;
    },
    // Include removed entries to assert that the production active predicate
    // also rejects them, even though real getContacts already filters them.
    async getContacts() { return clone(circle); },
    async createIncidentWithSafetyState() {
      assert.ok(options.gather, "only initial-gather tests may use this existing path");
      assert.ok(row);
      return clone(row);
    },
    async getOrMintIncidentTokensForUser() { return circle.map(c => ({ contact: c, token: `test-${c.id}` })); },
    async getContactsLinkedToUser() { return []; },
    async updateIncident(id: string, patch: Partial<Row>) {
      assert.equal(id, row?.id);
      writes++;
      Object.assign(row!, patch);
      return clone(row);
    },
  };
  const db = { update(table: unknown) {
    assert.equal(table, incidents);
    return { set(patch: Record<string, any>) { return { where(predicate: any) {
      return { async returning() {
        beforeWrite?.();
        const query = dialect.sqlToQuery(predicate);
        // Verify the actual Drizzle predicate guards identity, owner, open
        // status and real incidents. The mock evaluates that guarded write.
        assert.equal(query.sql, '("incidents"."id" = $1 and "incidents"."user_id" = $2 and "incidents"."status" = $3 and "incidents"."is_drill" = $4)');
        const [id, userId, status, isDrill] = query.params;
        assert.equal(status, "open");
        assert.equal(isDrill, false);
        if (!row || row.id !== id || row.userId !== userId || row.status !== status || row.isDrill !== isDrill) return [];
        assert.deepEqual(Object.keys(patch).sort(), ["wellnessCallStatus", "escalationTimeline", "nextActionAt", "processingLockId", "processingLockedAt"].sort());
        const timeline = dialect.sqlToQuery(patch.escalationTimeline);
        assert.match(timeline.sql, /COALESCE.*NULLIF.*::jsonb \|\| \$1::jsonb/);
        const entries = JSON.parse(timeline.params[0] as string);
        const appended = JSON.stringify([...JSON.parse(row.escalationTimeline || "[]"), ...entries]);
        Object.assign(row, patch, { escalationTimeline: appended });
        writes++;
        return [{ id: row.id }];
      } };
    } }; } };
  } };
  runInNewContext(compiled, {
    app: { post(path: string, _signature: unknown, handler: Function) { routes.set(path, handler); } },
    verifyTwilioSignature() {}, storage, db, incidents, and, eq, sql, Date,
    escapeXml: (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"),
    getTwilioVoiceFromNumber: () => "+15555550100",
    // The initial production path already has SMS/push side effects before
    // rendering its menu. Simulate those boundaries, never load providers.
    // Other routes still reject use of the emergency-number heuristic.
    getEmergencyInfoForUser: options.gather ? async () => ({ number: "12345", country: null }) : noOutbound,
    sendSms: options.gather ? async () => ({ success: false }) : noOutbound,
    sendPushNotification: options.gather ? async () => ({ sent: 0 }) : noOutbound,
    sendEmergencyEmail: noOutbound, fetch: noOutbound,
    sendSosAlert: noOutbound,
    async tryNotifyContact() {
      assert.ok(options.gather);
      mockNotifications++;
      return { attempted: ["sms"], delivered: options.delivered ?? [] };
    },
    emitTrackingPolicyChanged: async () => {}, notifyConcern: async () => {},
    getBaseUrl: () => "https://test.invalid",
    addMinutes: (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60000),
    async resolveCheckin(userId: string, method: string, metadata: unknown) {
      assert.equal(userId, "user-1"); assert.equal(method, "call");
      assert.equal(JSON.stringify(metadata), '{"resolvedBy":"user"}');
      resolves++;
      if (row) { row.status = "resolved"; row.nextActionAt = null as any; }
      return { hadIncident: !!row };
    },
    console: { log() {}, error(...args: unknown[]) { errors.push(args); } },
  });
  async function request(path: string, digits = "2", query: Record<string, any> = { incidentId: "incident-1" }, body = {}) {
    let response = "";
    const res = { type(value: string) { assert.equal(value, "text/xml"); return res; }, send(value: string) { response = value; return res; } };
    await routes.get(`/api/wellness-call/${path}`)!({ body: { To: "+15555550102", Digits: digits, ...body }, query }, res);
    assert.ok(response);
    const xmlErrors: string[] = [];
    const doc = new DOMParser({ errorHandler: { warning: m => xmlErrors.push(m), error: m => xmlErrors.push(m), fatalError: m => xmlErrors.push(m) } }).parseFromString(response, "text/xml");
    assert.deepEqual(xmlErrors, []);
    assert.doesNotMatch(response, forbidden);
    assert.equal(outbound, 0);
    return { response, doc };
  }
  return {
    request, get row() { return row; }, get writes() { return writes; }, get resolves() { return resolves; }, errors,
    get mockNotifications() { return mockNotifications; },
    beforeRead(fn: (count: number) => void) { beforeRead = fn; },
    beforeWrite(fn: () => void) { beforeWrite = fn; }, setRow(next: Row | null) { row = next; },
    setContacts(next: ReturnType<typeof contact>[]) { circle = next; }, failRead() { failRead = true; },
  };
}

function assertHelpPreserved(h: ReturnType<typeof harness>, before: Row) {
  assert.equal(h.row?.status, "open");
  assert.equal(h.row?.wellnessCallStatus, "help");
  assert.equal(h.resolves, 0);
  assert.ok(h.row!.nextActionAt.getTime() <= Date.now());
  assert.equal(h.row!.processingLockId, null);
  assert.equal(h.row!.processingLockedAt, null);
  for (const key of ["notifiedContactIds", "lastEscalationStep", "escalationLevel", "handledByContactId", "claimedByContactId", "reason", "deliveryFailed", "degradedDelivery"] as const) {
    assert.equal(h.row![key], before[key], `${key} must remain engine-owned`);
  }
  assert.equal(JSON.parse(h.row!.escalationTimeline).at(-1).type, "still_need_help");
  assert.deepEqual(h.errors, []);
}

test("single consumed contact: neutral engine status, no new-person promise or resolution", async () => {
  const before = openIncident();
  const h = harness({ row: structuredClone(before) });
  const { response } = await h.request("post-contact-followup");
  assert.match(response, new RegExp(activeMessage.replace(/\./g, "\\.")));
  assertHelpPreserved(h, before);
});

test("multiple eligible contacts: no reachability inference and existing ordering/state preserved", async () => {
  const before = openIncident({ notifiedContactIds: "not-json" });
  const h = harness({ row: structuredClone(before), contacts: [contact("third", 3), contact("first", 1), contact("second", 2)] });
  assert.ok((await h.request("post-contact-followup")).response.includes(activeMessage));
  assertHelpPreserved(h, before);
  const comfort = await h.request("comfort", "", { incidentId: before.id, cycle: "1" });
  assert.match(comfort.response, /connected directly to first/);
  const dial = await h.request("help-followup", "1");
  assert.match(dial.doc.getElementsByTagName("Dial")[0].getAttribute("action")!, /contactId=first&incidentId=incident-1/);
});

test("zero eligible contacts: exact neutral fallback while independent escalation stays active", async () => {
  const before = openIncident();
  const h = harness({ row: structuredClone(before), contacts: [] });
  const { response } = await h.request("post-contact-followup");
  assert.ok(response.includes(fallback));
  assert.doesNotMatch(response, /911|000|112/);
  assertHelpPreserved(h, before);
});

test("paused/removed contacts excluded; expired pause remains eligible", async () => {
  const h = harness({ contacts: [contact("paused", 1, { pausedUntil: "2999-01-01" }), contact("removed", 2, { softDeletedAt: "2020-01-01" })] });
  assert.ok((await h.request("post-contact-followup")).response.includes(fallback));
  h.setContacts([contact("unpaused", 1, { pausedUntil: "2000-01-01" })]);
  assert.ok((await h.request("comfort")).response.includes(activeMessage));
});

test("every comfort cycle and scoped menu preserve certainty, including emergency guidance", async () => {
  for (const circle of [[], [contact("contact-1")]]) {
    const h = harness({ contacts: circle });
    await h.request("post-contact-followup");
    const writes = h.writes;
    for (const cycle of ["1", "2", "3"]) {
      const { response, doc } = await h.request("comfort", "", { incidentId: "incident-1", cycle });
      assert.ok(response.includes(circle.length ? activeMessage : fallback));
      assert.doesNotMatch(response, /911|000|112/);
      if (cycle !== "3") assert.match(doc.getElementsByTagName("Gather")[0].getAttribute("action")!, /incidentId=incident-1/);
      else assert.equal(doc.getElementsByTagName("Hangup").length, 1);
    }
    for (const digits of ["0", "", "9"]) {
      const { response } = await h.request("help-followup", digits);
      assert.doesNotMatch(response, /911|000|112/);
      assert.match(response, /incidentId=incident-1/);
    }
    assert.equal(h.writes, writes);
    assert.equal(h.row?.status, "open");
    assert.deepEqual(h.errors, []);
  }
});

test("completed contact conversation then Press 1 retains production resolution path", async () => {
  const h = harness();
  const result = await h.request("dial-result", "", { contactId: "contact-1", incidentId: "incident-1" }, { DialCallStatus: "completed", DialCallDuration: "30" });
  const action = result.doc.getElementsByTagName("Gather")[0].getAttribute("action")!;
  assert.match(action, /post-contact-followup\?incidentId=incident-1/);
  assert.equal(JSON.parse(h.row!.escalationTimeline).at(-1).type, "contact_reached");
  const { response } = await h.request("post-contact-followup", "1");
  assert.match(response, /Wonderful/);
  assert.equal(h.resolves, 1);
  assert.equal(h.row?.status, "resolved");
  assert.equal(h.row?.wellnessCallStatus, "safe");
  assert.deepEqual(h.errors, []);
});

test("resolution before stale Press 2: no writes or restart; newer incident is also protected", async () => {
  for (const row of [openIncident({ status: "resolved", wellnessCallStatus: "safe" }), openIncident({ id: "new-incident" })]) {
    const before = structuredClone(row);
    const h = harness({ row });
    const { response } = await h.request("post-contact-followup");
    assert.match(response, /cannot confirm an active safety incident/);
    assert.equal(h.writes, 0);
    assert.equal(h.resolves, 0);
    assert.deepEqual(h.row, before);
    assert.deepEqual(h.errors, []);
  }
});

test("resolution between read and conditional write cannot resurrect or overwrite incident", async () => {
  const h = harness();
  h.beforeWrite(() => { h.row!.status = "resolved"; h.row!.wellnessCallStatus = "safe"; });
  const { response } = await h.request("post-contact-followup");
  assert.match(response, /cannot confirm an active safety incident/);
  assert.equal(h.writes, 0);
  assert.equal(h.row?.status, "resolved");
  assert.equal(h.row?.wellnessCallStatus, "safe");
  assert.equal(h.row?.escalationTimeline, "[]");
  assert.equal(h.row?.nextActionAt.toISOString(), "2030-01-01T00:00:00.000Z");
  assert.deepEqual(h.errors, []);
});

test("no incident, missing user, drill, and missing/malformed binding fail closed", async () => {
  for (const options of [{ row: null }, { user: false }, { row: openIncident({ isDrill: true }) }]) {
    const h = harness(options);
    assert.match((await h.request("post-contact-followup")).response, /cannot confirm an active safety incident/);
    assert.equal(h.writes, 0);
    assert.deepEqual(h.errors, []);
  }
  for (const query of [{}, { incidentId: "" }, { incidentId: ["incident-1"] }, { incidentId: "wrong" }]) {
    const h = harness();
    assert.match((await h.request("post-contact-followup", "2", query)).response, /cannot confirm an active safety incident/);
    assert.equal(h.writes, 0);
    assert.equal(h.resolves, 0);
  }
});

test("continuation rechecks resolution, eligibility changes, and read failures without false assurance", async () => {
  const h = harness();
  await h.request("post-contact-followup");
  h.setContacts([]);
  assert.ok((await h.request("comfort")).response.includes(fallback));
  h.row!.status = "resolved";
  assert.match((await h.request("comfort")).response, /cannot confirm an active safety incident/);
  assert.match((await h.request("help-followup", "1")).response, /cannot confirm an active safety incident/);
  h.failRead();
  for (const path of ["post-contact-followup", "comfort", "help-followup"]) {
    assert.match((await h.request(path)).response, /cannot confirm an active safety incident/);
  }
  assert.equal(h.writes, 1);
  assert.equal(h.errors.length, 3);
});

test("atomic append retains concurrent timeline entries and restores explicit help status", async () => {
  const before = openIncident({ wellnessCallStatus: "no_response" });
  const h = harness({ row: structuredClone(before) });
  h.beforeWrite(() => { h.row!.escalationTimeline = '[{"type":"concurrent_event"}]'; });
  assert.ok((await h.request("post-contact-followup")).response.includes(activeMessage));
  assertHelpPreserved(h, before);
  assert.deepEqual(JSON.parse(h.row!.escalationTimeline).map((entry: any) => entry.type), ["concurrent_event", "still_need_help"]);
});


test("bound failed dial and missing primary phone never return to heuristic/unsupported guidance", async () => {
  const h = harness({ contacts: [contact("no-phone", 1, { phone: "" }), contact("second", 2)] });
  const missing = await h.request("help-followup", "1");
  assert.match(missing.response, /local emergency services/);
  assert.doesNotMatch(missing.response, /911|000|112/);
  h.setContacts([]);
  const failed = await h.request("dial-result", "", { incidentId: "incident-1", contactId: "old-contact" }, { DialCallStatus: "failed", DialCallDuration: "0" });
  assert.ok(failed.response.includes(fallback));
  assert.match(failed.doc.getElementsByTagName("Redirect")[0].textContent!, /incidentId=incident-1/);
  assert.equal(h.row?.status, "open");
  assert.equal(h.resolves, 0);
  assert.deepEqual(h.errors, []);
});


function assertNoContactClaim(response: string) {
  assert.doesNotMatch(response, /\b(alerting|contacting|notified|sent|calling)\b|reaching out|already been alerted|keep them updated/i);
  assert.doesNotMatch(response, /12345|911|000|112/);
}

test("initial Gather binds its authoritative incident and Press 0 uses the bound guard", async () => {
  const h = harness({ gather: true, row: openIncident({ id: "call-incident-7", wellnessCallStatus: "no_response" }) });
  // Caller-supplied context is not a source for the newly rendered binding.
  const menu = await h.request("gather", "2", { incidentId: "untrusted-other-incident" });
  const action = menu.doc.getElementsByTagName("Gather")[0].getAttribute("action")!;
  assert.equal(action, "/api/wellness-call/help-followup?incidentId=call-incident-7");
  assertNoContactClaim(menu.response);
  assert.match(menu.response, /You are marked as needing help. Your alert remains active./);
  const url = new URL(action, "https://test.invalid");
  const guidance = await h.request("help-followup", "0", Object.fromEntries(url.searchParams));
  assert.match(guidance.response, /local emergency services/);
  assert.match(guidance.response, /incidentId=call-incident-7/);
  assertNoContactClaim(guidance.response);
  assert.equal(h.row?.status, "open");
  assert.equal(h.row?.wellnessCallStatus, "help");
  assert.equal(h.resolves, 0);
  assert.ok(h.row!.nextActionAt > new Date());
  assert.equal(h.mockNotifications, 1, "existing notification processing is still invoked (mocked)");
  assert.deepEqual(h.errors, []);
});

test("notification summaries, including in-app-only success, never become spoken dispatch proof", async () => {
  for (const delivered of [[], ["in_app"], ["sms"]]) {
    const h = harness({ gather: true, delivered, row: openIncident({ wellnessCallStatus: "no_response" }) });
    const menu = await h.request("gather");
    assertNoContactClaim(menu.response);
    assert.match(menu.response, /You are marked as needing help/);
    assert.equal(h.mockNotifications, 1);
    assert.deepEqual(h.errors, []);
  }
});

test("duplicate help acknowledges stored help without pretending to dispatch again", async () => {
  for (const circle of [[contact("contact-1")], [], [contact("paused", 1, { pausedUntil: "2999-01-01" }), contact("removed", 2, { softDeletedAt: "2020-01-01" })]]) {
    const h = harness({ contacts: circle, row: openIncident({ notifiedContactIds: '["contact-1"]' }) });
    const reply = await h.request("gather");
    assertNoContactClaim(reply.response);
    if (circle.length === 1) assert.match(reply.response, /You are marked as needing help. Your alert remains active./);
    else assert.ok(reply.response.includes(fallback));
    assert.match(reply.response, /incidentId=incident-1/);
    assert.equal(h.mockNotifications, 0);
    assert.equal(h.writes, 0);
    assert.deepEqual(h.errors, []);
  }
});

test("initial zero-contact menu and its bound Press 0 preserve exact fallback and open incident", async () => {
  const h = harness({ gather: true, contacts: [], row: openIncident({ wellnessCallStatus: "no_response" }) });
  const menu = await h.request("gather");
  assert.ok(menu.response.includes(fallback));
  assertNoContactClaim(menu.response);
  const action = menu.doc.getElementsByTagName("Gather")[0].getAttribute("action")!;
  const guidance = await h.request("help-followup", "0", Object.fromEntries(new URL(action, "https://test.invalid").searchParams));
  assert.ok(guidance.response.includes(fallback));
  assertNoContactClaim(guidance.response);
  assert.equal(h.row?.status, "open");
  assert.equal(h.row?.wellnessCallStatus, "help");
  assert.equal(h.resolves, 0);
  assert.deepEqual(h.errors, []);
});

test("missing or stale initial-menu binding fails closed instead of adopting another incident", async () => {
  for (const duplicate of [true, false]) {
    for (const replacement of [null, openIncident({ status: "resolved" }), openIncident({ id: "replacement-incident" })]) {
      const h = harness({ gather: true, row: openIncident({ wellnessCallStatus: duplicate ? "help" : "no_response" }) });
      h.beforeRead(count => { if (count === 2) h.setRow(replacement); });
      const result = await h.request("gather");
      assert.match(result.response, /cannot confirm an active safety incident/);
      assert.equal(result.doc.getElementsByTagName("Gather").length, 0);
      assert.equal(result.doc.getElementsByTagName("Redirect").length, 0);
      assertNoContactClaim(result.response);
      assert.deepEqual(h.row, replacement);
      assert.equal(h.resolves, 0);
      assert.deepEqual(h.errors, []);
    }
  }
});

test("legacy unbound Press 0 never infers an incident, dispatch or emergency number", async () => {
  for (const row of [openIncident(), null, openIncident({ status: "resolved" })]) {
    const h = harness({ row });
    const result = await h.request("help-followup", "0", {});
    assert.match(result.response, /cannot confirm an active safety incident/);
    assertNoContactClaim(result.response);
    assert.equal(result.doc.getElementsByTagName("Hangup").length, 1);
    assert.equal(h.writes, 0);
    assert.deepEqual(h.errors, []);
  }
});
