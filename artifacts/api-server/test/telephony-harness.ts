import { randomUUID } from "node:crypto";
import { getTableName, getTableColumns } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { DOMParser } from "@xmldom/xmldom";
import { IncidentTelephony, claimIncidentSafetyConfirmation } from "../server/incident-telephony";
import { createWellnessContactHandlers } from "../server/wellness-contact-routes";

const dialect = new PgDialect();
const copy = <T>(x: T): T => structuredClone(x);
export class MemoryDatabase {
  rows: Record<string, any[]> = {};
  trace: string[] = [];
  failInsert?: string;
  failUpdate?: string;
  beforeUpdate?: (table: string) => void;
  private queue: Promise<unknown> = Promise.resolve();
  table(t: any) { const name = getTableName(t); return this.rows[name] ||= []; }
  matches(table: any, predicate: any, row: any) {
    if (!predicate) return true;
    const q = dialect.sqlToQuery(predicate);
    const columns = getTableColumns(table);
    const key = (name: string) => Object.keys(columns).find(k => columns[k].name === name)!;
    let expression = q.sql.replace(/"[^"]+"\."([^"]+)"\s+is\s+(not\s+)?null/gi, (_m, col, not) => String(not ? row[key(col)] != null : row[key(col)] == null));
    expression = expression.replace(/"[^"]+"\."([^"]+)"\s*(<=|>=|<>|=|<|>)\s*\$(\d+)/g, (_m, col, op, n) => {
      let left = row[key(col)]; let right = q.params[Number(n) - 1];
      if (left instanceof Date) { left = left.getTime(); right = new Date(right as any).getTime(); }
      return String(op === "=" ? left === right : op === "<>" ? left !== right : op === "<=" ? left <= right : op === ">=" ? left >= right : op === "<" ? left < right : left > right);
    }).replace(/\band\b/gi, "&&").replace(/\bor\b/gi, "||");
    if (!/^[\s()truefals&|]+$/.test(expression)) throw new Error("Unsupported test SQL: " + expression);
    return Function("return " + expression)();
  }
  select(projection?: any) {
    const db = this; let table: any, predicate: any, cap = Infinity; let order: any[] = [];
    const query: any = {
      from(t: any) { table = t; return query; }, where(p: any) { predicate = p; return query; },
      orderBy(...cols: any[]) { order = cols; return query; }, limit(n: number) { cap = n; return query; }, for() { return query; },
      then(resolve: any, reject: any) {
        try {
          let rows = db.table(table).filter(r => db.matches(table, predicate, r));
          const columns = getTableColumns(table);
          for (const col of [...order].reverse()) {
            const key = Object.keys(columns).find(k => columns[k] === col);
            if (key) rows = [...rows].sort((a, b) => a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
          }
          rows = rows.slice(0, cap);
          if (projection) rows = rows.map(r => Object.fromEntries(Object.entries(projection).map(([k, col]) => [k, r[Object.keys(columns).find(x => columns[x] === col)!]])));
          return Promise.resolve(copy(rows)).then(resolve, reject);
        } catch (e) { return Promise.reject(e).then(resolve, reject); }
      },
    }; return query;
  }
  insert(table: any) {
    const db = this; const name = getTableName(table); let values: any[] = []; let ignore = false;
    const execute = () => {
      if (db.failInsert === name) throw new Error("Injected insert failure: " + name);
      const result: any[] = [];
      for (const value of values) {
        const defaults: any = Object.fromEntries(Object.keys(getTableColumns(table)).map(k => [k, null]));
        Object.assign(defaults, { id: randomUUID(), createdAt: new Date(), updatedAt: new Date() });
        if (name === "incident_contact_attempts") Object.assign(defaults, { cycle: 1, channel: "voice", state: "reserved" });
        if (name === "incidents") Object.assign(defaults, { status: "open", isDrill: false, wellnessCallStatus: null, startedAt: new Date() });
        const row = { ...defaults, ...copy(value) };
        const duplicate = db.table(table).some(r => r.id === row.id
          || (name === "incident_telephony_events" && r.eventKey === row.eventKey)
          || (name === "incident_escalation_sequence" && r.incidentId === row.incidentId && (r.priorityRank === row.priorityRank || r.contactId === row.contactId))
          || (name === "incident_contact_attempts" && row.sequenceId && r.incidentId === row.incidentId && r.sequenceId === row.sequenceId && r.cycle === row.cycle && r.channel === row.channel));
        if (duplicate) { if (ignore) continue; throw new Error("Unique violation: " + name); }
        db.table(table).push(row); result.push(copy(row)); db.trace.push("insert:" + name);
      } return result;
    };
    const query: any = { values(v: any) { values = Array.isArray(v) ? v : [v]; return query; }, onConflictDoNothing() { ignore = true; return query; }, returning() { return Promise.resolve().then(execute); }, then(resolve: any, reject: any) { return Promise.resolve().then(execute).then(resolve, reject); } }; return query;
  }
  update(table: any) {
    const db = this; const name = getTableName(table); let patch: any, predicate: any;
    const execute = () => {
      if (db.failUpdate === name) throw new Error("Injected update failure: " + name);
      db.beforeUpdate?.(name);
      const result = db.table(table).filter(r => db.matches(table, predicate, r));
      result.forEach(r => {
        for (const [key, value] of Object.entries(patch)) {
          if (value && typeof (value as any).getSQL === "function") {
            const q = dialect.sqlToQuery(value as any);
            if (key !== "escalationTimeline" || !q.sql.includes("::jsonb ||")) throw new Error("Unsupported SQL update in test");
            r[key] = JSON.stringify([...JSON.parse(r[key] || "[]"), ...JSON.parse(q.params[0] as string)]);
          } else r[key] = copy(value);
        }
      }); if (result.length) db.trace.push("update:" + name);
      return copy(result);
    };
    const query: any = { set(p: any) { patch = p; return query; }, where(p: any) { predicate = p; return query; }, returning() { return Promise.resolve().then(execute); }, then(resolve: any, reject: any) { return Promise.resolve().then(execute).then(resolve, reject); } }; return query;
  }
  execute() { return Promise.resolve({ rows: [] }); }
  transaction<T>(work: (tx: any) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const original = copy(this.rows); const trace = [...this.trace];
      try { return await work(this); } catch (error) { this.rows = original; this.trace = trace; throw error; }
    }); this.queue = run.catch(() => {}); return run;
  }
}

export function telephonyHarness(count = 3, metadata: "valid" | "legacy" | "inconsistent" = "valid") {
  const db = new MemoryDatabase();
  const id = randomUUID(), userId = randomUUID(), userAttemptId = randomUUID();
  const incident = { id, userId, status: "open", isDrill: false, wellnessCallStatus: "help", escalationSnapshotCreatedAt: metadata === "legacy" ? null : new Date(), escalationSnapshotContactCount: metadata === "legacy" ? null : count + (metadata === "inconsistent" ? 1 : 0), notifiedContactIds: '["existing-notification"]', nextActionAt: new Date(0), processingLockId: "worker", processingLockedAt: new Date(), lastEscalationStep: "wellness_call_help" };
  db.rows.incidents = [incident];
  db.rows.users = [{ id: userId, safetyState: "concern" }];
  db.rows.settings = [{ userId }];
  db.rows.incident_escalation_sequence = metadata === "legacy" ? [] : Array.from({ length: count }, (_, i) => ({ id: randomUUID(), incidentId: id, contactId: randomUUID(), priorityRank: i + 1, displayName: "C" + (i + 1), destination: "+1555555010" + i, role: "primary" }));
  db.rows.incident_contact_attempts = [{ id: userAttemptId, incidentId: id, sequenceId: null, channel: "wellness_voice", cycle: 1, state: "answered", parentCallSid: "CAuser", childCallSid: null, attemptedAt: new Date(), duration: null, outcome: null }];
  const telemetry: string[] = [];
  const ledger = new IncidentTelephony(db, { log: s => telemetry.push(s), error: s => telemetry.push(s) });
  let resolutions = 0;
  const handlers = createWellnessContactHandlers({ ledger, voiceFrom: () => "+15555550999", resolve: async (u, i) => { const row = await claimIncidentSafetyConfirmation(db, i, u); if (row) resolutions++; return { resolved: !!row }; } });
  async function request(kind: keyof typeof handlers, body: Record<string, any> = {}, query: Record<string, string> = { incidentId: id, attemptId: userAttemptId, turn: randomUUID() }) {
    let response = "", status = 200;
    const res: any = { type() { return res; }, status(n: number) { status = n; return res; }, send(v: string) { response = v; return res; } };
    await handlers[kind]({ body: { CallSid: "CAuser", ...body }, query } as any, res);
    const doc = new DOMParser().parseFromString(response || "<Response/>", "text/xml");
    return { response, status, doc };
  }
  function action(result: Awaited<ReturnType<typeof request>>, tag = "Gather", attr = "action") {
    const url = result.doc.getElementsByTagName(tag)[0]?.getAttribute(attr);
    if (!url) throw new Error("No " + tag + " " + attr + ": " + result.response);
    return Object.fromEntries(new URL(url, "https://test.invalid").searchParams);
  }
  return { db, ledger, incident, id, userId, userAttemptId, handlers, request, action, telemetry, get resolutions() { return resolutions; } };
}
