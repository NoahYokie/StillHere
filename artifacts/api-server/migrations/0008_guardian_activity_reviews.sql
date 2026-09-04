ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS resolution_reason text;

CREATE TABLE IF NOT EXISTS guardian_activity_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid REFERENCES incidents(id) ON DELETE CASCADE,
  drill_id uuid REFERENCES incidents(id) ON DELETE CASCADE,
  subject_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guardian_contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  guardian_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  review_kind text NOT NULL DEFAULT 'incident',
  incident_level integer,
  incident_reason text,
  status text NOT NULL DEFAULT 'pending',
  counts_toward_badge boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  acknowledged_at timestamp,
  acknowledged_by_user_id uuid REFERENCES users(id),
  superseded_at timestamp,
  superseded_by_incident_id uuid REFERENCES incidents(id),
  metadata text,
  CONSTRAINT guardian_activity_reviews_one_owner_chk CHECK (
    (incident_id IS NOT NULL AND drill_id IS NULL)
    OR (incident_id IS NULL AND drill_id IS NOT NULL)
  ),
  CONSTRAINT guardian_activity_reviews_kind_chk CHECK (review_kind IN ('incident', 'drill')),
  CONSTRAINT guardian_activity_reviews_status_chk CHECK (status IN ('pending', 'acknowledged', 'superseded', 'cancelled')),
  CONSTRAINT guardian_activity_reviews_level_chk CHECK (incident_level IS NULL OR incident_level IN (1, 2, 3)),
  CONSTRAINT guardian_activity_reviews_drill_badge_chk CHECK (
    review_kind <> 'drill' OR counts_toward_badge = false
  )
);

CREATE INDEX IF NOT EXISTS guardian_activity_reviews_guardian_pending_idx
  ON guardian_activity_reviews(guardian_user_id, status, counts_toward_badge);

CREATE INDEX IF NOT EXISTS guardian_activity_reviews_subject_idx
  ON guardian_activity_reviews(subject_user_id);

CREATE INDEX IF NOT EXISTS guardian_activity_reviews_incident_idx
  ON guardian_activity_reviews(incident_id);

CREATE INDEX IF NOT EXISTS guardian_activity_reviews_drill_idx
  ON guardian_activity_reviews(drill_id);

CREATE UNIQUE INDEX IF NOT EXISTS guardian_activity_reviews_incident_contact_uq
  ON guardian_activity_reviews(incident_id, guardian_contact_id)
  WHERE incident_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS guardian_activity_reviews_incident_guardian_uq
  ON guardian_activity_reviews(incident_id, guardian_user_id)
  WHERE incident_id IS NOT NULL AND guardian_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS guardian_activity_reviews_drill_contact_uq
  ON guardian_activity_reviews(drill_id, guardian_contact_id)
  WHERE drill_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS guardian_activity_reviews_drill_guardian_uq
  ON guardian_activity_reviews(drill_id, guardian_user_id)
  WHERE drill_id IS NOT NULL AND guardian_user_id IS NOT NULL;

INSERT INTO guardian_activity_reviews (
  incident_id,
  subject_user_id,
  guardian_contact_id,
  guardian_user_id,
  review_kind,
  incident_level,
  incident_reason,
  status,
  counts_toward_badge,
  metadata
)
SELECT
  i.id,
  i.user_id,
  c.id,
  c.linked_user_id,
  'incident',
  CASE
    WHEN i.reason = 'sos' THEN 1
    WHEN i.reason = 'missed_checkin' THEN 3
    ELSE NULL
  END,
  i.reason::text,
  'pending',
  true,
  '{"source":"deployment_open_incident"}'
FROM incidents i
JOIN contacts c ON c.user_id = i.user_id
WHERE i.status <> 'resolved'
  AND i.is_drill = false
  AND c.linked_user_id IS NOT NULL
  AND c.watcher_consent_status = 'accepted'
  AND c.soft_deleted_at IS NULL
  AND (c.paused_until IS NULL OR c.paused_until <= now())
ON CONFLICT DO NOTHING;
