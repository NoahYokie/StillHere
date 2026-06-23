# Load Testing Runbook

## Goal

Prove capacity before advertising. Do not claim million-user readiness until
the full staged test plan passes and the production database has been resized
from the starter Cloud SQL tier.

## Stages

1. Smoke: 10 virtual users for 5 minutes.
2. Small: 100 virtual users for 15 minutes.
3. Medium: 1,000 virtual users for 30 minutes.
4. Large: 10,000 active users for 60 minutes.
5. Registered-user scale: 100,000 registered users with realistic check-in due distribution.
6. Million-user scale: 1,000,000 registered users with realistic check-in due distribution.
7. Launch rehearsal: realistic traffic shape based on expected advertising spend.
8. Soak: steady traffic for 8 hours.

## Scenarios to simulate

- Login code request rate.
- Authenticated `/api/status` polling.
- Manual check-in.
- Settings update.
- Safety Circle contact add and resend request.
- Public emergency link open.
- Missed check-in cron tick with many due users.
- SMS webhook replies: YES, NO, STOP.
- Wellness call status webhooks.
- Weekly report generation.

## Pass criteria

- Cloud Run 5xx below 1%.
- p95 API latency under 2 seconds for normal app actions.
- Cron tick completes before the next scheduled tick.
- No duplicate incident SMS/calls for the same incident.
- Cloud SQL connections below 80% of limit.
- Twilio delivery failure rate understood and not caused by app bugs.
- `/api/checkin` p95 below 1 second.
- no duplicate missed-check-in incidents for the same due occurrence.

## Do not run heavy tests against production users

Use a staging project or isolated test users. Heavy tests can trigger real SMS/calls and create cost.

Follow `docs/runbooks/million-user-scale.md` before running the 100,000 and
1,000,000 registered-user stages.
