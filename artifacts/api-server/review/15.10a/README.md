# Task 15.10A offline DDL review

Review-only evidence, never an application command or migration history.

Base: `893a073c7bb937d1a79b4d1394df09f6035918af`.
Audited behavioral reference: `b37ddf76181045cb0a22e11c5f4ae71a2a397a42`.
Migration 0011 SHA-256: `3454bd48c1f4a4f9f69a4fe741421bac80bd340b56b8e57fed93d4fd7636a4a4`.

From the repository root, manually run:

```sh
node scripts/review-15.10a-schema.mjs --review
```

The command refuses production mode and database target variables. It has no apply mode. It uses installed Drizzle Kit's `generateDrizzleJson` and `generateMigration` APIs, without loading either database-config file. The baseline schema is read from the locked Git commit and evaluated in memory. The canonical current schema is evaluated in memory. There is no second schema file or database introspection.

Generated SQL first goes into a fresh disposable directory, then is retained here for review. Existing migration history is never used as a generation output. All generated statements are preserved, including unexpected ones if a scope assertion fails. The schema fingerprint in generation.json binds the reviewed working-tree content; sourceHead records HEAD at generation time, before the delivery commit.

## Structural comparison

- Exactly two nullable, default-free incident metadata columns.
- Exactly three new tables: sequence (8 columns), attempts (16), events (19).
- Five CHECKs retain their predicates and nullable three-valued semantics. Exact original/generated expressions are retained in check-differences.json.
- Five foreign keys: three incident references cascade on deletion; sequence/attempt references retain NO ACTION. No live-contact FK is introduced.
- Seven explicit indexes: five unique and two ordinary. Three inline primary keys also remain.
- No partial unique index, data backfill, unrelated table change, DROP or destructive ALTER.

## Exact representation differences

1. All identifiers are double-quoted. CHECK column references are additionally table-qualified; no casts or predicate changes are generated. Snapshot CHECK whitespace is flattened. All five explicit CHECK names match the named or expected PostgreSQL-generated names in 0011.
2. `timestamptz` is rendered `timestamp with time zone`; `NOW()` becomes `now()`.
3. Primary-key columns include explicit `NOT NULL`. DEFAULT and NOT NULL clause ordering differs without changing semantics.
4. FKs are emitted as separate ALTER statements with explicit names, `public` referenced schema, and explicit ON UPDATE/ON DELETE NO ACTION where 0011 relies on defaults. Drizzle FK names differ from PostgreSQL's implicit names for 0011. The two formerly overlength names are explicitly hardened to Council-ratified `ica_sequence_id_ies_id_fk` and `ite_attempt_id_ica_id_fk` (25 and 24 ASCII bytes). No database was contacted to inspect stored names.
5. Indexes explicitly state USING btree. Names, uniqueness and column ordering agree with 0011.
6. CREATE statements precede incident-column additions. Incident columns and metadata CHECK are separate ALTER statements instead of one grouped ALTER. Statement-breakpoint comments and formatting differ.

18 statements total. `generated.sql` is not byte-identical to 0011; semantic/source parity is tested by schema-declarative.test.ts. SQL execution and PostgreSQL catalog verification are separate, unauthorized gates.

## Development application remains gated

The post-merge hook only installs dependencies and prints the manual gate. Both active Drizzle configuration entry points refer to the canonical schema. Existing manual mutation commands were not invoked. No migration audit table is added.

No safe target-bound development mutation command is implemented: independent target identity and Council application authorization remain prerequisites. This review command does not select a development or production target and cannot apply its output.

## Validation environment

Node 24.14.1, pnpm 10.10.0, installed Drizzle Kit 0.31.10, TypeScript 5.9.3. Locked dependencies installed with --frozen-lockfile --ignore-scripts; no manifest/lockfile changes. The monorepo excludes Windows esbuild binaries, so tests use ESBUILD_BINARY_PATH pointing to an isolated cached @esbuild/win32-x64 0.27.3 binary. Linux/Replit execution was not performed.

The offline-network-guard.cjs preload blocks database/provider/external connections. It permits only tsx parent IPC and HTTP loopback connections to servers created by the same test process (the existing guardian authorization harness). No database connection is permitted, including localhost PostgreSQL.
