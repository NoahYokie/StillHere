import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { and, eq, ne, desc, isNull, sql } from "drizzle-orm";
import { DOMParser } from "@xmldom/xmldom";
import { incidents, users, guardianActivityReviews } from "../../../lib/stillhere-shared/src/schema";
import { createOpeningSnapshot, readOpeningRoster } from "../server/escalation-snapshot";
import { claimIncidentSafetyConfirmation, containmentMessage, unboundMessage } from "../server/incident-telephony";
import { wellnessActionUrl } from "../server/wellness-contact-routes";
import { classifyWellnessStatusCallback, classifyWellnessTwiMLAnswer, shouldAccelerateContactEscalation } from "../server/wellness-call-intelligence";
import { MemoryDatabase, telephonyHarness } from "./telephony-harness";

const compile = (s: string) => ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
export function creationMethods(db: MemoryDatabase) {
  const source = readFileSync(new URL("../server/storage.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("storage.ts", source, ts.ScriptTarget.Latest, true);
  const names = new Set(["createIncident", "createIncidentWithSafetyState", "supersedePreviousIncidentTx", "cancelDrillIncidentTx"]);
  const parts: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isMethodDeclaration(node) && names.has(node.name.getText(tree))) parts.push(node.getText(tree).replace(/^private /, "").replace(/^async /, "async function "));
    if (ts.isFunctionDeclaration(node) && ["inferIncidentType", "getIncidentLevel"].includes(node.name?.text || "")) parts.push(node.getText(tree).replace(/^export /, ""));
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "INCIDENT_LEVEL_BY_TYPE") parts.push("const " + node.getText(tree) + ";");
    ts.forEachChild(node, visit);
  } visit(tree);
  const context: any = { db, incidents, users, guardianActivityReviews, eq, and, ne, desc, sql, createOpeningSnapshot, readOpeningRoster, console: { log() {} } };
  runInNewContext(compile(parts.join("\n")), context);
  const storage: any = { getUser: async (id: string) => db.rows.users?.find(u => u.id === id), createGuardianReviewsTx: async () => {} };
  for (const name of names) storage[name] = (...args: unknown[]) => context[name].apply(storage, args);
  return storage;
}

export function initialWellnessHarness(count = 3, mode: "valid" | "legacy" | "inconsistent" = "valid") {
  const h = telephonyHarness(count, mode);
  const source = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("routes.ts", source, ts.ScriptTarget.Latest, true);
  const helpers = new Set(["isContactActiveForAlerts", "wellnessEscalationMessage", "wellnessStatusRank", "updateWellnessCallStatusForIncident", "bindInitialWellness", "getWellnessEscalationState", "wellnessComfortUrl", "wellnessHelpAcknowledgement"]);
  const paths = new Set(["/api/wellness-call/respond", "/api/wellness-call/status", "/api/wellness-call/gather"]);
  const parts: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && helpers.has(node.name?.text || "")) parts.push(node.getText(tree));
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "calm") parts.push("const " + node.getText(tree) + ";");
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "app.post" && ts.isStringLiteral(node.arguments[0]) && paths.has(node.arguments[0].text)) parts.push(node.getText(tree) + ";");
    ts.forEachChild(node, visit);
  } visit(tree);
  const routes = new Map<string, Function>(); let notifications = 0; let creates = 0;
  const errors: unknown[] = []; const creator = creationMethods(h.db);
  Object.assign(h.incident, { reason: "sos", escalationTimeline: "[]", wellnessCallStatus: "placed" });
  Object.assign(h.db.rows.users[0], { name: "Test user", phone: "+15555550199" });
  h.db.rows.contacts = h.db.rows.incident_escalation_sequence.map(r => ({ id: r.contactId, userId: h.userId, name: r.displayName, phone: r.destination, priority: r.priorityRank, circleRole: r.role, pausedUntil: null, softDeletedAt: null }));
  const storage: any = {
    getUser: creator.getUser,
    getContacts: async () => h.db.rows.contacts.filter(c => !c.softDeletedAt),
    getContactsLinkedToUser: async () => [],
    createIncidentWithSafetyState: async (...args: unknown[]) => { creates++; return creator.createIncidentWithSafetyState(...args); },
    getOrMintIncidentTokensForUser: async () => h.db.rows.contacts.map(contact => ({ contact, token: "test-token" })),
    updateIncident: async (id: string, patch: any) => { const row = h.db.rows.incidents.find(i => i.id === id); Object.assign(row, patch); return structuredClone(row); },
  };
  const context: any = {
    app: { post(path: string, _signature: unknown, handler: Function) { routes.set(path, handler); } },
    verifyTwilioSignature() {}, incidentTelephony: h.ledger, storage, db: h.db, incidents, and, eq, isNull, sql,
    wellnessActionUrl, containmentMessage, unboundMessage,
    classifyWellnessStatusCallback, classifyWellnessTwiMLAnswer, shouldAccelerateContactEscalation,
    escapeXml: (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
    console: { log() {}, error(...args: unknown[]) { errors.push(args); } },
    emitTrackingPolicyChanged: async () => {}, notifyConcern: async () => {}, emitToUser() {},
    appendIncidentTimelineEntry: async () => {},
    getBaseUrl: () => "https://test.invalid", getEmergencyInfoForUser: async () => ({ number: "test-only", country: null }),
    addMinutes: (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60000),
    sendSms: async () => ({ success: false }), sendPushNotification: async () => ({ sent: 0 }),
    sendSosAlert: () => { throw new Error("Provider call forbidden"); },
    tryNotifyContact: async () => { notifications++; return { attempted: ["inapp"], delivered: ["inapp"] }; },
    resolveCheckin: async (userId: string, method: string, options: any) => {
      if (method !== "call" || !options.boundIncidentId) throw new Error("Unbound resolution forbidden");
      const row = await claimIncidentSafetyConfirmation(h.db, options.boundIncidentId, userId, options.expectedHelp);
      return { resolved: !!row, hadIncident: !!row };
    },
  };
  runInNewContext(compile(parts.join("\n")), context);
  async function initial(path: "respond" | "status" | "gather", body: any = {}, query: any = { incidentId: h.id, attemptId: h.userAttemptId, turn: path }) {
    let response = "", status = 200;
    const res: any = { type() { return res; }, status(n: number) { status = n; return res; }, send(v: string) { response = v; return res; } };
    await routes.get("/api/wellness-call/" + path)!({ body: { CallSid: "CAuser", ...body }, query }, res);
    return { response, status, doc: new DOMParser().parseFromString(response || "<Response/>", "text/xml") };
  }
  return { ...h, initial, errors, get notifications() { return notifications; }, get creates() { return creates; } };
}
