-- Structural only. No historical roster, metadata or attempt backfill.
ALTER TABLE incidents
  ADD COLUMN escalation_snapshot_created_at timestamptz,
  ADD COLUMN escalation_snapshot_contact_count integer,
  ADD CONSTRAINT incident_snapshot_metadata_pair CHECK (
    (escalation_snapshot_created_at IS NULL AND escalation_snapshot_contact_count IS NULL)
    OR (escalation_snapshot_created_at IS NOT NULL AND escalation_snapshot_contact_count IS NOT NULL AND escalation_snapshot_contact_count >= 0)
  );

CREATE TABLE incident_escalation_sequence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  priority_rank integer NOT NULL CHECK (priority_rank > 0),
  role text NOT NULL,
  display_name text NOT NULL,
  destination text NOT NULL,
  snapshot_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX incident_sequence_rank_unique ON incident_escalation_sequence(incident_id, priority_rank);
CREATE UNIQUE INDEX incident_sequence_contact_unique ON incident_escalation_sequence(incident_id, contact_id);

CREATE TABLE incident_contact_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  sequence_id uuid REFERENCES incident_escalation_sequence(id),
  cycle integer NOT NULL DEFAULT 1 CHECK (cycle = 1),
  channel text NOT NULL DEFAULT 'voice',
  state text NOT NULL DEFAULT 'reserved',
  parent_call_sid text,
  child_call_sid text,
  attempted_at timestamptz,
  answered_at timestamptz,
  completed_at timestamptz,
  duration integer CHECK (duration >= 0),
  outcome text,
  outcome_source text CHECK (outcome_source IN ('provider_authoritative','duration_inferred','system_inferred')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX incident_attempt_cycle_contact_unique ON incident_contact_attempts(incident_id, cycle, sequence_id, channel);
CREATE UNIQUE INDEX incident_attempt_child_sid_unique ON incident_contact_attempts(child_call_sid);
CREATE INDEX incident_attempt_parent_sid_idx ON incident_contact_attempts(parent_call_sid);

CREATE TABLE incident_telephony_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  attempt_id uuid REFERENCES incident_contact_attempts(id),
  provider text NOT NULL DEFAULT 'twilio',
  event_key text NOT NULL,
  event_type text NOT NULL,
  call_status text,
  dial_call_status text,
  dial_call_duration text,
  call_duration text,
  call_sid text,
  parent_call_sid text,
  dial_call_sid text,
  answered_by text,
  digits text,
  provider_timestamp text,
  sequence_number text,
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX incident_telephony_event_key_unique ON incident_telephony_events(event_key);
CREATE INDEX incident_telephony_event_attempt_idx ON incident_telephony_events(attempt_id, created_at);
