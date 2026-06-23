# Million-User Scale Runbook

## Current State

StillHere stores production data in Google Cloud SQL Postgres via `DATABASE_URL`.
The current production service is wired correctly, but the live resources are not
yet sized for a million-user launch:

- Cloud SQL instance: `stillhere-prod`
- Current database version: Postgres 16
- Current observed tier: `db-f1-micro`
- Current observed availability: zonal
- Current observed automated backups: disabled
- Cloud Run service: `stillhere-web`
- Current default deploy profile: `cloudbuild.yaml`
- High-scale deploy profile added in repo: `cloudbuild.scale.yaml`

Do not advertise million-user readiness until the steps below pass in staging and
then production.

## Required Database Changes

Apply the scale indexes before load testing:

```powershell
npm.cmd run db:push
```

Or apply the SQL migration directly:

```powershell
psql "$env:DATABASE_URL" -f migrations/0010_scale_indexes.sql
```

The migration adds indexes for the hottest paths:

- latest check-in lookup by user
- check-in due scheduler
- active incidents by user/status/reason
- auth session lookup and cleanup
- push subscription lookup
- active location session lookup
- heartbeat/safety-state sweeps

## Required Cloud SQL Baseline

Move production off `db-f1-micro` before any large traffic event.

Recommended launch baseline:

- Cloud SQL Enterprise Plus or Enterprise tier sized from load tests
- HA enabled
- automated backups enabled
- point-in-time recovery enabled
- SSD storage with automatic storage increase
- query insights enabled
- alerts for CPU, memory, disk, connections, replication lag, and errors

Example commands to prepare the existing instance:

```powershell
& 'C:\Users\dd124\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd' sql instances patch stillhere-prod `
  --project stillhere-492915 `
  --availability-type=REGIONAL `
  --backup-start-time=20:00 `
  --enable-bin-log `
  --storage-auto-increase
```

Choose the actual database tier from staged load-test results. Do not guess.

## Required Cloud Run Profile

Use the explicit scale profile only after Cloud SQL has been resized and tested:

```powershell
& 'C:\Users\dd124\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd' builds submit `
  --config cloudbuild.scale.yaml `
  --project stillhere-492915 `
  --substitutions=_REGION=australia-southeast1,_SERVICE=stillhere-web,_ARTIFACT_REPO=stillhere,_MIN_INSTANCES=5,_MAX_INSTANCES=250,_CONCURRENCY=80,_CPU=4,_MEMORY=4Gi,_DB_POOL_MAX=3
```

Why `_DB_POOL_MAX=3`: high Cloud Run instance counts can exhaust Postgres
connections. Keep app pools small until a dedicated connection-pooling layer is
introduced and tested.

## Required Load-Test Stages

Run against staging first. Do not run heavy tests against production contacts,
SMS, calls, or push tokens.

1. 1,000 active users for 30 minutes.
2. 10,000 active users for 60 minutes.
3. 100,000 registered users with realistic daily check-in distribution.
4. 1,000,000 registered users with realistic daily check-in distribution.
5. 8-hour soak with cron, check-in, location heartbeat, watcher status, SMS
   webhook, push, and report generation traffic.

Pass criteria:

- API p95 latency below 2 seconds for normal app actions.
- `/api/checkin` p95 below 1 second.
- cron tick finishes before the next scheduled tick.
- Cloud SQL connections below 80% of the available limit.
- no duplicate safety incidents for the same due occurrence.
- no duplicate SMS/call escalation for the same incident.
- error rate below 1%.

## Known Scale Limits To Address Next

- Split safety workers from the web service once traffic grows. Web request
  serving and cron/escalation processing should not compete for the same CPU
  budget at high scale.
- Add a tested connection-pooling layer before very high Cloud Run max instance
  counts.
- Move high-volume location history and telemetry to partitioned retention
  tables or a time-series/analytics store if location volume grows.
- Verify Twilio, APNs, FCM, Resend, and Stripe throughput limits separately.
  Application scaling cannot overcome provider account limits.
