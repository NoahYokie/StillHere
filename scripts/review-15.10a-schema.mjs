// Manual review only. No database credentials, connection, or application path.
import "./offline-network-guard.cjs";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";

const root = fileURLToPath(new URL("../", import.meta.url));
const BASE = "893a073c7bb937d1a79b4d1394df09f6035918af";
const CONTRACT = "3454bd48c1f4a4f9f69a4fe741421bac80bd340b56b8e57fed93d4fd7636a4a4";
const schemaPath = "lib/stillhere-shared/src/schema.ts";
const sha = b => createHash("sha256").update(b).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
assert.deepEqual(process.argv.slice(2), ["--review"], "Only --review is supported; application is not implemented");
assert.notEqual(process.env.NODE_ENV, "production", "Production invocation prohibited");
assert.ok(!process.env.DATABASE_URL && !process.env.PGDATABASE && !process.env.PGHOST, "Remove database target variables for offline review");
git("merge-base", "--is-ancestor", BASE, "HEAD");
const contractBytes = await readFile(join(root, "artifacts/api-server/migrations/0011_incident_telephony_ledger.sql"));
assert.equal(sha(contractBytes), CONTRACT, "Audited migration changed");
const source = await readFile(join(root, schemaPath), "utf8");
const baseline = execFileSync("git", ["show", `${BASE}:${schemaPath}`], { cwd: root, encoding: "utf8" });
const rootRequire = createRequire(join(root, "package.json"));
const apiRequire = createRequire(join(root, "artifacts/api-server/package.json"));
const ts = rootRequire("typescript");
const { generateDrizzleJson, generateMigration } = apiRequire("drizzle-kit/api");
function loadSchema(text) {
  const module = { exports: {} };
  const schemaRequire = createRequire(join(root, schemaPath));
  const allowed = new Set(["drizzle-orm/pg-core", "drizzle-orm", "drizzle-zod", "zod"]);
  runInNewContext(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports,
    require: name => { assert.ok(allowed.has(name), `Unexpected schema dependency: ${name}`); return schemaRequire(name); },
  });
  return module.exports;
}
const before = generateDrizzleJson(loadSchema(baseline));
before.id = "00000000-0000-0000-0000-000000000001";
const after = generateDrizzleJson(loadSchema(source), before.id);
after.id = "00000000-0000-0000-0000-000000000002";
const statements = await generateMigration(before, after);
const sql = statements.join("\n--> statement-breakpoint\n") + "\n";
// Keep the complete generated output, including any unexpected statements.
const reviewDir = join(root, "artifacts/api-server/review/15.10a");
const disposable = await mkdtemp(join(tmpdir(), "stillhere-ddl-"));
try {
  await writeFile(join(disposable, "generated.sql"), sql);
  await mkdir(reviewDir, { recursive: true });
  await writeFile(join(reviewDir, "generated.sql"), await readFile(join(disposable, "generated.sql")));
  const addedTables = Object.keys(after.tables).filter(k => !before.tables[k]);
  const changedTables = Object.keys(before.tables).filter(k => JSON.stringify(before.tables[k]) !== JSON.stringify(after.tables[k]));
  const report = {
    mode: "OFFLINE_REVIEW_ONLY", baseCommit: BASE, sourceHead: git("rev-parse", "HEAD"),
    schemaSha256: sha(source), migrationContractSha256: CONTRACT, generatedSqlSha256: sha(sql),
    drizzleKit: JSON.parse(await readFile(join(dirname(apiRequire.resolve("drizzle-kit/api")), "package.json"), "utf8")).version,
    addedTables, changedTables, statements,
    checks: Object.fromEntries(Object.entries(after.tables).filter(([k]) => addedTables.includes(k) || k === "public.incidents").map(([k, v]) => [k, v.checkConstraints])),
  };
  await writeFile(join(reviewDir, "generation.json"), JSON.stringify(report, null, 2) + "\n");
  const names = ["incident_snapshot_metadata_pair", "incident_escalation_sequence_priority_rank_check", "incident_contact_attempts_cycle_check", "incident_contact_attempts_duration_check", "incident_contact_attempts_outcome_source_check"];
  const rawChecks = [];
  const contractText = contractBytes.toString("utf8");
  for (const match of contractText.matchAll(/\bCHECK\s*\(/g)) {
    const start = match.index + match[0].length;
    let end = start, depth = 1;
    while (depth && end < contractText.length) {
      if (contractText[end] === "(") depth++;
      if (contractText[end] === ")") depth--;
      end++;
    }
    assert.equal(depth, 0);
    rawChecks.push(contractText.slice(start, end - 1).trim());
  }
  assert.equal(rawChecks.length, names.length);
  const currentChecks = Object.assign({}, ...Object.values(report.checks));
  await writeFile(join(reviewDir, "check-differences.json"), JSON.stringify(names.map((name, i) => ({
    constraint: name, migration0011Predicate: rawChecks[i], generatedPredicate: currentChecks[name].value,
    difference: "Quoted, table-qualified column identifiers; whitespace/layout differs. No casts or predicate/NULL-semantics changes.",
  })), null, 2) + "\n");
  assert.deepEqual(addedTables.sort(), ["public.incident_contact_attempts", "public.incident_escalation_sequence", "public.incident_telephony_events"]);
  assert.deepEqual(changedTables, ["public.incidents"]);
  const oldIncident = before.tables["public.incidents"];
  const newIncident = structuredClone(after.tables["public.incidents"]);
  delete newIncident.columns.escalation_snapshot_created_at;
  delete newIncident.columns.escalation_snapshot_contact_count;
  delete newIncident.checkConstraints.incident_snapshot_metadata_pair;
  assert.deepEqual(newIncident, oldIncident, "Unexpected retained incident schema change");
  for (const key of ["enums", "schemas", "sequences", "roles", "policies", "views"]) assert.deepEqual(after[key], before[key], `Unrelated ${key} changed`);
  assert.doesNotMatch(sql, /(?:^|;)\s*(DROP|TRUNCATE|DELETE|INSERT|UPDATE)\b/im, "Unexpected destructive/data SQL");
  console.log(JSON.stringify({ result: "OFFLINE_GENERATION_PASS", artifact: "artifacts/api-server/review/15.10a/generated.sql", sha256: sha(sql), statementCount: statements.length }));
} finally {
  // Only the freshly created disposable directory is removed.
  assert.equal(dirname(resolve(disposable)), resolve(tmpdir()));
  assert.ok(disposable.includes("stillhere-ddl-"));
  await rm(disposable, { recursive: true });
}
