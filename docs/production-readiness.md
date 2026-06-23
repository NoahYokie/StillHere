# StillHere Production Readiness

This is the pre-testing hardening checklist for a real launch.

## Current hardening in code

- Cloud Run scales beyond one instance.
- Database pool is capped and has connection/query timeouts.
- Cloud Run shutdown closes the database pool cleanly.
- Safety cron endpoints use Postgres advisory locks so multiple instances do not process the same tick at the same time.
- Built-in cron can be disabled with `INTERNAL_CRON_ENABLED=false` for a future dedicated worker service.
- SMS and wellness calls have process-level Twilio concurrency limits.
- Outbound SMS, calls, push, and email have audit logging and hourly circuit-breaker settings.
- Check-in due processing uses persisted `settings.next_checkin_due_at` with an index.
- Scale-critical indexes for sessions, check-ins, incidents, push subscriptions,
  active location sessions, and safety-state sweeps are tracked in
  `migrations/0010_scale_indexes.sql`.
- A high-scale Cloud Run profile is available in `cloudbuild.scale.yaml`.

## Not proven until testing

- 1,000,000-user capacity.
- Twilio account throughput under real regional traffic.
- Cloud SQL sizing under real check-in, location, SMS reply, and watcher-link load.
- Dedicated worker-service separation for check-in cron, incident escalation,
  account-deletion cleanup, and reporting.
- Connection-pooling behavior under high Cloud Run instance counts.
- APNs/FCM production push delivery on signed iOS/Android builds.
- Restore time after a database failure.

## Required before advertising heavily

1. Run the backup restore drill in `docs/runbooks/backup-restore.md`.
2. Configure the alert policies in `docs/runbooks/monitoring-alerts.md`.
3. Confirm native push credentials in `docs/runbooks/native-push.md`.
4. Run staged load tests from `docs/runbooks/load-testing.md`.
5. Verify Twilio account throughput and compliance with the expected launch countries.
6. Complete `docs/runbooks/million-user-scale.md` before any million-user claim.
