ALTER TABLE "settings"
  ADD COLUMN IF NOT EXISTS "processing_lock_id" text,
  ADD COLUMN IF NOT EXISTS "processing_locked_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "settings_checkin_processing_lock_idx"
  ON "settings" ("processing_lock_id", "processing_locked_at");
