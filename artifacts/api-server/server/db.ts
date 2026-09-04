import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

const poolMax = envInt("DB_POOL_MAX", 5, 1, 50);
const connectionTimeoutMillis = envInt("DB_POOL_CONNECTION_TIMEOUT_MS", 5_000, 1_000, 30_000);
const idleTimeoutMillis = envInt("DB_POOL_IDLE_TIMEOUT_MS", 30_000, 5_000, 300_000);
const statementTimeoutMillis = envInt("DB_STATEMENT_TIMEOUT_MS", 15_000, 1_000, 120_000);

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: poolMax,
  connectionTimeoutMillis,
  idleTimeoutMillis,
  statement_timeout: statementTimeoutMillis,
  query_timeout: statementTimeoutMillis,
});

pool.on("error", (error) => {
  console.error("[DB] Idle client error:", error?.message || error);
});

export const db = drizzle(pool, { schema });
