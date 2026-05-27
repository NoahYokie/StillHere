ALTER TABLE "settings"
  ADD COLUMN IF NOT EXISTS "next_checkin_due_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "settings_next_checkin_due_at_idx"
  ON "settings" ("next_checkin_due_at");
