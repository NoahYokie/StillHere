import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { incidents, incidentEscalationSequence, incidentContactAttempts, incidentTelephonyEvents } from "../../../lib/stillhere-shared/src/schema";
const contract = readFileSync(new URL("../migrations/0011_incident_telephony_ledger.sql", import.meta.url), "utf8");
const generated = readFileSync(new URL("../review/15.10a/generated.sql", import.meta.url), "utf8");
const report = JSON.parse(readFileSync(new URL("../review/15.10a/generation.json", import.meta.url), "utf8"));
const tables = [incidentEscalationSequence, incidentContactAttempts, incidentTelephonyEvents];
const root = new URL("../../../", import.meta.url);
function bodies(sql: string) {
  return Object.fromEntries([...sql.replaceAll('"', '').matchAll(/CREATE TABLE (\w+) \(\n([\s\S]*?)\n\);/g)].map(m => [m[1], m[2]]));
}
function columns(body: string) {
  return Object.fromEntries(body.split("\n").map(s => s.trim()).filter(s => s && !s.startsWith("CONSTRAINT")).map(line => {
    const match = /^(\w+)\s+(timestamp with time zone|timestamptz|uuid|integer|text)\b/i.exec(line)!;
    assert.ok(match, line);
    return [match[1], { type: match[2].replace('timestamptz', 'timestamp with time zone'),
      notNull: /NOT NULL|PRIMARY KEY/i.test(line), primary: /PRIMARY KEY/i.test(line),
      default: /DEFAULT\s+(gen_random_uuid\(\)|now\(\)|'[^']*'|\d+)/i.exec(line)?.[1].toLowerCase() ?? null }];
  }));
}
function checks(sql: string): string[] {
  const result: string[] = [];
  const starts = [...sql.matchAll(/\bCHECK\s*\(/g)];
  for (const match of starts) {
    const start = match.index! + match[0].length;
    let depth = 1, end = start;
    for (; depth && end < sql.length; end++) {
      if (sql[end] === '(') depth++;
      if (sql[end] === ')') depth--;
    }
    assert.equal(depth, 0);
    result.push(sql.slice(start, end - 1).trim());
  }
  return result;
}
const checkNames = ['incident_snapshot_metadata_pair', 'incident_escalation_sequence_priority_rank_check', 'incident_contact_attempts_cycle_check', 'incident_contact_attempts_duration_check', 'incident_contact_attempts_outcome_source_check'];
const normalizeCheck = (s: string) => s.replace(/"[a-z_]+"\./g, '').replaceAll('"','').replace(/\s+/g, ' ').trim();

test("all five named declarative CHECK predicates match the exact audited SQL", () => {
  const configs = [incidents, ...tables].map(getTableConfig);
  const declared = configs.flatMap(c => c.checks);
  assert.deepEqual(declared.map(c => c.name), checkNames);
  const original = checks(contract);
  assert.equal(original.length, 5);
  const dialect = new PgDialect();
  for (let i = 0; i < declared.length; i++) {
    const query = dialect.sqlToQuery(declared[i].value);
    assert.deepEqual(query.params, []);
    assert.equal(normalizeCheck(query.sql), normalizeCheck(original[i]));
    assert.ok(generated.includes(`CONSTRAINT "${checkNames[i]}" CHECK (`));
  }
  assert.deepEqual(checks(generated).map(normalizeCheck).sort(), original.map(normalizeCheck).sort());
});

test("all new column types/defaults/nullability/primary keys match migration 0011", () => {
  const oldBodies = bodies(contract), newBodies = bodies(generated);
  assert.deepEqual(Object.keys(newBodies).sort(), Object.keys(oldBodies).sort());
  for (const name of Object.keys(oldBodies)) assert.deepEqual(columns(newBodies[name]), columns(oldBodies[name]), name);
  const config = getTableConfig(incidents);
  for (const name of ['escalation_snapshot_created_at', 'escalation_snapshot_contact_count']) {
    const col = config.columns.find(c => c.name === name)!;
    assert.equal(col.notNull, false); assert.equal(col.hasDefault, false);
  }
  assert.equal(incidentContactAttempts.duration.notNull, false);
  assert.equal(incidentContactAttempts.outcomeSource.notNull, false);
});

test("all five foreign-key targets and delete/update semantics match", () => {
  const actual = tables.flatMap(t => getTableConfig(t).foreignKeys.map(f => {
    const r = f.reference();
    return [getTableConfig(t).name, r.columns.map(c => c.name).join(','), getTableConfig(r.foreignTable).name, r.foreignColumns.map(c => c.name).join(','), f.onDelete || 'no action', f.onUpdate || 'no action'].join('|');
  })).sort();
  const expected = [
    'incident_escalation_sequence|incident_id|incidents|id|cascade|no action',
    'incident_contact_attempts|incident_id|incidents|id|cascade|no action',
    'incident_contact_attempts|sequence_id|incident_escalation_sequence|id|no action|no action',
    'incident_telephony_events|incident_id|incidents|id|cascade|no action',
    'incident_telephony_events|attempt_id|incident_contact_attempts|id|no action|no action',
  ].sort();
  assert.deepEqual(actual, expected);
  const sqlFks = [...generated.replaceAll('"','').matchAll(/ALTER TABLE (\w+) ADD CONSTRAINT \w+ FOREIGN KEY \((\w+)\) REFERENCES public\.(\w+)\((\w+)\) ON DELETE (cascade|no action) ON UPDATE (no action)/g)].map(m => m.slice(1).join('|')).sort();
  assert.deepEqual(sqlFks, expected);
  assert.equal((contract.match(/REFERENCES /g) || []).length, 5);
});

test("all seven explicit indexes retain names/order/uniqueness without partial predicates", () => {
  const normalize = (sql: string) => [...sql.replaceAll('"','').matchAll(/CREATE (UNIQUE )?INDEX (\w+) ON (\w+)(?: USING btree)?\s*\(([^)]+)\);/g)].map(m => [!!m[1],m[2],m[3],m[4].replaceAll(' ','')]).sort((a,b) => String(a[1]).localeCompare(String(b[1])));
  assert.equal(normalize(contract).length, 7);
  assert.deepEqual(normalize(generated), normalize(contract));
  assert.doesNotMatch(generated, /\bWHERE\b/);
});

test("offline delta contains only the Task 15.10A additions and no data/backfill statements", () => {
  assert.equal(report.statements.length, 18);
  assert.deepEqual(report.changedTables, ['public.incidents']);
  for (const stmt of report.statements) {
    assert.match(stmt, /^(CREATE TABLE|CREATE (UNIQUE )?INDEX|ALTER TABLE)/);
    assert.doesNotMatch(stmt, /\b(DROP|TRUNCATE)\b/);
    if (stmt.startsWith('ALTER TABLE "incidents"')) assert.match(stmt, /ADD (COLUMN "escalation_snapshot_(created_at|contact_count)"|CONSTRAINT "incident_snapshot_metadata_pair")/);
  }
  assert.equal(createHash('sha256').update(contract).digest('hex'), '3454bd48c1f4a4f9f69a4fe741421bac80bd340b56b8e57fed93d4fd7636a4a4');
  assert.equal(createHash('sha256').update(generated).digest('hex'), report.generatedSqlSha256);
});

test("post-merge preserves install and cannot automatically apply schema", () => {
  const hook = readFileSync(new URL('scripts/post-merge.sh',root),'utf8');
  assert.match(hook, /^pnpm install --frozen-lockfile$/m);
  assert.doesNotMatch(hook, /(?:drizzle-kit|db:push|db:migrate|--filter\s+db\s+push|psql|migrate\()/);
  assert.match(hook, /separate manual Council gate/);
  const dbConfig = readFileSync(new URL('lib/db/drizzle.config.ts',root),'utf8');
  assert.match(dbConfig, /stillhere-shared\/src\/schema\.ts/);
});

test("review workflow rejects production and has no application mode", () => {
  const script = fileURLToPath(new URL('scripts/review-15.10a-schema.mjs',root));
  const baseEnv = { ...process.env, DATABASE_URL: '', PGHOST: '', PGDATABASE: '' };
  for (const [args, env] of [[['--apply'], { ...baseEnv, NODE_ENV: 'development' }], [['--review'], { ...baseEnv, NODE_ENV: 'production' }], [['--review'], { ...baseEnv, NODE_ENV: 'development', DATABASE_URL: 'blocked-target' }]] as const) {
    const result = spawnSync(process.execPath, [script,...args], { env, encoding:'utf8' });
    assert.notEqual(result.status, 0);
  }
});
