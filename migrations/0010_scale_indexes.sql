CREATE INDEX IF NOT EXISTS users_safety_state_idx
  ON users(safety_state, safety_state_changed_at);

CREATE INDEX IF NOT EXISTS users_last_heartbeat_idx
  ON users(last_heartbeat_at);

CREATE INDEX IF NOT EXISTS checkins_user_created_idx
  ON checkins(user_id, created_at);

CREATE INDEX IF NOT EXISTS incidents_user_status_idx
  ON incidents(user_id, status);

CREATE INDEX IF NOT EXISTS incidents_user_reason_status_idx
  ON incidents(user_id, reason, status);

CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx
  ON auth_sessions(user_id);

CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx
  ON auth_sessions(expires_at);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx
  ON push_subscriptions(user_id);

CREATE INDEX IF NOT EXISTS push_subscriptions_endpoint_idx
  ON push_subscriptions(endpoint);

CREATE INDEX IF NOT EXISTS location_sessions_user_active_idx
  ON location_sessions(user_id, active);

CREATE INDEX IF NOT EXISTS location_sessions_incident_idx
  ON location_sessions(incident_id);

CREATE INDEX IF NOT EXISTS location_sessions_expires_at_idx
  ON location_sessions(expires_at);
