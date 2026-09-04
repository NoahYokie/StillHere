UPDATE "settings"
SET "checkin_interval_hours" = 24,
    "updated_at" = now()
WHERE "checkin_interval_hours" < 24;

UPDATE "settings"
SET "checkin_interval_hours" = 168,
    "updated_at" = now()
WHERE "checkin_interval_hours" > 168;
