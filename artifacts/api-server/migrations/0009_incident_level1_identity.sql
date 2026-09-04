ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS incident_subtype text,
  ADD COLUMN IF NOT EXISTS incident_source text;

CREATE INDEX IF NOT EXISTS incidents_subtype_idx
  ON incidents(incident_subtype);

CREATE INDEX IF NOT EXISTS incidents_source_idx
  ON incidents(incident_source);
