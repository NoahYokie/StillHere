ALTER TABLE "incidents"
  ADD COLUMN IF NOT EXISTS "processing_lock_id" text,
  ADD COLUMN IF NOT EXISTS "processing_locked_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "incidents_escalation_processing_lock_idx"
  ON "incidents" ("processing_lock_id", "processing_locked_at");
