ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "paused_until" timestamp;
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "paused_by" text;
ALTER TABLE "settings" ALTER COLUMN "auto_wellness_call" SET DEFAULT true;
UPDATE "settings" SET "auto_wellness_call" = true WHERE "auto_wellness_call" = false;
